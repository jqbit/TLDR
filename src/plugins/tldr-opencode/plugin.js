// TLDR — opencode plugin
//
// Provides dynamic TLDR mode tracking for opencode:
// - Writes the mode flag on each session start (via the `event` dispatcher)
// - Parses user messages for /tldr commands and natural-language toggles
// - Injects per-turn reinforcement into the system prompt
//
// Bun ESM module; loads the existing security-hardened helpers from
// tldr-config.js via a manual CommonJS evaluation so the symlink-safe
// flag-write code lives in one place.
//
// Layout once installed:
//   ~/.config/opencode/plugins/tldr/
//   ├── package.json
//   ├── plugin.js              ← this file
//   └── tldr-config.cjs        ← copied sibling of src/hooks/tldr-config.js
//
// The always-on TLDR ruleset is provided separately via
// ~/.config/opencode/AGENTS.md (Tier-3 base). This plugin handles dynamic
// state only: flag writes, slash-command parsing, natural-language
// activation, and per-turn reinforcement.
//
// Hook mapping (opencode >= 1.x):
//   - event (event.type === 'session.created'): session-init flag write,
//     re-fires per session rather than once per plugin-process load
//   - chat.message: intercept user prompts for mode changes
//   - experimental.chat.system.transform: inject reinforcement per-turn
//
// Note: opencode does NOT support 'session.created' or 'tui.prompt.append'
// as named plugin-hook keys. 'session.created' is an event *type* dispatched
// through the single `event` handler; the old direct-key handlers were
// silently ignored.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// When installed: tldr-config.cjs sits next to plugin.js (copied by
// bin/install.js, renamed to .cjs because this directory's package.json
// declares "type": "module" — bare .js would be loaded as ESM). When loaded
// from the source tree (tests, dev): fall back to the canonical
// src/hooks/tldr-config.js, which lives in a directory whose own
// package.json pins "type": "commonjs". One source of truth either way.
//
// Loaded by evaluating the file as CommonJS by hand, NOT via the module
// loader: opencode runs plugins inside a compiled Bun binary where
// require() of on-disk files is rejected ("require() async module is
// unsupported") and await import() of a CJS file yields an empty namespace —
// both silently break the plugin. createRequire() still resolves node
// BUILT-INS fine in the compiled binary, which is all tldr-config needs
// (fs/path/os/crypto).
function loadConfig() {
  const installed = join(here, 'tldr-config.cjs');
  const dev = join(here, '..', '..', 'hooks', 'tldr-config.js');
  const target = existsSync(installed) ? installed : dev;
  const code = readFileSync(target, 'utf8').replace(/^#![^\n]*\n/, '');
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', '__dirname', '__filename', code)(
    mod, mod.exports, createRequire(import.meta.url), dirname(target), target
  );
  return mod.exports;
}
const config = loadConfig();

const { getDefaultMode, safeWriteFlag, readFlag, VALID_MODES } = config;

// Modes handled by independent skills — not selectable via /tldr <arg>.
const INDEPENDENT_MODES = new Set(['commit', 'review', 'compress']);

function opencodeConfigDir() {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'opencode'
    );
  }
  return path.join(os.homedir(), '.config', 'opencode');
}

const flagPath = path.join(opencodeConfigDir(), '.tldr-active');

