#!/usr/bin/env node
// tldr-shrink — MCP middleware that proxies an upstream MCP server and
// compresses prose fields so the model sees fewer tokens.
//
// Usage:
//   tldr-shrink <upstream-command> [...args]
//
// Example wrapping the filesystem MCP server:
//   "mcpServers": {
//     "fs-shrunk": {
//       "command": "npx",
//       "args": ["tldr-shrink", "npx", "@modelcontextprotocol/server-filesystem", "/some/path"]
//     }
//   }
//
// Compression is applied to:
//   - "description" fields in tools/list, prompts/list, resources/list responses
//   - same boundaries as tldr-compress: code, URLs, paths, identifiers preserved
//
// What we deliberately DON'T touch in v1:
//   - tools/call response content (high risk of breaking downstream parsing)
//   - request payloads going TO the upstream server
//
// Configuration (env vars):
//   TLDR_SHRINK_FIELDS   comma-separated extra field names to compress
//                           (default: description)
//   TLDR_SHRINK_DEBUG=1  log compression deltas to stderr

const { spawn } = require('child_process');
const { compressDescriptionsInPlace, compress } = require('./compress');

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write('tldr-shrink: missing upstream command.\n');
  process.stderr.write('Usage: tldr-shrink <upstream-command> [...args]\n');
  process.exit(2);
}

const debug = process.env.TLDR_SHRINK_DEBUG === '1';
const fields = (process.env.TLDR_SHRINK_FIELDS || 'description')
  .split(',').map(s => s.trim()).filter(Boolean);

// The header contract promises we only ever rewrite descriptions on
// list-style responses — tools/call results (and everything else) must pass
// through byte-identical. Detecting by response shape is unsafe: a tools/call
// result can legitimately carry a nested `description`. So we correlate: watch
// the client→upstream request stream, remember which id asked for a list
// method, and only compress the response whose id we recorded.
const LIST_METHODS = new Set([
  'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list',
]);
const idToMethod = new Map();

// shell:true on Windows so npx/.cmd shims resolve; never elsewhere (injection).
const upstream = spawn(args[0], args.slice(1), {
  stdio: ['pipe', 'pipe', 'inherit'],
  shell: process.platform === 'win32',
  windowsHide: true,
});

upstream.on('error', err => {
  process.stderr.write(`tldr-shrink: failed to spawn upstream: ${err.message}\n`);
  process.exit(1);
});

upstream.on('exit', (code, signal) => {
  if (signal) process.exit(128 + (signal === 'SIGTERM' ? 15 : 9));
  process.exit(code || 0);
});

// JSON-RPC framing over stdio: messages are separated by newlines (the
// MCP stdio transport uses LSP-like content but most servers emit one JSON
// object per line). We line-buffer in both directions and parse opportunistically.
function makeLineBuffer(onLine) {
  let buf = '';
  return chunk => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  };
}

function transformResponse(msg) {
  // Only compress descriptions on responses correlated to a list request.
  if (!msg || !msg.result || typeof msg.result !== 'object') return msg;
  if (msg.id === undefined || msg.id === null) return msg; // notification / no id
  const method = idToMethod.get(msg.id);
  idToMethod.delete(msg.id); // one response per request id
  if (!method || !LIST_METHODS.has(method)) return msg; // uncorrelated / tools-call etc.
  const r = msg.result;
  let compressedSomething = false;

  for (const arrayName of ['tools', 'prompts', 'resources', 'resourceTemplates']) {
    if (Array.isArray(r[arrayName])) {
      for (const item of r[arrayName]) {
        // A crafted/buggy upstream can put null or a non-object in the array;
        // dereferencing item[field] on null throws and would crash the proxy.
        if (!item || typeof item !== 'object') continue;
        for (const field of fields) {
          if (typeof item[field] === 'string') {
            const before = item[field];
            const out = compress(before).compressed;
            if (out !== before) {
              item[field] = out;
              compressedSomething = true;
              if (debug) {
                process.stderr.write(
                  `[tldr-shrink] ${arrayName}.${item.name || '?'}.${field}: ` +
                  `${before.length}→${out.length} bytes\n`
                );
              }
            }
          }
        }
      }
    }
  }

  // Some servers stuff descriptions in nested schemas. Only walk if nothing
  // matched at the top level; avoids double-processing a tool's nested params.
  if (!compressedSomething) compressDescriptionsInPlace(r, fields);

  return msg;
}

// Upstream → us → client (model). Transform here.
upstream.stdout.on('data', makeLineBuffer(line => {
  let msg;
  try { msg = JSON.parse(line); } catch {
    // Pass through unparseable lines unchanged.
    process.stdout.write(line + '\n');
    return;
  }
  // Fail open: if transformResponse throws on a pathological frame, forward the
  // original line unchanged rather than crashing the proxy and tearing down the
  // whole MCP connection.
  let out;
  try { out = JSON.stringify(transformResponse(msg)) + '\n'; }
  catch { out = line + '\n'; }
  process.stdout.write(out);
}));

// Client → us → upstream. Bytes are forwarded unchanged (exact framing
// preserved); a parallel line buffer only observes them to record which id
// asked for a list method, so transformResponse knows what it may compress.
const recordRequestMethods = makeLineBuffer(line => {
  let req;
  try { req = JSON.parse(line); } catch { return; } // non-JSON: nothing to record
  if (req && req.id !== undefined && req.id !== null &&
      typeof req.method === 'string' && LIST_METHODS.has(req.method)) {
    idToMethod.set(req.id, req.method);
  }
});

process.stdin.on('data', chunk => {
  recordRequestMethods(chunk); // observe only
  upstream.stdin.write(chunk); // forward verbatim
});
process.stdin.on('end',  () => upstream.stdin.end());
