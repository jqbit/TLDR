// Unit tests for bin/lib/settings.js — the JSONC-tolerant settings helper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SETTINGS = require('../../bin/lib/settings.js');

function tmpFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-settings-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

test('stripJsonComments strips // line comments', () => {
  const out = SETTINGS.stripJsonComments('{"a":1}// trail');
  assert.equal(out.trim(), '{"a":1}');
});

test('stripJsonComments strips /* block */ comments', () => {
  const out = SETTINGS.stripJsonComments('{/* leading */"a":1/* mid */, "b":2}');
  assert.match(out, /"a":1/);
  assert.match(out, /"b":2/);
  assert.doesNotMatch(out, /leading/);
});

test('stripJsonComments leaves comment-looking sequences inside strings alone', () => {
  const out = SETTINGS.stripJsonComments('{"url":"http://example.com//path"}');
  assert.equal(out, '{"url":"http://example.com//path"}');
});

test('stripJsonComments strips trailing commas', () => {
  const out = SETTINGS.stripJsonComments('{"a":[1,2,3,],}');
  assert.doesNotThrow(() => JSON.parse(out));
});

test('stripJsonComments preserves ,} / ,] inside string VALUES (no data corruption)', () => {
  // A string value whose content is a comma before }/] must survive — the old
  // global trailing-comma regex silently deleted those commas and wrote the
  // corrupted value back to the user's settings.json.
  const src = '{"note":"TODO: fix,}","cmd":"grep [a,]","arr":[1,2,],}';
  const parsed = JSON.parse(SETTINGS.stripJsonComments(src));
  assert.equal(parsed.note, 'TODO: fix,}');   // comma preserved inside the string
  assert.equal(parsed.cmd, 'grep [a,]');       // comma preserved inside the string
  assert.deepEqual(parsed.arr, [1, 2]);        // structural trailing comma removed
});

test('readSettings handles plain JSON', () => {
  const p = tmpFile('s.json', '{"theme":"dark"}');
  assert.deepEqual(SETTINGS.readSettings(p), { theme: 'dark' });
});

test('readSettings handles JSONC (comments + trailing commas)', () => {
  const p = tmpFile('s.json', `// my settings
{
  "theme": "dark", /* mode */
  "hooks": {},
}`);
  assert.deepEqual(SETTINGS.readSettings(p), { theme: 'dark', hooks: {} });
});

test('readSettings returns {} for missing file', () => {
  assert.deepEqual(SETTINGS.readSettings('/nonexistent/path/xyz.json'), {});
});

test('readSettings returns null for unrecoverable garbage', () => {
  const p = tmpFile('s.json', 'this is not json at all {{{');
  assert.equal(SETTINGS.readSettings(p), null);
});

test('writeSettings round-trips with newline', () => {
  const p = tmpFile('s.json', '');
  SETTINGS.writeSettings(p, { a: 1 });
  const raw = fs.readFileSync(p, 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(raw), { a: 1 });
});

test('validateHookFields drops malformed command hook (missing command)', () => {
  const s = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command' }, { type: 'command', command: 'good' }] }],
    },
  };
  SETTINGS.validateHookFields(s);
  assert.equal(s.hooks.SessionStart[0].hooks.length, 1);
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, 'good');
});

test('validateHookFields drops malformed agent hook (missing prompt)', () => {
  const s = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'agent' }] }],
    },
  };
  SETTINGS.validateHookFields(s);
  assert.equal(s.hooks, undefined);
});

test('validateHookFields drops empty events and empty hooks parent', () => {
  const s = { hooks: { SessionStart: [], UserPromptSubmit: [{ hooks: [] }] } };
  SETTINGS.validateHookFields(s);
  assert.equal(s.hooks, undefined);
});

test('addCommandHook is idempotent on substring marker', () => {
  const s = {};
  const a = SETTINGS.addCommandHook(s, 'SessionStart', { command: '/abs/path/tldr-activate.js', marker: 'tldr-activate' });
  const b = SETTINGS.addCommandHook(s, 'SessionStart', { command: '/different/abs/path/tldr-activate.js', marker: 'tldr-activate' });
  assert.equal(a, true);
  assert.equal(b, false);
  assert.equal(s.hooks.SessionStart.length, 1);
});

test('hasTldrHook detects via substring', () => {
  const s = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node /x/tldr-activate.js' }] }] } };
  assert.equal(SETTINGS.hasTldrHook(s, 'SessionStart', 'tldr-activate'), true);
  assert.equal(SETTINGS.hasTldrHook(s, 'SessionStart', 'gsd'), false);
  assert.equal(SETTINGS.hasTldrHook(s, 'UserPromptSubmit'), false);
});

