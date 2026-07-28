#!/usr/bin/env node
// Tests for src/mcp-servers/tldr-shrink/compress.js — pure-Node prose compressor.
// Run: node tests/test_mcp_shrink.js

const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { compress, compressDescriptionsInPlace } = require(
  path.join(ROOT, 'src', 'mcp-servers', 'tldr-shrink', 'compress.js')
);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

console.log('mcp-shrink compress tests\n');

test('drops articles', () => {
  const { compressed } = compress('The user is the owner of an account');
  assert.match(compressed, /User is owner of account/i);
  // No leftover lone "the" / "an" / "a"
  assert.doesNotMatch(compressed, /\bthe\b/i);
  assert.doesNotMatch(compressed, /\ban\b/i);
});

test('drops filler and pleasantries', () => {
  const { compressed } = compress('Sure, this just basically returns the value');
  assert.doesNotMatch(compressed, /sure/i);
  assert.doesNotMatch(compressed, /just/i);
  assert.doesNotMatch(compressed, /basically/i);
});

test('drops hedging and "I will" leaders', () => {
  const { compressed } = compress('I will perhaps connect to the database');
  assert.doesNotMatch(compressed, /perhaps/i);
  assert.doesNotMatch(compressed, /^I will/i);
  assert.match(compressed, /database/i);
});

test('preserves fenced code blocks verbatim', () => {
  const input = 'Run the example: ```\nthe just sure return 1;\n``` and also more text';
  const { compressed } = compress(input);
  // Inside the fence, "the just sure" must survive untouched.
  assert.match(compressed, /```\nthe just sure return 1;\n```/);
});

test('preserves inline code verbatim', () => {
  const input = 'Use `the just basically API` for fetching';
  const { compressed } = compress(input);
  assert.match(compressed, /`the just basically API`/);
});

test('preserves URLs verbatim', () => {
  const input = 'See the docs at https://example.com/the/just/api';
  const { compressed } = compress(input);
  assert.match(compressed, /https:\/\/example\.com\/the\/just\/api/);
});

test('preserves filesystem paths verbatim', () => {
  const input = 'Read just the file at /tmp/the/just/file.txt';
  const { compressed } = compress(input);
  assert.match(compressed, /\/tmp\/the\/just\/file\.txt/);
});

test('preserves identifiers in CONST_CASE / dotted form', () => {
  const input = 'Set the API_KEY_VALUE on the just config.api.endpoint()';
  const { compressed } = compress(input);
  assert.match(compressed, /API_KEY_VALUE/);
  assert.match(compressed, /config\.api\.endpoint\(\)/);
});

test('compresses real MCP-style description', () => {
  const input = 'Get the current weather for a given location. ' +
    'Returns the temperature in Fahrenheit. ' +
    'Please make sure to provide the location as a city name.';
  const { compressed, before, after } = compress(input);
  assert.ok(after < before, `expected size reduction, got ${before}→${after}`);
  // ~30% reduction is the floor; descriptions like this should compress well.
  assert.ok((before - after) / before > 0.15, `wanted >15% savings, got ${(before - after) / before}`);
  // Substance preserved
  assert.match(compressed, /weather/i);
  assert.match(compressed, /Fahrenheit/i);
  assert.match(compressed, /city name/i);
});

test('restores nested protected segments without leaking a raw sentinel', () => {
  // An inline-code segment gets spliced inside a function-call segment, so the
  // outer segment's stored text itself contains the inner sentinel. A single
  // restore pass would re-emit that inner \x00N\x00 as literal text.
  for (const input of [
    'run format(`the value`) now',
    'access STARTER/BUSINESS via type(0)',
  ]) {
    const { compressed } = compress(input);
    assert.doesNotMatch(compressed, /\x00\d+\x00/,
      `raw sentinel leaked for ${JSON.stringify(input)}: ${JSON.stringify(compressed)}`);
    assert.doesNotMatch(compressed, /\x00/,
      `bare NUL leaked for ${JSON.stringify(input)}: ${JSON.stringify(compressed)}`);
  }
  // Inner protected token is fully restored, not truncated.
  assert.match(compress('run format(`the value`) now').compressed, /`the value`/);
  const two = compress('access STARTER/BUSINESS via type(0)').compressed;
  assert.match(two, /STARTER\/BUSINESS/);
  assert.match(two, /type\(0\)/);
});

test('handles empty / null input gracefully', () => {
  assert.deepStrictEqual(compress(''), { compressed: '', before: 0, after: 0 });
  const r = compress(null);
  assert.strictEqual(r.compressed, null);
});

test('compressDescriptionsInPlace walks nested tools/list response', () => {
  const payload = {
    result: {
      tools: [
        { name: 'get_weather', description: 'The function returns the current weather for a city.' },
        { name: 'send_email', description: 'Sends an email to a given recipient.' },
      ]
    }
  };
  compressDescriptionsInPlace(payload.result, ['description']);
  assert.ok(!payload.result.tools[0].description.match(/\bthe\b/i),
    `expected 'the' stripped, got: ${payload.result.tools[0].description}`);
  assert.match(payload.result.tools[0].description, /weather/i);
  assert.match(payload.result.tools[1].description, /email/i);
});

test('compressDescriptionsInPlace skips non-string description fields', () => {
  const obj = { description: { not: 'a string' }, name: 'x' };
  // Should not throw.
  compressDescriptionsInPlace(obj, ['description']);
  assert.deepStrictEqual(obj.description, { not: 'a string' });
});

// --- Integration: the proxy only compresses correlated list responses ---

async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

// Mock upstream MCP server: replies to each request with a result carrying a
// nested `description`. tools/list gets a tools[] array (the proxy may
// compress it); anything else models a tools/call (must pass through).
const MOCK_UPSTREAM = `
let buf = '';
process.stdin.on('data', d => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let req; try { req = JSON.parse(line); } catch { continue; }
    const result = req.method === 'tools/list'
      ? { tools: [{ name: 'x', description: 'The function returns the current weather for a city.' }] }
      : { content: [{ type: 'text', text: 'ok' }], description: 'The nested description stays.' };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
  }
});
`;

function driveProxy(requests, wantIds, timeoutMs = 4000) {
  const index = path.join(ROOT, 'src', 'mcp-servers', 'tldr-shrink', 'index.js');
  const proc = spawn('node', [index, 'node', '-e', MOCK_UPSTREAM],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let buf = '';
    const frames = [];
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      clearTimeout(timer);
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(frames);
    }
    proc.on('error', reject);
    proc.stdout.on('data', d => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) { try { frames.push(JSON.parse(line)); } catch { /* skip */ } }
      }
      if (wantIds.every(id => frames.some(f => f.id === id))) finish();
    });
    for (const r of requests) proc.stdin.write(JSON.stringify(r) + '\n');
  });
}

(async () => {
  await atest('proxy compresses tools/list result but leaves tools/call result untouched', async () => {
    const frames = await driveProxy([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } },
    ], [1, 2]);
    const list = frames.find(f => f.id === 1);
    const call = frames.find(f => f.id === 2);
    assert.ok(list, 'no tools/list response received');
    assert.ok(call, 'no tools/call response received');
    // list description IS compressed (article "the/The" stripped).
    assert.doesNotMatch(list.result.tools[0].description, /\bthe\b/i,
      `tools/list description not compressed: ${list.result.tools[0].description}`);
    // tools/call nested description passes through byte-identical.
    assert.strictEqual(call.result.description, 'The nested description stays.');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
