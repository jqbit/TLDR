'use strict';

// Hook-file writers for the non-Claude agents.
//
// Every agent below has a real hook system, but three different schemas:
//
//   codex / grok   Claude-shaped: event -> [{ matcher?, hooks: [handler] }]
//                  handler = { type: 'command', command, timeout, statusMessage }
//   cursor         { version: 1, hooks: { event: [{ command, timeout }] } }
//                  flat handler list, camelCase events, no `type`
//   antigravity    { "<hook-name>": { event: [...] } } — PreInvocation/Stop are
//                  FLAT handler lists; PreToolUse/PostToolUse use the grouped
//                  matcher form. Only PreInvocation can inject context.
//
// All writers MERGE: a user's existing hooks are preserved. We identify our own
// entries by the TLDR marker in the command string and replace only those, so
// re-running the installer is idempotent and never clobbers another tool.

const MARKER = 'tldr-activate.js';
const TRACKER_MARKER = 'tldr-mode-tracker.js';

function isOurs(cmd) {
  const s = typeof cmd === 'string' ? cmd : '';
  return s.includes(MARKER) || s.includes(TRACKER_MARKER);
}

// Strip previously-installed TLDR handlers from a handler array, dropping the
// group entirely when nothing user-owned remains.
function pruneGrouped(groups) {
  if (!Array.isArray(groups)) return [];
  return groups
    .map(g => {
      if (!g || typeof g !== 'object') return null;
      if (!Array.isArray(g.hooks)) return isOurs(g.command) ? null : g;
      const kept = g.hooks.filter(h => !isOurs(h && h.command));
      return kept.length ? Object.assign({}, g, { hooks: kept }) : null;
    })
    .filter(Boolean);
}

function pruneFlat(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(h => !isOurs(h && h.command));
}

// ── Claude-shaped: Codex, Grok ────────────────────────────────────────────
function buildClaudeStyle(existing, activateCmd, trackerCmd) {
  const out = (existing && typeof existing === 'object') ? existing : {};
  const hooks = (out.hooks && typeof out.hooks === 'object') ? out.hooks : {};

  hooks.SessionStart = pruneGrouped(hooks.SessionStart).concat([{
    matcher: 'startup|resume|clear|compact',
    hooks: [{ type: 'command', command: activateCmd, timeout: 10, statusMessage: 'Loading TLDR mode' }],
  }]);

  hooks.UserPromptSubmit = pruneGrouped(hooks.UserPromptSubmit).concat([{
    hooks: [{ type: 'command', command: trackerCmd, timeout: 10, statusMessage: 'Tracking TLDR mode' }],
  }]);

  out.hooks = hooks;
  return out;
}

// ── Cursor: version 1, flat handlers, camelCase events ────────────────────
function buildCursorStyle(existing, activateCmd) {
  const out = (existing && typeof existing === 'object') ? existing : {};
  out.version = 1;
  const hooks = (out.hooks && typeof out.hooks === 'object') ? out.hooks : {};

  // Only sessionStart can inject context. beforeSubmitPrompt cannot add
  // context today (it can only block), so mode toggles are not wired here.
  hooks.sessionStart = pruneFlat(hooks.sessionStart).concat([
    { command: activateCmd, timeout: 10 },
  ]);

  out.hooks = hooks;
  return out;
}

// ── Antigravity (agy): named hook blocks, PreInvocation is flat ───────────
function buildAntigravityStyle(existing, activateCmd) {
  const out = (existing && typeof existing === 'object') ? existing : {};
  // Our block is namespaced by key, so merging is just a key replace.
  out.tldr = {
    PreInvocation: [{ type: 'command', command: activateCmd, timeout: 30 }],
  };
  return out;
}

module.exports = {
  isOurs,
  pruneGrouped,
  pruneFlat,
  buildClaudeStyle,
  buildCursorStyle,
  buildAntigravityStyle,
};
