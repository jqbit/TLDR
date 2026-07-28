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

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
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
  process.stdout.write('OK');
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
  process.stdout.write('TLDR MODE ACTIVE — level: ' + mode + '. Behavior defined by /tldr-' + mode + ' skill.');
  process.exit(0);
}

// Resolve the canonical label for wenyan alias
const modeLabel = mode === 'wenyan' ? 'wenyan-full' : mode;

// Read SKILL.md — the single source of truth for TLDR behavior.
// Plugin installs: __dirname = <plugin_root>/src/hooks/, SKILL.md at <plugin_root>/skills/tldr/SKILL.md
//   — so climb TWO levels (src/hooks → src → <plugin_root>) then into skills/tldr/.
// Standalone installs: __dirname = $CLAUDE_CONFIG_DIR/hooks/, SKILL.md won't exist — falls back to hardcoded rules.
let skillContent = '';
try {
  skillContent = fs.readFileSync(
    path.join(__dirname, '..', '..', 'skills', 'tldr', 'SKILL.md'), 'utf8'
  );
} catch (e) { /* standalone install — will use fallback below */ }

let output;

if (skillContent) {
  // Strip YAML frontmatter
  const body = skillContent.replace(/^---[\s\S]*?---\s*/, '');

  // Filter intensity table: keep header rows + only the active level's row
  const filtered = body.split('\n').reduce((acc, line) => {
    // Intensity table rows start with | **level** |
    const tableRowMatch = line.match(/^\|\s*\*\*(\S+?)\*\*\s*\|/);
    if (tableRowMatch) {
      // Keep only the active level's row (and always keep header/separator)
      if (tableRowMatch[1] === modeLabel) {
        acc.push(line);
      }
      return acc;
    }

    // Example lines start with "- level:" — keep only lines matching active level.
    // Restrict to actual intensity tokens so unrelated rule bullets like
    // "- Default: 1 sentence." are NOT mistaken for a level and dropped.
    const exampleMatch = line.match(/^- (lite|full|ultra|wenyan(?:-lite|-full|-ultra)?):\s/);
    if (exampleMatch) {
      if (exampleMatch[1] === modeLabel) {
        acc.push(line);
      }
      return acc;
    }

    acc.push(line);
    return acc;
  }, []);

  output = 'TLDR MODE ACTIVE — level: ' + modeLabel + '\n\n' + filtered.join('\n');
} else {
  // Fallback when SKILL.md is not found (standalone hook install without skills dir).
  // This is the minimum viable ruleset — better than nothing.
  output =
    'TLDR MODE ACTIVE — level: ' + modeLabel + '\n\n' +
    'Respond in TLDR style: verdict first, no filler. All technical substance stays.\n\n' +
    '## Persistence\n\n' +
    'ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if unsure. Off only: "stop tldr" / "normal mode".\n\n' +
    'Current level: **' + modeLabel + '**. Switch: `/tldr lite|full|ultra|wenyan`.\n\n' +
    '## Rules\n\n' +
    'Default: 1 sentence.\n' +
    'Default target: 3 words.\n' +
    'Default maximum: 6 words.\n\n' +
    'Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging. ' +
    'Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). Technical terms exact. Code blocks unchanged. Errors quoted exact.\n\n' +
    'Pattern: `[thing] [action] [reason]. [next step].`\n\n' +
    'Not: "Sure! I\'d be happy to help you with that. The issue you\'re experiencing is likely caused by..."\n' +
    'Yes: "Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:"\n\n' +
    '## Auto-Clarity\n\n' +
    'Drop TLDR for: security warnings, irreversible action confirmations, multi-step sequences where fragment order risks misread, user asks to clarify or repeats question. Resume TLDR after clear part done.\n\n' +
    '## Boundaries\n\n' +
    'Code/commits/PRs: write normal. "stop tldr" or "normal mode": revert. Level persist until changed or session end.';
}

// 3. Detect missing statusline config — nudge Claude to help set it up
try {
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

process.stdout.write(output);
