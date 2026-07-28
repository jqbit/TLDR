// TLDR — JSONC-tolerant settings.json read/write + defensive hook validation.
//
// Lifted in spirit from gsd-build/get-shit-done's stripJsonComments + readSettings.
// Reused by bin/install.js and (optionally) by hooks/tldr-activate.js so a
// commented settings.json no longer crashes the installer or the runtime hooks.
//
// Public API:
//   readSettings(path)             → object, {}, or null on hard parse failure
//   writeSettings(path, obj)       → atomic write with newline
//   stripJsonComments(src)         → string with // and /* */ stripped (string-aware)
//   validateHookFields(settings)   → mutates: drops malformed hook entries
//   hasTldrHook(settings, ev)    → idempotency probe
//   addCommandHook(settings, ev, opts) → no-op if substring marker already present
//   removeTldrHooks(settings)    → uninstall helper
//
// Pure stdlib, CommonJS, Node ≥14.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWrite } = require('./safe-fs');

// A plain, non-array object. Guards every mutation helper below so a
// settings.json whose root (or `hooks`) is a bare string/number/array never
// throws a TypeError that would abort the whole installer run.
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ── stripJsonComments ──────────────────────────────────────────────────────
// Hand-rolled state machine. Tracks string state + backslash escape so a
// comment-looking sequence inside a quoted string is left alone. Removes
// trailing commas in a final pass — JSONC tolerates those, JSON.parse does not.
function stripJsonComments(src) {
  if (typeof src !== 'string') return src;
  // Strip a leading UTF-8 BOM (U+FEFF) — JSON.parse rejects it, but an editor
  // may have written one into a perfectly valid settings.json.
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
  let out = '';
  let i = 0;
  const n = src.length;
  let inString = false;
  let stringChar = '';
  let inLine = false;
  let inBlock = false;
  while (i < n) {
    const c = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      i++; continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i += 2; continue; }
      i++; continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') { if (i + 1 < n) { out += src[i + 1]; i += 2; continue; } }
      if (c === stringChar) { inString = false; }
      i++; continue;
    }
    if (c === '"' || c === "'") { inString = true; stringChar = c; out += c; i++; continue; }
    if (c === '/' && next === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && next === '*') { inBlock = true; i += 2; continue; }
    out += c; i++;
  }
  // Trailing-comma sweep — string-aware. A plain regex over `out` would also
  // match commas inside string VALUES (e.g. "TODO: fix,}"), silently corrupting
  // user data that is then written back to disk. Walk char-by-char instead.
  return stripTrailingCommas(out);
}

// Remove commas that sit (across whitespace) immediately before a closing } or
// ], but only OUTSIDE string literals. Comments are already gone by this point.
function stripTrailingCommas(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  let inString = false;
  let q = '';
  while (i < n) {
    const c = s[i];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < n) { out += s[i + 1]; i += 2; continue; }
      if (c === q) inString = false;
      i++; continue;
    }
    if (c === '"' || c === "'") { inString = true; q = c; out += c; i++; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(s[j])) j++;
      if (j < n && (s[j] === '}' || s[j] === ']')) { i++; continue; } // drop trailing comma
      out += c; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

// ── readSettings ───────────────────────────────────────────────────────────
// Try strict JSON first (fast path). On failure, strip comments and retry.
// On total failure return `null` and warn — never silently overwrite a
// malformed-but-recoverable file with `{}`.
function readSettings(p) {
  if (!fs.existsSync(p)) return {};
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) {
    process.stderr.write(`tldr: cannot read ${p}: ${e.message}\n`);
    return null;
  }
  if (!raw.trim()) return {};
  // Strip a leading UTF-8 BOM before parsing — a BOM-prefixed but otherwise
  // valid settings.json must parse, not be treated as unrecoverable garbage.
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  try { return JSON.parse(raw); } catch (_) { /* fall through to JSONC */ }
  try { return JSON.parse(stripJsonComments(raw)); }
  catch (e) {
    process.stderr.write(`tldr: warning — ${p} is not valid JSON or JSONC: ${e.message}\n`);
    return null;
  }
}

// ── writeSettings ──────────────────────────────────────────────────────────
// Atomic write via secure temp dir + rename. 0600 because settings may contain tokens.
function writeSettings(p, obj) {
  const content = JSON.stringify(obj, null, 2) + '\n';
  atomicWrite(p, content, 0o600);
}

