#!/usr/bin/env node
// TLDR — Claude Code SessionStart activation hook
//
// Runs on every session start:
//   1. Writes flag file at $CLAUDE_CONFIG_DIR/.tldr-active (statusline reads this)
//   2. Emits TLDR ruleset as hidden SessionStart context
//   3. Detects missing statusline config and emits setup nudge

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getDefaultMode, safeWriteFlag } = require('./tldr-config');

// TLDR_CONFIG_DIR lets non-Claude agents (codex/cursor/grok/antigravity) keep
// their own mode flag; falls back to Claude's dir so existing installs are
// unaffected.
function argValue(name) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

const claudeDir = argValue('config-dir')
  || process.env.TLDR_CONFIG_DIR
  || process.env.CLAUDE_CONFIG_DIR
  || path.join(os.homedir(), '.claude');

// Each agent wants session-start context in a different envelope.
//   text        Claude / Codex / Grok — raw stdout becomes added context
//   cursor      Cursor sessionStart  -> {"additional_context": "..."}
//   antigravity agy PreInvocation    -> {"injectSteps":[{"ephemeralMessage":"..."}]}
const FORMAT = argValue('format') || process.env.TLDR_HOOK_FORMAT || 'text';

function emit(text) {
  if (FORMAT === 'cursor') {
    process.stdout.write(JSON.stringify({ additional_context: text }));
  } else if (FORMAT === 'antigravity') {
    process.stdout.write(JSON.stringify({ injectSteps: [{ ephemeralMessage: text }] }));
  } else {
    process.stdout.write(text);
  }
}
const flagPath = path.join(claudeDir, '.tldr-active');
const settingsPath = path.join(claudeDir, 'settings.json');

// Apply per-agent model overrides from env vars before emitting rules.
// Best-effort: any error is swallowed so SessionStart is never blocked.
// Plugin installs run this hook from <plugin_root>/src/hooks/ and keep agents
// at <plugin_root>/agents/, so prefer CLAUDE_PLUGIN_ROOT when Claude Code sets
// it. Standalone installs fall back to the parent of the hooks dir
// ($CLAUDE_CONFIG_DIR), where agents/ may hold user-managed copies.
try {
  const { applyOverrides } = require('./tldrcrew-model-overrides');
  applyOverrides(process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..'));
} catch (e) {}

const mode = getDefaultMode();

// "off" mode — skip activation entirely, don't write flag or emit rules
if (mode === 'off') {
  try { fs.unlinkSync(flagPath); } catch (e) {}
  emit(FORMAT === 'text' ? 'OK' : '');
  process.exit(0);
}

// 1. Write flag file (symlink-safe)
safeWriteFlag(flagPath, mode);

// 2. Emit full TLDR ruleset, filtered to the active intensity level.
//    The old 2-sentence summary was too weak — models drifted back to verbose
//    mid-conversation, especially after context compression pruned it away.
//    Full rules with examples anchor behavior much more reliably.
//
//    Reads SKILL.md at runtime so edits to the source of truth propagate
//    automatically — no hardcoded duplication to go stale.

// Modes that have their own independent skill files — not TLDR intensity levels.
// For these, emit a short activation line; the skill itself handles behavior.
const INDEPENDENT_MODES = new Set(['commit', 'review', 'compress']);

if (INDEPENDENT_MODES.has(mode)) {
  emit('TLDR MODE ACTIVE — level: ' + mode + '. Behavior defined by /tldr-' + mode + ' skill.');
  process.exit(0);
}

const { getInstructions } = require('./tldr-instructions');
let output = getInstructions(mode);

// 3. Detect missing statusline config — nudge Claude to help set it up.
//    Claude-only: no other agent has a statusLine setting to configure.
try {
  if (FORMAT !== 'text' || argValue('config-dir') || process.env.TLDR_CONFIG_DIR) throw new Error('skip');
  let hasStatusline = false;
  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.statusLine) {
      hasStatusline = true;
    }
  }

  if (!hasStatusline) {
    const isWindows = process.platform === 'win32';
    const scriptName = isWindows ? 'tldr-statusline.ps1' : 'tldr-statusline.sh';
    const scriptPath = path.join(__dirname, scriptName);
    const command = isWindows
      ? `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`
      : `bash "${scriptPath}"`;
    const statusLineSnippet =
      '"statusLine": { "type": "command", "command": ' + JSON.stringify(command) + ' }';
    output += "\n\n" +
      "STATUSLINE SETUP NEEDED: The TLDR plugin includes a statusline badge showing active mode " +
      "(e.g. [TLDR], [TLDR:ULTRA]). It is not configured yet. " +
      "To enable, add this to " + path.join(claudeDir, 'settings.json') + ": " +
      statusLineSnippet + " " +
      "Proactively offer to set this up for the user on first interaction.";
  }
} catch (e) {
  // Silent fail — don't block session start over statusline detection
}

emit(output);