// Parse a prompt for slash-command activation or natural-language toggles.
// Returns the new mode to write, the literal string 'off' to deactivate, or
// null when the prompt doesn't change state. Mirrors tldr-mode-tracker.js.
function parseModeChange(promptRaw) {
  let prompt = (promptRaw || '').trim();
  // opencode's non-interactive `run` path delivers the message wrapped in
  // literal quote characters ("/tldr ultra"\n) — unwrap symmetric quotes
  // so the slash-command branch still matches.
  const wrapped = /^(["'`])([\s\S]*)\1$/.exec(prompt);
  if (wrapped) prompt = wrapped[2].trim();
  prompt = prompt.toLowerCase();
  if (!prompt) return null;

  // Expanded /tldr command template. opencode replaces a typed
  // "/tldr <level>" with the command file's body ("Activate tldr mode:
  // $ARGUMENTS ...") before chat.message fires, so the literal slash-command
  // branch below never sees it — recover the level argument from the
  // template's first line instead. Must run FIRST: the template body also
  // contains the phrases "stop tldr" and "normal mode", which would
  // otherwise trip the deactivation regexes and turn every /tldr command
  // into a deactivation.
  const tpl = /^activate tldr mode:[ \t]*(\S*)/.exec(prompt);
  if (tpl) {
    const arg = tpl[1] || '';
    if (arg === 'off' || arg === 'stop' || arg === 'disable') return 'off';
    if (arg === 'tldr') return 'full';
    if (arg === 'wenyan-full') return 'wenyan';
    if (VALID_MODES.includes(arg) && !INDEPENDENT_MODES.has(arg)) return arg;
    return getDefaultMode();
  }

  // Natural-language deactivation — checked before activation so "stop talking
  // like TLDR" doesn't trip the activation regex.
  if (/\b(stop|disable|deactivate|turn off)\b.*\btldr\b/i.test(prompt) ||
      /\btldr\b.*\b(stop|disable|deactivate|turn off)\b/i.test(prompt) ||
      /\bnormal mode\b/i.test(prompt)) {
    return 'off';
  }

  // Natural-language activation
  if (/\b(activate|enable|turn on|start|talk like)\b.*\btldr\b/i.test(prompt) ||
      /\btldr\b.*\b(mode|activate|enable|turn on|start)\b/i.test(prompt)) {
    const mode = getDefaultMode();
    return mode === 'off' ? null : mode;
  }

  // Slash-command parsing — opencode also expands command files, but if the
  // user types the literal slash command we still want to flip the flag.
  if (prompt.startsWith('/tldr')) {
    const parts = prompt.split(/\s+/);
    const cmd = parts[0];
    const arg = parts[1] || '';

    if (cmd === '/tldr-commit')   return 'commit';
    if (cmd === '/tldr-review')   return 'review';
    if (cmd === '/tldr-compress') return 'compress';

    if (cmd === '/tldr') {
      if (!arg)                                     return getDefaultMode();
      if (arg === 'off' || arg === 'stop' || arg === 'disable') return 'off';
      if (arg === 'tldr')                                      return 'full';
      if (arg === 'wenyan-full')                   return 'wenyan';
      if (VALID_MODES.includes(arg) && !INDEPENDENT_MODES.has(arg)) return arg;
      // Unknown arg — leave flag alone. No silent overwrite.
      return null;
    }
  }

  return null;
}

function applyModeChange(mode) {
  if (!mode) return;
  if (mode === 'off') {
    try { if (existsSync(flagPath)) unlinkSync(flagPath); } catch (e) {}
    return;
  }
  safeWriteFlag(flagPath, mode);
}

// Session-start logic — extracted so the `event` dispatcher drives one shared
// implementation. Re-fires on every `session.created` event, so a new session
// in a long-lived plugin process re-asserts the flag.
function handleSessionCreated() {
  const mode = getDefaultMode();
  if (mode === 'off') {
    try { if (existsSync(flagPath)) unlinkSync(flagPath); } catch (e) {}
    return;
  }
  safeWriteFlag(flagPath, mode);
}

export const TldrPlugin = async (_ctx) => {
  // Assert the flag at plugin load as well: in one-shot `opencode run` the
  // first session.created publishes before plugin event dispatch is wired,
  // so the event handler alone misses it. The factory-time write covers that
  // race; the event handler re-asserts on every later session in long-lived
  // TUI processes.
  handleSessionCreated();

  return {
  // opencode dispatches session/lifecycle events through a single `event`
  // handler keyed on event.type; a direct top-level 'session.created' key
  // is silently ignored. Routing session-init through here means the flag is
  // rewritten on every new session, not just once when the plugin module
  // loads. See https://opencode.ai/docs/plugins#events.
  event: async ({ event } = {}) => {
    if (event && event.type === 'session.created') handleSessionCreated();
  },

  // Intercept user messages to detect /tldr commands and natural-language
  // mode toggles. opencode fires chat.message with (input, output) where
  // output.parts is the array of message parts; text parts carry .text.
  // Return value is ignored — state changes happen via the flag file.
  'chat.message': async (_input, output) => {
    if (!output || !output.parts) return;
    for (const part of output.parts) {
      if (part && part.type === 'text' && part.text) {
        const change = parseModeChange(part.text);
        if (change) applyModeChange(change);
      }
    }
  },

  // Inject the reinforcement line into the system prompt when TLDR is
  // active. opencode calls this before every LLM request and expects the hook
  // to mutate output.system (a string[]); the return value is discarded.
  'experimental.chat.system.transform': async (_input, output) => {
    if (!output || !Array.isArray(output.system)) return;
    const active = readFlag(flagPath);
    if (active && !INDEPENDENT_MODES.has(active)) {
      output.system.push('TLDR MODE ACTIVE (' + active + '). ' +
        'Drop articles/filler/pleasantries/hedging. Fragments OK. ' +
        'Code/commits/security: write normal.');
    }
  },
  };
};

export default TldrPlugin;
