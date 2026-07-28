#!/usr/bin/env node
// TLDR — UserPromptSubmit hook to track which tldr mode is active
// Inspects user input for /tldr commands and writes mode to flag file

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { getDefaultMode, safeWriteFlag, readFlag, VALID_MODES } = require('./tldr-config');

// Modes handled by their own slash commands (/tldr-commit, etc.) — not
// selectable via /tldr <arg>.
const INDEPENDENT_MODES = new Set(['commit', 'review', 'compress']);

const cfgArg = process.argv.find(a => a.startsWith('--config-dir='));
const claudeDir = (cfgArg ? cfgArg.slice('--config-dir='.length) : '')
  || process.env.TLDR_CONFIG_DIR
  || process.env.CLAUDE_CONFIG_DIR
  || path.join(os.homedir(), '.claude');
const flagPath = path.join(claudeDir, '.tldr-active');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
// A broken pipe / parent crash emits 'error' on stdin; without a handler Node
// throws "Unhandled 'error' event" and the UserPromptSubmit hook exits non-zero,
// which surfaces as a spurious failure in the user's agent. Hooks must fail
// silent — swallow it and exit cleanly.
process.stdin.on('error', () => { process.exit(0); });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const prompt = (data.prompt || '').trim().toLowerCase();

    // Natural language activation (e.g. "activate TLDR", "turn on tldr mode",
    // "talk like TLDR"). README tells users they can say these, but the hook
    // only matched /tldr commands — flag file and statusline stayed out of sync.
    if (/\b(activate|enable|turn on|start|talk like)\b.*\btldr\b/i.test(prompt) ||
        /\btldr\b.*\b(mode|activate|enable|turn on|start)\b/i.test(prompt)) {
      if (!/\b(stop|disable|turn off|deactivate)\b/i.test(prompt)) {
        const mode = getDefaultMode();
        if (mode !== 'off') {
          safeWriteFlag(flagPath, mode);
        }
      }
    }

    // /tldr-stats [--share] — block the prompt and inject stats output as
    // the hook's reason. The script reads the active session log, so we pass
    // transcript_path through when Claude Code provides it. Also matches the
    // plugin-namespaced form (/tldr:tldr-stats) that Claude Code uses for
    // marketplace installs. tests/installer/slash-commands.test.mjs mirrors
    // this regex — keep both in sync.
    const statsMatch = /^\/tldr(?::tldr)?-stats(?:\s+(.*))?$/.exec(prompt);
    if (statsMatch) {
      const tailArgs = (statsMatch[1] || '').trim().split(/\s+/).filter(Boolean);
      try {
        const statsPath = path.join(__dirname, 'tldr-stats.js');
        const argv = [statsPath];
        if (data.transcript_path) argv.push('--session-file', data.transcript_path);
        if (tailArgs.includes('--share')) argv.push('--share');
        if (tailArgs.includes('--all')) argv.push('--all');
        const sinceIdx = tailArgs.indexOf('--since');
        if (sinceIdx !== -1 && tailArgs[sinceIdx + 1]) {
          argv.push('--since', tailArgs[sinceIdx + 1]);
        }
        const out = execFileSync(process.execPath, argv, { encoding: 'utf8', timeout: 5000 });
        process.stdout.write(JSON.stringify({ decision: 'block', reason: out.trim() }));
      } catch (e) {
        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason: 'tldr-stats: could not run stats script.\nTry manually: node hooks/tldr-stats.js'
        }));
      }
      return;
    }

    // Match /tldr commands
    if (prompt.startsWith('/tldr')) {
      const parts = prompt.split(/\s+/);
      const cmd = parts[0]; // /tldr, /tldr-commit, /tldr-review, etc.
      // Marketplace installs namespace slash commands as "/tldr:tldr <arg>"
      // (e.g. "/tldr:tldr ultra"). Strip the "/tldr:" prefix once so the
      // bare-mode branch matches it exactly like the standalone "/tldr" form.
      const cmd0 = cmd.replace(/^\/tldr:/, '/');
      const arg = parts[1] || '';

      let mode = null;

      if (cmd === '/tldr-commit') {
        mode = 'commit';
      } else if (cmd === '/tldr-review') {
        mode = 'review';
      } else if (cmd === '/tldr-compress' || cmd === '/tldr:tldr-compress') {
        mode = 'compress';
      } else if (cmd0 === '/tldr') {
        // Bare /tldr (or namespaced /tldr:tldr) → activate at configured default
        if (!arg) {
          mode = getDefaultMode();
        } else if (arg === 'off' || arg === 'stop' || arg === 'disable') {
          mode = 'off';
        } else if (arg === 'wenyan-full') {
          // Canonical alias — config stores as 'wenyan'
          mode = 'wenyan';
        } else if (VALID_MODES.includes(arg) && !INDEPENDENT_MODES.has(arg)) {
          mode = arg;
        }
        // Unknown arg → mode stays null, flag untouched (no silent overwrite)
      }

      if (mode && mode !== 'off') {
        safeWriteFlag(flagPath, mode);
      } else if (mode === 'off') {
        try { fs.unlinkSync(flagPath); } catch (e) {}
      }
    }

    // Detect deactivation — natural language and slash commands
    if (/\b(stop|disable|deactivate|turn off)\b.*\btldr\b/i.test(prompt) ||
        /\btldr\b.*\b(stop|disable|deactivate|turn off)\b/i.test(prompt) ||
        /\bnormal mode\b/i.test(prompt)) {
      try { fs.unlinkSync(flagPath); } catch (e) {}
    }

    // Per-turn reinforcement: emit a structured reminder when TLDR is active.
    // The SessionStart hook injects the full ruleset once, but models lose it
    // when other plugins inject competing style instructions every turn.
    // This keeps TLDR visible in the model's attention on every user message.
    //
    // Skip independent modes (commit, review, compress) — they have their own
    // skill behavior and the base TLDR rules would conflict.
    // readFlag enforces symlink-safe read + size cap + VALID_MODES whitelist.
    // If the flag is missing, corrupted, oversized, or a symlink pointing at
    // something like ~/.ssh/id_rsa, readFlag returns null and we emit nothing
    // — never inject untrusted bytes into model context.
    const activeMode = readFlag(flagPath);
    if (activeMode && !INDEPENDENT_MODES.has(activeMode)) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "TLDR MODE ACTIVE (" + activeMode + "). " +
            "Drop articles/filler/pleasantries/hedging. Fragments OK. " +
            "Code/commits/security: write normal."
        }
      }));
    }
  } catch (e) {
    // Silent fail
  }
});
