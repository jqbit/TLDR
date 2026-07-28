import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const extUrl = new URL('../../src/plugins/tldr-pi/index.js', import.meta.url).href;

// Minimal stand-in for Pi's ExtensionAPI: record what the extension registers.
function load(ext) {
  const reg = { on: {}, cmds: {} };
  ext({ registerCommand: (n, o) => { reg.cmds[n] = o; }, on: (e, h) => { reg.on[e] = h; } });
  return reg;
}

test('registers the /tldr command and the three events it needs', async () => {
  const { default: ext } = await import(extUrl);
  const reg = load(ext);
  assert.deepEqual(Object.keys(reg.cmds), ['tldr']);
  for (const ev of ['input', 'session_start', 'before_agent_start']) {
    assert.equal(typeof reg.on[ev], 'function', `missing handler: ${ev}`);
  }
});

test('before_agent_start appends the ruleset without clobbering the base prompt', async () => {
  const { default: ext } = await import(extUrl);
  const reg = load(ext);
  const out = await reg.on.before_agent_start({ systemPrompt: 'BASE PROMPT' });
  assert.ok(out.systemPrompt.startsWith('BASE PROMPT'), 'base prompt preserved');
  assert.match(out.systemPrompt, /TLDR MODE ACTIVE/);
});

test('a missing/empty systemPrompt does not yield the literal "undefined"', async () => {
  const { default: ext } = await import(extUrl);
  const reg = load(ext);
  const out = await reg.on.before_agent_start({});
  assert.ok(!out.systemPrompt.includes('undefined'));
  assert.match(out.systemPrompt, /^TLDR MODE ACTIVE/);
});

test('/tldr <level> switches the injected intensity', async () => {
  const { default: ext } = await import(extUrl);
  const reg = load(ext);
  await reg.cmds.tldr.handler('ultra', { ui: { notify() {} } });
  const out = await reg.on.before_agent_start({ systemPrompt: '' });
  assert.match(out.systemPrompt, /\*\*ultra\*\*/, 'ultra row kept');
  assert.ok(!/\|\s*\*\*lite\*\*\s*\|/.test(out.systemPrompt), 'other levels filtered out');
});

test('an unknown mode is rejected and leaves the active mode alone', async () => {
  const { default: ext } = await import(extUrl);
  const reg = load(ext);
  const notes = [];
  await reg.cmds.tldr.handler('bogus', { ui: { notify: (m, lvl) => notes.push([m, lvl]) } });
  assert.match(notes[0][0], /unknown mode/);
  assert.equal(notes[0][1], 'error');
  const out = await reg.on.before_agent_start({ systemPrompt: '' });
  assert.match(out.systemPrompt, /TLDR MODE ACTIVE/, 'still active after a bad arg');
});

test('"stop tldr" suppresses injection entirely', async () => {
  const { default: ext } = await import(extUrl);
  const reg = load(ext);
  await reg.on.input({ text: 'stop tldr' });
  assert.equal(await reg.on.before_agent_start({ systemPrompt: 'X' }), undefined);
});

test('extension-sourced input never triggers deactivation (no feedback loop)', async () => {
  const { default: ext } = await import(extUrl);
  const reg = load(ext);
  await reg.on.input({ text: 'stop tldr', source: 'extension' });
  const out = await reg.on.before_agent_start({ systemPrompt: '' });
  assert.match(out.systemPrompt, /TLDR MODE ACTIVE/);
});
