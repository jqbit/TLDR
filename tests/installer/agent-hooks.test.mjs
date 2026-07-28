import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const H = require(path.join(root, 'bin', 'lib', 'agent-hooks.js'));

const ACT = 'node "/h/tldr-activate.js"';
const TRK = 'node "/h/tldr-mode-tracker.js"';

test('codex/grok: preserves a foreign hook while adding ours', () => {
  const existing = {
    hooks: {
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node /other/tool.mjs' }] }],
    },
  };
  const out = H.buildClaudeStyle(existing, ACT, TRK);
  assert.deepEqual(out.hooks.PostToolUse, existing.hooks.PostToolUse, 'foreign hook untouched');
  assert.equal(out.hooks.SessionStart[0].hooks[0].command, ACT);
  assert.equal(out.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
  assert.equal(out.hooks.UserPromptSubmit[0].hooks[0].command, TRK);
});

test('codex/grok: re-running does not duplicate our entries', () => {
  let cfg = H.buildClaudeStyle({}, ACT, TRK);
  cfg = H.buildClaudeStyle(cfg, ACT, TRK);
  cfg = H.buildClaudeStyle(cfg, ACT, TRK);
  assert.equal(cfg.hooks.SessionStart.length, 1);
  assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
});

test('codex/grok: a foreign handler sharing an event survives', () => {
  const existing = {
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node /other/init.js' }] }] },
  };
  const out = H.buildClaudeStyle(existing, ACT, TRK);
  const cmds = out.hooks.SessionStart.flatMap(g => g.hooks.map(h => h.command));
  assert.ok(cmds.includes('node /other/init.js'), 'foreign SessionStart kept');
  assert.ok(cmds.includes(ACT), 'ours added');
});

test('cursor: sets version 1 and preserves preToolUse', () => {
  const existing = { version: 1, hooks: { preToolUse: [{ command: 'node /other/pre.mjs', timeout: 5 }] } };
  const out = H.buildCursorStyle(existing, ACT);
  assert.equal(out.version, 1);
  assert.deepEqual(out.hooks.preToolUse, existing.hooks.preToolUse);
  assert.equal(out.hooks.sessionStart[0].command, ACT);
});

test('cursor: idempotent across repeated installs', () => {
  let cfg = H.buildCursorStyle({}, ACT);
  cfg = H.buildCursorStyle(cfg, ACT);
  assert.equal(cfg.hooks.sessionStart.length, 1);
});

test('antigravity: namespaced block, foreign blocks untouched', () => {
  const existing = { 'other-tool': { PreToolUse: [{ matcher: 'run_command', hooks: [] }] } };
  const out = H.buildAntigravityStyle(existing, ACT);
  assert.deepEqual(out['other-tool'], existing['other-tool']);
  assert.equal(out.tldr.PreInvocation[0].command, ACT);
  const again = H.buildAntigravityStyle(out, ACT);
  assert.equal(again.tldr.PreInvocation.length, 1);
});

test('isOurs only matches TLDR hook scripts', () => {
  assert.ok(H.isOurs('node /x/tldr-activate.js'));
  assert.ok(H.isOurs('node /x/tldr-mode-tracker.js'));
  assert.ok(!H.isOurs('node /x/other.js'));
  assert.ok(!H.isOurs(undefined));
});