// ── validateHookFields ────────────────────────────────────────────────────
// Claude Code uses strict Zod on settings.json — a single malformed hook
// silently discards the entire file. Mutate-to-valid before write.
//
// Required shape (per Claude Code docs):
//   settings.hooks[event] = [{ hooks: [{ type:'command', command:'…', timeout?:n }, ...] }, ...]
//   settings.hooks[event] = [{ matcher?:'…', hooks: [...] }, ...]   // also valid
//
// Preservation-biased: we only drop entries that are STRUCTURALLY hopeless
// (non-object, missing hooks array, or a hook object with no string `type`) or
// a known hook type missing its required field. Any object carrying an
// unrecognized-but-nonempty `type` is KEPT — it may be a hook type valid in a
// newer Claude Code than this installer knows about, and silently deleting a
// user's working hook is worse than the theoretical Zod risk we guard against.
// Every drop is reported via the optional `warn` callback rather than being
// silent. This never mutates entries we recognize as foreign.
function validateHookFields(settings, warn) {
  if (!isPlainObject(settings)) return settings;
  if (!isPlainObject(settings.hooks)) return settings;
  const dropped = [];
  for (const ev of Object.keys(settings.hooks)) {
    const arr = settings.hooks[ev];
    if (!Array.isArray(arr)) { dropped.push(`${ev} (not an array)`); delete settings.hooks[ev]; continue; }
    settings.hooks[ev] = arr.filter(entry => {
      if (!entry || typeof entry !== 'object') { dropped.push(`${ev} entry (not an object)`); return false; }
      if (!Array.isArray(entry.hooks)) { dropped.push(`${ev} entry (missing hooks array)`); return false; }
      entry.hooks = entry.hooks.filter(h => {
        if (!h || typeof h !== 'object') { dropped.push(`${ev} hook (not an object)`); return false; }
        // Known-valid Claude Code hook types: validate their required field.
        if (h.type === 'command') return typeof h.command === 'string' && h.command.length > 0;
        if (h.type === 'prompt' || h.type === 'agent') return typeof h.prompt === 'string' && h.prompt.length > 0;
        if (h.type === 'http') return typeof h.url === 'string' && h.url.length > 0;
        if (h.type === 'mcp_tool') {
          return typeof h.server === 'string' && h.server.length > 0
              && typeof h.tool === 'string' && h.tool.length > 0;
        }
        // Unknown but typed hook: preserve. Only shapeless (no string type) is dropped.
        if (typeof h.type === 'string' && h.type.length > 0) return true;
        dropped.push(`${ev} hook (no type field)`);
        return false;
      });
      return entry.hooks.length > 0;
    });
    if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (dropped.length && typeof warn === 'function') {
    warn('settings.json: dropped malformed hook entries: ' + dropped.join('; '));
  }
  return settings;
}

// ── Idempotency probe ──────────────────────────────────────────────────────
function hasTldrHook(settings, event, marker = 'tldr') {
  const arr = settings && settings.hooks && settings.hooks[event];
  if (!Array.isArray(arr)) return false;
  return arr.some(e =>
    e && Array.isArray(e.hooks) &&
    e.hooks.some(h => h && typeof h.command === 'string' && h.command.includes(marker))
  );
}

// ── addCommandHook ────────────────────────────────────────────────────────
// Idempotent push. `marker` defaults to opts.command — pass an explicit
// shorter substring (e.g. the script basename) when the full command path
// might rotate across reinstalls.
function addCommandHook(settings, event, opts) {
  // Defensive: a non-plain-object root can't carry a hooks map — bail rather
  // than throw a TypeError that would abort the run.
  if (!isPlainObject(settings)) return false;
  if (!isPlainObject(settings.hooks)) settings.hooks = {};
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  const marker = opts.marker || opts.command;
  if (hasTldrHook(settings, event, marker)) return false;
  const hook = { type: 'command', command: opts.command };
  if (typeof opts.timeout === 'number') hook.timeout = opts.timeout;
  if (typeof opts.statusMessage === 'string') hook.statusMessage = opts.statusMessage;
  settings.hooks[event].push({ hooks: [hook] });
  return true;
}

// ── removeTldrHooks ─────────────────────────────────────────────────────
// Strip every entry whose any hook command mentions `marker`. Empties events.
// Tolerates malformed pre-existing settings (non-array hook lists, foreign
// shapes) — those get dropped by validateHookFields first so we never call
// .length / .filter on a non-array.
function removeTldrHooks(settings, marker = 'tldr') {
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return 0;
  validateHookFields(settings);
  if (!isPlainObject(settings.hooks)) return 0; // validate may have deleted the whole tree
  let removed = 0;
  for (const ev of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[ev])) { delete settings.hooks[ev]; continue; }
    const before = settings.hooks[ev].length;
    settings.hooks[ev] = settings.hooks[ev].filter(entry => {
      if (!entry || !Array.isArray(entry.hooks)) return true;
      return !entry.hooks.some(h => h && typeof h.command === 'string' && h.command.includes(marker));
    });
    removed += before - settings.hooks[ev].length;
    if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

// ── rewriteLegacyManagedHookCommands ──────────────────────────────────────
// Walk every hook command. If it's a bare `node /path/to/<managed>.js` (no
// absolute node path) and the basename is one of ours, rewrite to use
// `absoluteNode` so GUI launchers with minimal PATH still find Node. Only
// touches commands matching the exact bare-node shape — won't false-positive
// on user-authored hooks that just happen to mention TLDR.
const MANAGED_HOOK_BASENAMES = new Set([
  'tldr-activate.js',
  'tldr-mode-tracker.js',
  'tldr-stats.js',
  'tldr-statusline.sh',
]);
function rewriteLegacyManagedHookCommands(settings, absoluteNode) {
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks) || !absoluteNode) return 0;
  let rewritten = 0;
  const reBare = /^node\s+("([^"]+)"|'([^']+)'|(\S+))\s*$/;
  for (const ev of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[ev])) continue;
    for (const entry of settings.hooks[ev]) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (!h || typeof h.command !== 'string') continue;
        const m = reBare.exec(h.command);
        if (!m) continue;
        const scriptPath = m[2] || m[3] || m[4];
        const basename = path.basename(scriptPath);
        if (!MANAGED_HOOK_BASENAMES.has(basename)) continue;
        h.command = `"${absoluteNode}" "${scriptPath}"`;
        rewritten++;
      }
    }
  }
  return rewritten;
}

// ── claudeConfigDir ───────────────────────────────────────────────────────
function claudeConfigDir() {
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return path.join(os.homedir(), '.claude');
}

module.exports = {
  stripJsonComments,
  readSettings,
  writeSettings,
  validateHookFields,
  hasTldrHook,
  addCommandHook,
  removeTldrHooks,
  rewriteLegacyManagedHookCommands,
  claudeConfigDir,
};