test('removeTldrHooks tolerates malformed hook event values without throwing', () => {
  // Pre-fix bug: settings.hooks.SessionStart = "oops" (string, not array)
  // would crash on .filter(...) inside the filter loop. Fix delegates to
  // validateHookFields first + adds Array.isArray guard.
  const s = { hooks: { SessionStart: "oops", UserPromptSubmit: { not: 'an array either' } } };
  let removed;
  assert.doesNotThrow(() => { removed = SETTINGS.removeTldrHooks(s, 'tldr'); });
  assert.equal(removed, 0);
  assert.equal(s.hooks, undefined);
});

test('removeTldrHooks strips by marker and cleans empties', () => {
  const s = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'tldr-x' }] },
        { hooks: [{ type: 'command', command: 'other' }] },
      ],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'tldr-y' }] }],
    },
  };
  const removed = SETTINGS.removeTldrHooks(s, 'tldr');
  assert.equal(removed, 2);
  assert.equal(s.hooks.SessionStart.length, 1);
  assert.equal(s.hooks.UserPromptSubmit, undefined);
});

test('rewriteLegacyManagedHookCommands rewrites bare-node managed scripts', () => {
  const s = {
    hooks: {
      SessionStart: [{ hooks: [
        { type: 'command', command: 'node /abs/hooks/tldr-activate.js' },
        { type: 'command', command: 'node /abs/hooks/some-user-hook.js' },
      ] }],
    },
  };
  const n = SETTINGS.rewriteLegacyManagedHookCommands(s, '/usr/local/bin/node');
  assert.equal(n, 1);
  assert.match(s.hooks.SessionStart[0].hooks[0].command, /"\/usr\/local\/bin\/node" "\/abs\/hooks\/tldr-activate\.js"/);
  assert.equal(s.hooks.SessionStart[0].hooks[1].command, 'node /abs/hooks/some-user-hook.js');
});

test('rewriteLegacyManagedHookCommands ignores already-absolute node commands', () => {
  const s = {
    hooks: {
      SessionStart: [{ hooks: [
        { type: 'command', command: '"/usr/local/bin/node" "/abs/hooks/tldr-activate.js"' },
      ] }],
    },
  };
  const n = SETTINGS.rewriteLegacyManagedHookCommands(s, '/somewhere/else/node');
  assert.equal(n, 0);
});

test('FIX4: addCommandHook returns false (no throw) on a non-plain-object root', () => {
  for (const bad of ['just a string', 42, [1, 2, 3], null]) {
    let out;
    assert.doesNotThrow(() => { out = SETTINGS.addCommandHook(bad, 'SessionStart', { command: 'x', marker: 'tldr' }); },
      `addCommandHook threw on ${JSON.stringify(bad)}`);
    assert.equal(out, false);
  }
});

test('FIX4: addCommandHook coerces a non-array hooks map before pushing', () => {
  const s = { hooks: 'oops' };            // pre-fix: settings.hooks[event]=[] threw
  let out;
  assert.doesNotThrow(() => { out = SETTINGS.addCommandHook(s, 'SessionStart', { command: 'c', marker: 'tldr' }); });
  assert.equal(out, true);
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, 'c');
});

test('FIX4: validateHookFields tolerates array / primitive roots without throwing', () => {
  for (const bad of [[1, 2, 3], 'str', 7]) {
    assert.doesNotThrow(() => SETTINGS.validateHookFields(bad), `validateHookFields threw on ${JSON.stringify(bad)}`);
  }
});

test('FIX4: rewriteLegacyManagedHookCommands tolerates a non-array hooks[event]', () => {
  const s = { hooks: { SessionStart: 'not-an-array' } };  // pre-fix: for..of threw
  let n;
  assert.doesNotThrow(() => { n = SETTINGS.rewriteLegacyManagedHookCommands(s, '/usr/bin/node'); });
  assert.equal(n, 0);
});

test('FIX4: rewriteLegacyManagedHookCommands returns 0 on non-object roots', () => {
  for (const bad of ['str', 9, [1], null]) {
    assert.doesNotThrow(() => SETTINGS.rewriteLegacyManagedHookCommands(bad, '/usr/bin/node'));
    assert.equal(SETTINGS.rewriteLegacyManagedHookCommands(bad, '/usr/bin/node'), 0);
  }
});

// ── FIX5: a leading UTF-8 BOM must not make valid JSON "unparseable" ─────────
test('FIX5: readSettings parses a BOM-prefixed valid settings.json', () => {
  const p = tmpFile('s.json', '﻿{"theme":"dark","hooks":{}}');
  assert.deepEqual(SETTINGS.readSettings(p), { theme: 'dark', hooks: {} });
});

test('FIX5: readSettings parses a BOM-prefixed JSONC settings.json', () => {
  const p = tmpFile('s.json', '﻿{ "theme": "dark", /* c */ }');
  assert.deepEqual(SETTINGS.readSettings(p), { theme: 'dark' });
});

test('FIX5: stripJsonComments strips a leading BOM', () => {
  const out = SETTINGS.stripJsonComments('﻿{"a":1}');
  assert.doesNotThrow(() => JSON.parse(out));
  assert.deepEqual(JSON.parse(out), { a: 1 });
});
