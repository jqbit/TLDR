#!/usr/bin/env node
// TLDR — unified cross-platform installer.
//
// One Node script replaces the old install.sh + install.ps1 + src/hooks/install.sh
// + src/hooks/install.ps1 quartet. Single source of truth. Works on macOS, Linux,
// and Windows (PowerShell or cmd) without any of the bash/PS1 quoting bugs
// that previously broke the JSON merge step (issue #249).
//
// Distribution:
//   Local clone: node bin/install.js [flags]
//   curl|bash:   delegated from install-full.sh shim → npx -y github:0p9b/TLDR -- [flags]
//   Windows:     pwsh install.ps1 [flags] → same npx delegation
//
// Pure stdlib, zero npm runtime deps.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');
const readline = require('readline');
const crypto = require('crypto');

const SETTINGS = require('./lib/settings');
const OPENCLAW = require('./lib/openclaw');
const { stripOpencodeAgentTools } = require('./lib/opencode-agent');
const { atomicWrite, createSecureTempDir, safeRmdir } = require('./lib/safe-fs');
const { findFencedBlocks, stripFencedBlocks, upsertFencedBlock } = require('./lib/fenced');
const AGENT_HOOKS = require('./lib/agent-hooks');
const UPDATE = require('./lib/update');

const REPO = '0p9b/TLDR';
// Pin remote fetches to an IMMUTABLE release tag, never the moving `main`. A
// push to main must never silently change what a `curl|bash` / npx install
// downloads and executes — and, crucially, the integrity manifest
// (checksums.sha256) is fetched from this SAME ref, so a repo push cannot
// rewrite a hook and its recorded checksum in lockstep. RELEASE PROCESS: bump
// PINNED_REF only AFTER regenerating src/hooks/checksums.sha256 so the tag and
// the manifest stay coherent. Override with TLDR_REF for branch testing.
const PINNED_REF = process.env.TLDR_REF || 'v0.20.0';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${PINNED_REF}`;
const HOOKS_REMOTE = `${RAW_BASE}/src/hooks`;
const INIT_SCRIPT_URL = `${RAW_BASE}/src/tools/tldr-init.js`;
// Scoped package name, owner-controlled. A bare unscoped name ('tldr-shrink')
// is a dependency-confusion vector: it is not published, so `npx -y tldr-shrink`
// would resolve to whatever an attacker publishes under that name and execute
// it as an auto-started MCP server. Names under the @0point9bar scope cannot be
// squatted by anyone who does not own the scope, which closes that hole. Until
// the package is published, installMcpShrink falls back to the in-repo
// src/mcp-servers/tldr-shrink when `npm view` fails (clone / local install).
const MCP_SHRINK_PKG = '@0point9bar/tldr-shrink';
const MCP_SHRINK_LOCAL = path.join('src', 'mcp-servers', 'tldr-shrink', 'index.js');
// Hermes productivity skill suite (mirrors OPENCODE_SKILL_DIRS naming).
const HERMES_SKILL_DIRS = [
  'tldr', 'tldr-commit', 'tldr-review', 'tldr-help', 'tldr-stats', 'tldr-compress', 'tldrcrew', 'tldr-update',
];
// Hook files to copy. Statusline ships in both .sh (macOS/Linux) and .ps1
// (Windows) flavors — copy both regardless of host OS so a roaming
// $CLAUDE_CONFIG_DIR (e.g. dotfiles repo) keeps working across platforms.
const HOOK_FILES = [
  'package.json',
  'tldr-config.js',
  'tldr-activate.js',
  'tldr-mode-tracker.js',
  'tldr-stats.js',
  'tldr-statusline.sh',
  'tldr-statusline.ps1',
  'tldrcrew-model-overrides.js',
];

// ── Subcommand peel ────────────────────────────────────────────────────────
// `tldr update|install|uninstall|list …` dispatches by first argv token.
// Bare flags with no subcommand keep install behavior (compat for
// `npx … -- --only claude` and `node bin/install.js --all`).
const SUBCOMMANDS = new Set(['update', 'install', 'uninstall', 'list']);

function peelCommand(argv) {
  if (!argv || argv.length === 0) return { command: 'install', argv: [] };
  const first = argv[0];
  if (SUBCOMMANDS.has(first)) {
    return { command: first, argv: argv.slice(1) };
  }
  return { command: 'install', argv };
}

// ── Argv ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    dryRun: false, force: false, skipSkills: false,
    withHooks: 'auto', withInit: false, withMcpShrink: false,
    all: false, minimal: false, listOnly: false, noColor: false,
    only: [], uninstall: false, nonInteractive: false,
    configDir: null, help: false,
  };
  // Records the explicit VALUE of any --with-*/--no-* toggle seen in the loop.
  // Applied AFTER --all/--minimal so an explicit toggle always wins, regardless
  // of flag order (e.g. `--all --no-hooks` and `--no-hooks --all` both mean
  // hooks OFF). --all/--minimal only set DEFAULTS.
  const explicitToggle = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // --with-mcp-shrink=<upstream cmd>  (handled before the switch so the
    // GNU-style =value form is recognized). Bare --with-mcp-shrink falls
    // through to the switch and is rejected — tldr-shrink is a proxy and a
    // stub registration just lands the user in a broken-MCP loop.
    if (a.startsWith('--with-mcp-shrink=')) {
      const raw = a.slice('--with-mcp-shrink='.length);
      const tokens = raw.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) {
        die('error: --with-mcp-shrink requires an upstream command\n' +
            '  example: --with-mcp-shrink="npx @modelcontextprotocol/server-filesystem /path"');
      }
      opts.withMcpShrink = tokens;
      explicitToggle.withMcpShrink = tokens;
      continue;
    }
    switch (a) {
      case '--dry-run': opts.dryRun = true; break;
      case '--force': opts.force = true; break;
      case '--skip-skills': opts.skipSkills = true; break;
      case '--with-hooks': opts.withHooks = true; explicitToggle.withHooks = true; break;
      case '--no-hooks': opts.withHooks = false; explicitToggle.withHooks = false; break;
      case '--with-init': opts.withInit = true; explicitToggle.withInit = true; break;
      case '--with-mcp-shrink': {
        const v = argv[i + 1];
        if (v && !v.startsWith('--')) {
          i++;
          const tokens = v.trim().split(/\s+/).filter(Boolean);
          if (tokens.length === 0) {
            die('error: --with-mcp-shrink requires an upstream command\n' +
                '  example: --with-mcp-shrink "npx @modelcontextprotocol/server-filesystem /path"');
          }
          opts.withMcpShrink = tokens;
          explicitToggle.withMcpShrink = tokens;
        } else {
          die('error: --with-mcp-shrink requires an upstream command — tldr-shrink\n' +
              '  is a proxy and exits immediately without one. Pass the upstream:\n' +
              '  --with-mcp-shrink="npx @modelcontextprotocol/server-filesystem /path"');
        }
        break;
      }
      case '--no-mcp-shrink': opts.withMcpShrink = false; explicitToggle.withMcpShrink = false; break;
      case '--all': opts.all = true; break;
      case '--minimal': opts.minimal = true; break;
      case '--list': opts.listOnly = true; break;
      case '--no-color': opts.noColor = true; break;
      case '--uninstall': case '-u': opts.uninstall = true; break;
      case '--non-interactive': opts.nonInteractive = true; break;
      case '-h': case '--help': opts.help = true; break;
      // POSIX end-of-options marker. Older curl|bash flows pipe `-- --only foo`
      // through npx; some npx versions forward the literal `--`. Accept and
      // ignore so we never regress on the headline install command.
      case '--': break;
      case '--only': {
        const v = argv[++i];
        if (!v) die('error: --only requires an argument');
        // Accept a comma-separated list (`--only claude,codex,opencode`) as
        // well as repeated flags, so a single-line install can name several
        // agents at once.
        const ids = v.split(',').map(s => s.trim()).filter(Boolean);
        // A separators-only value (`--only ,` / `--only '   '`) trims to an
        // empty list; treat it as an error rather than silently meaning "all".
        if (ids.length === 0) die('error: --only requires at least one agent id');
        for (const one of ids) {
          opts.only.push(one === 'aider' ? 'aider-desk' : one);
        }
        break;
      }
      case '--config-dir': {
        const v = argv[++i];
        if (!v || v.startsWith('--')) die('error: --config-dir requires a path');
        opts.configDir = expandHome(v);
        break;
      }
      default:
        die(`error: unknown flag: ${a}\nrun 'tldr --help' for usage`);
    }
  }
  if (opts.all && opts.minimal) die('error: --all and --minimal are mutually exclusive');
  // --all turns on hooks + per-repo init only. It deliberately does NOT force
  // withMcpShrink — tldr-shrink is a proxy that needs an upstream command, so
  // there's no sensible "everything on" default. Opt in with
  // --with-mcp-shrink="<upstream cmd>".
  if (opts.all) { opts.withHooks = true; opts.withInit = true; }
  if (opts.minimal) { opts.withHooks = false; opts.withInit = false; opts.withMcpShrink = false; }
  // …then any EXPLICIT --with-*/--no-* toggle wins, regardless of order.
  for (const k of Object.keys(explicitToggle)) opts[k] = explicitToggle[k];
  if (opts.withHooks === 'auto') opts.withHooks = true;
  // Validate --only ids against the provider matrix. PROVIDERS is defined later
  // in the file but is in scope by the time this function runs.
  if (opts.only.length) {
    const knownIds = new Set(PROVIDERS.map(p => p.id));
    for (const id of opts.only) {
      if (!knownIds.has(id)) {
        die(`error: unknown agent: ${id}\n  see 'tldr --list' for valid ids`);
      }
    }
  }
  return opts;
}

function die(msg) { process.stderr.write(msg + '\n'); process.exit(2); }

// ── Color helpers ──────────────────────────────────────────────────────────
function makeChalk(noColor) {
  const useColor = !noColor && process.stdout.isTTY && !process.env.NO_COLOR;
  const wrap = (codes) => (s) => useColor ? `\x1b[${codes}m${s}\x1b[0m` : s;
  return {
    orange: wrap('38;5;172'), dim: wrap('2'), red: wrap('31'),
    green: wrap('32'), yellow: wrap('33'),
  };
}

// ── Env guards ─────────────────────────────────────────────────────────────
function checkWslWindowsNode() {
  if (process.platform !== 'win32') return;
  // Windows-Node executing inside WSL has homedir like /mnt/c/Users/... which
  // breaks every config-dir resolution. Detect and abort with a clear hint.
  if (process.env.WSL_DISTRO_NAME) {
    die('tldr: detected Windows Node.js running inside WSL.\n' +
        '         Install Linux-native Node inside your WSL distro and re-run there.\n' +
        '         (WSL_DISTRO_NAME=' + process.env.WSL_DISTRO_NAME + ')');
  }
  try {
    const v = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
    if (v.includes('microsoft') || v.includes('wsl')) {
      die('tldr: detected Windows Node.js running inside WSL (/proc/version).\n' +
          '         Install Linux-native Node inside your WSL distro and re-run there.');
    }
  } catch (_) { /* /proc/version absent on real Windows — fine */ }
}

function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) die(`tldr: Node ${process.versions.node} too old. Need Node ≥18. https://nodejs.org`);
}

// ── Provider matrix ────────────────────────────────────────────────────────
// Single source of truth. Replaces the 6 parallel bash arrays in old install.sh.
//
// Detection rules:
//   - `command:<bin>` — bin on PATH. Most reliable signal.
//   - `vscode-ext:<needle>` / `cursor-ext:<needle>` — extension dir name match.
//   - `jetbrains-plugin:<needle>` — JetBrains plugin dir match.
//   - `dir:<path>` / `file:<path>` — kept ONLY for agents that ship no CLI
//      and no extension marker (true dir-only signal).
//
// `soft: true` means detection is best-effort (config-dir only or no
// reliable probe). Soft providers are EXCLUDED from auto-detect and only
// install when the user passes `--only <id>`. This stops the installer from
// firing `npx skills add ...` against agents the user has never installed
// just because some other tool created `~/.foo` along the way.
const PROVIDERS = [
  { id: 'claude',     label: 'Claude Code',         mech: 'claude plugin install',         detect: 'command:claude' },
  { id: 'gemini',     label: 'Gemini CLI',          mech: 'gemini extensions install',     detect: 'command:gemini' },
  { id: 'opencode',   label: 'opencode',            mech: 'native opencode plugin',        detect: 'command:opencode' },
  { id: 'openclaw',   label: 'OpenClaw',            mech: 'workspace skill + SOUL.md',     detect: 'command:openclaw||dir:$HOME/.openclaw/workspace' },
  { id: 'hermes',     label: 'Hermes Agent',        mech: 'native hermes SOUL.md + productivity skills',   detect: 'command:hermes' },
  { id: 'codex',      label: 'Codex CLI',           mech: 'native AGENTS.md + skill',       detect: 'command:codex',           native: { dir: '$HOME/.codex',    rules: 'AGENTS.md', skills: 'skills', hooks: { file: 'hooks.json', style: 'claude', trust: 'run /hooks in Codex to trust the new TLDR hooks (Codex skips untrusted hooks)' } } },
  { id: 'pi',         label: 'Pi Coding Agent',     mech: 'native AGENTS.md + skill',       detect: 'command:pi',              native: { dir: '$HOME/.pi/agent', rules: 'AGENTS.md', skills: 'skills' } },
  { id: 'grok',       label: 'Grok Build CLI',      mech: 'native AGENTS.md + skill',       detect: 'command:grok',            native: { dir: '$HOME/.grok',     rules: 'AGENTS.md', skills: 'skills', hooks: { file: 'hooks/tldr.json', style: 'claude' } } },
  // oh-my-pi (omp): loads a user-scope AGENTS.md and auto-discovers skills from
  // <agentDir>/skills. Default agent dir is ~/.omp/agent; it becomes
  // ~/.omp/profiles/<name>/agent only when OMP_PROFILE/PI_PROFILE is set — the
  // installer targets the default (~/.omp/agent).
  { id: 'omp',        label: 'oh-my-pi',            mech: 'native AGENTS.md + skill',       detect: 'command:omp',             native: { dir: '$HOME/.omp/agent', rules: 'AGENTS.md', skills: 'skills' } },

  // IDE / VS Code-family — extension probes are precise. Cursor/Windsurf also
  // ship CLI binaries; we drop the dir fallback because the dir lingers after
  // uninstall and false-positives heavily.
  { id: 'cursor',     label: 'Cursor',              mech: 'native skill (per-repo rules)',  detect: 'command:cursor-agent||command:cursor||macapp:Cursor', native: { dir: '$HOME/.cursor', skills: 'skills', rules: null, hooks: { file: 'hooks.json', style: 'cursor' } } },
  { id: 'windsurf',   label: 'Windsurf',            mech: 'npx skills add (windsurf)',     detect: 'command:windsurf||macapp:Windsurf', profile: 'windsurf' },
  { id: 'cline',      label: 'Cline',               mech: 'npx skills add (cline)',        detect: 'vscode-ext:cline',        profile: 'cline' },
  { id: 'continue',   label: 'Continue',            mech: 'npx skills add (continue)',     detect: 'vscode-ext:continue.continue||vscode-ext:continue', profile: 'continue' },
  { id: 'kilo',       label: 'Kilo Code',           mech: 'npx skills add (kilo)',         detect: 'vscode-ext:kilocode', profile: 'kilo' },
  { id: 'roo',        label: 'Roo Code',            mech: 'npx skills add (roo)',          detect: 'vscode-ext:roo||vscode-ext:rooveterinaryinc.roo-cline||cursor-ext:roo', profile: 'roo' },
  { id: 'augment',    label: 'Augment Code',        mech: 'npx skills add (augment)',      detect: 'vscode-ext:augment||jetbrains-plugin:augment', profile: 'augment' },

  // GitHub Copilot — `gh` (GitHub CLI) is on most dev machines but isn't
  // Copilot. There's no reliable always-on Copilot probe (subscription state
  // is auth-gated). Mark soft → opt-in via --only copilot.
  { id: 'copilot',    label: 'GitHub Copilot',      mech: 'npx skills add (github-copilot)', detect: 'command:copilot', profile: 'github-copilot', soft: true },

  // CLI agents — require the binary. The `||dir:~/.foo` fallbacks were the
  // main source of false positives (warp, kiro, junie etc. leave config dirs
  // behind on uninstall).
  { id: 'aider-desk', label: 'Aider Desk',          mech: 'npx skills add (aider-desk)',   detect: 'command:aider', profile: 'aider-desk' },
  { id: 'amp',        label: 'Sourcegraph Amp',     mech: 'npx skills add (amp)',          detect: 'command:amp',             profile: 'amp' },
  { id: 'bob',        label: 'IBM Bob',             mech: 'npx skills add (bob)',          detect: 'command:bob', profile: 'bob' },
  { id: 'crush',      label: 'Crush',               mech: 'npx skills add (crush)',        detect: 'command:crush', profile: 'crush' },
  { id: 'devin',      label: 'Devin (terminal)',    mech: 'npx skills add (devin)',        detect: 'command:devin', profile: 'devin' },
  { id: 'droid',      label: 'Droid (Factory)',     mech: 'npx skills add (droid)',        detect: 'command:droid', profile: 'droid' },
  { id: 'forgecode',  label: 'ForgeCode',           mech: 'npx skills add (forgecode)',    detect: 'command:forge', profile: 'forgecode' },
  { id: 'goose',      label: 'Block Goose',         mech: 'npx skills add (goose)',        detect: 'command:goose', profile: 'goose' },
  { id: 'iflow',      label: 'iFlow CLI',           mech: 'npx skills add (iflow-cli)',    detect: 'command:iflow', profile: 'iflow-cli' },
  { id: 'kiro',       label: 'Kiro CLI',            mech: 'npx skills add (kiro-cli)',     detect: 'command:kiro', profile: 'kiro-cli' },
  { id: 'mistral',    label: 'Mistral Vibe',        mech: 'npx skills add (mistral-vibe)', detect: 'command:mistral', profile: 'mistral-vibe' },
  { id: 'openhands',  label: 'OpenHands',           mech: 'npx skills add (openhands)',    detect: 'command:openhands', profile: 'openhands' },
  { id: 'qwen',       label: 'Qwen Code',           mech: 'npx skills add (qwen-code)',    detect: 'command:qwen', profile: 'qwen-code' },
  { id: 'rovodev',    label: 'Atlassian Rovo Dev',  mech: 'npx skills add (rovodev)',      detect: 'command:rovodev', profile: 'rovodev' },
  { id: 'tabnine',    label: 'Tabnine CLI',         mech: 'npx skills add (tabnine-cli)',  detect: 'command:tabnine', profile: 'tabnine-cli' },
  { id: 'trae',       label: 'Trae',                mech: 'npx skills add (trae)',         detect: 'command:trae', profile: 'trae' },
  { id: 'warp',       label: 'Warp',                mech: 'npx skills add (warp)',         detect: 'command:warp', profile: 'warp' },
  { id: 'replit',     label: 'Replit Agent',        mech: 'npx skills add (replit)',       detect: 'command:replit', profile: 'replit' },

  // Soft (opt-in via --only) — no reliable always-on probe.
  // junie: ships only as a JetBrains plugin; jetbrains-plugin probe walks
  //   ~/.config/JetBrains looking for "junie" — fires on stale plugin caches.
  // qoder: dir-only.
  // antigravity: lives at ~/.gemini/antigravity which is created by the
  //   gemini CLI on first use — not a reliable signal of antigravity itself.
  { id: 'junie',      label: 'JetBrains Junie',     mech: 'npx skills add (junie)',        detect: 'jetbrains-plugin:junie', profile: 'junie', soft: true },
  { id: 'qoder',      label: 'Qoder',               mech: 'npx skills add (qoder)',        detect: 'dir:$HOME/.qoder', profile: 'qoder', soft: true },
  { id: 'antigravity',label: 'Google Antigravity',  mech: 'native AGENTS.md + skill',       detect: 'command:agy||dir:$HOME/.gemini/antigravity', native: { dir: '$HOME/.gemini/config', rules: 'AGENTS.md', skills: 'skills', hooks: { file: 'hooks.json', style: 'antigravity' } } },
];

// ── Detection ─────────────────────────────────────────────────────────────
function hasCmd(cmd) {
  try {
    if (process.platform === 'win32') {
      const r = child_process.spawnSync('where', [cmd], { stdio: 'ignore' });
      return r.status === 0;
    }
    const r = child_process.spawnSync('sh', ['-c', `command -v ${shellEscape(cmd)}`], { stdio: 'ignore' });
    return r.status === 0;
  } catch (_) { return false; }
}

function shellEscape(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function expandHome(p) { return p.replace(/^\$HOME/, os.homedir()).replace(/^~/, os.homedir()); }

function vscodeExtPresent(needle) {
  const home = os.homedir();
  const roots = [
    path.join(home, '.vscode/extensions'),
    path.join(home, '.vscode-server/extensions'),
    path.join(home, '.cursor/extensions'),
    path.join(home, '.windsurf/extensions'),
  ];
  const re = new RegExp(needle, 'i');
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    let entries;
    try { entries = fs.readdirSync(r); } catch (_) { continue; }
    if (entries.some(e => re.test(e))) return true;
  }
  return false;
}

function jetbrainsPluginPresent(needle) {
  const home = os.homedir();
  const roots = [
    path.join(home, 'Library/Application Support/JetBrains'),
    path.join(home, '.config/JetBrains'),
  ];
  const re = new RegExp(needle, 'i');
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    let names;
    try { names = fs.readdirSync(r, { recursive: true }); } catch (_) { continue; }
    if (names.some(p => re.test(path.basename(p)))) return true;
  }
  return false;
}

function macAppPresent(name) {
  if (process.platform !== 'darwin') return false;
  const candidates = [
    `/Applications/${name}.app`,
    path.join(os.homedir(), 'Applications', `${name}.app`),
  ];
  return candidates.some(p => fs.existsSync(p));
}

function detectMatch(spec) {
  if (!spec) return false;
  for (const clause of spec.split('||')) {
    const c = clause.trim();
    if (!c) continue;
    const colon = c.indexOf(':');
    const kind = colon === -1 ? c : c.slice(0, colon);
    const val  = colon === -1 ? '' : expandHome(c.slice(colon + 1));
    let ok = false;
    switch (kind) {
      case 'command':           ok = hasCmd(val); break;
      case 'dir':               ok = safeStat(val, 'isDirectory'); break;
      case 'macapp':            ok = macAppPresent(val); break;
      case 'vscode-ext':        ok = vscodeExtPresent(val); break;
      case 'jetbrains-plugin':  ok = jetbrainsPluginPresent(val); break;
    }
    if (ok) return true;
  }
  return false;
}

function safeStat(p, method) {
  try { return fs.statSync(p)[method](); } catch (_) { return false; }
}

// ── Repo root resolution ───────────────────────────────────────────────────
function detectRepoRoot() {
  // bin/install.js sits at <repo>/bin/install.js. Walk up one.
  const here = path.dirname(__filename);
  const root = path.resolve(here, '..');
  if (fs.existsSync(path.join(root, 'src', 'hooks')) &&
      fs.existsSync(path.join(root, 'agents')) &&
      fs.existsSync(path.join(root, 'skills'))) {
    return root;
  }
  return null;
}

// ── Run helpers ────────────────────────────────────────────────────────────
// On Windows, npm/npx/claude/gemini/codex etc. ship as `.cmd` batch shims.
// Node's spawnSync('claude', ...) returns ENOENT for these unless we either
// (a) set shell:true (cmd.exe respects PATHEXT) or
// (b) resolve the actual `.cmd` path before spawning.
// We pick (a) — simpler, fewer cross-version corner cases (and modern Node
// refuses to spawn .cmd/.bat shims with shell:false, CVE-2024-27980). Because
// cmd.exe parses & | < > ^ ( ) BEFORE the CRT argv split, we quote EVERY arg,
// not just ones with spaces: those metacharacters are literal inside double
// quotes, so quoting neutralizes command injection from an attacker-influenced
// path (e.g. process.cwd() = C:\dev\a&calc\TLDR). (%VAR% still expands inside
// quotes, but that substitutes a value — it does not execute a command.)
const IS_WIN = process.platform === 'win32';

function quoteWinArg(a) {
  if (!IS_WIN) return a;
  // Standard CommandLineToArgvW escaping, applied unconditionally.
  return '"' + String(a).replace(/\\(?=\\*"|$)/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function spawnXplat(cmd, args, opts) {
  if (IS_WIN) {
    const quoted = args.map(quoteWinArg).join(' ');
    return child_process.spawnSync(`${cmd} ${quoted}`, [], Object.assign({ shell: true }, opts || {}));
  }
  return child_process.spawnSync(cmd, args, opts || {});
}

function runSpawn(cmd, args, opts, dry) {
  if (dry) { process.stdout.write(`  would run: ${cmd} ${args.join(' ')}\n`); return { status: 0 }; }
  process.stdout.write(`  $ ${cmd} ${args.join(' ')}\n`);
  return spawnXplat(cmd, args, Object.assign({ stdio: 'inherit' }, opts || {}));
}

function captureSpawn(cmd, args) {
  try { return spawnXplat(cmd, args, { encoding: 'utf8' }); }
  catch (_) { return { status: 1, stdout: '', stderr: '' }; }
}

// ── Per-provider installers ────────────────────────────────────────────────
async function installClaude(ctx) {
  const { say, note, warn, ok, opts, results } = ctx;
  results.detected++;
  say('→ Claude Code detected');

  // Plugin install (idempotent unless --force)
  let alreadyInstalled = false;
  if (!opts.force) {
    const r = captureSpawn('claude', ['plugin', 'list']);
    if (r.status === 0 && /tldr/i.test(r.stdout || '')) alreadyInstalled = true;
  }
  if (alreadyInstalled) {
    note('  TLDR plugin already installed (use --force to reinstall)');
    results.skipped.push(['claude', 'plugin already installed']);
  } else {
    const r1 = runSpawn('claude', ['plugin', 'marketplace', 'add', REPO], null, opts.dryRun);
    const r2 = runSpawn('claude', ['plugin', 'install', 'tldr@tldr'], null, opts.dryRun);
    // Strict === 0: a spawn that never launched (ENOENT) yields status null, which
    // `(status || 0) === 0` wrongly coerced to success and reported "installed".
    if (r1.status === 0 && r2.status === 0) results.installed.push('claude');
    else results.failed.push(['claude', 'claude plugin install failed (CLI missing or errored)']);
  }

  if (opts.withHooks) {
    say('  → installing hooks (--with-hooks)');
    const r = await installHooks(ctx);
    if (r === 'ok') results.installed.push('claude-hooks');
    else if (r === 'skip') results.skipped.push(['claude-hooks', 'already wired']);
    else results.failed.push(['claude-hooks', r]);
  }

  if (opts.withMcpShrink) {
    say('  → wiring tldr-shrink MCP proxy (--with-mcp-shrink)');
    const r = installMcpShrink(ctx);
    if (r.kind === 'ok')   results.installed.push('tldr-shrink');
    if (r.kind === 'skip') results.skipped.push(['tldr-shrink', r.why]);
    if (r.kind === 'fail') results.failed.push(['tldr-shrink', r.why]);
  }

  process.stdout.write('\n');
}

function installGemini(ctx) {
  const { say, note, opts, results } = ctx;
  results.detected++;
  say('→ Gemini CLI detected');

  if (!opts.force) {
    const r = captureSpawn('gemini', ['extensions', 'list']);
    if (r.status === 0 && /tldr/i.test(r.stdout || '')) {
      note('  TLDR extension already installed (use --force to reinstall)');
      results.skipped.push(['gemini', 'extension already installed']);
      process.stdout.write('\n');
      return;
    }
  }
  const r = runSpawn('gemini', ['extensions', 'install', `https://github.com/${REPO}`], null, opts.dryRun);
  if ((r.status || 0) === 0) results.installed.push('gemini');
  else results.failed.push(['gemini', 'gemini extensions install failed']);
  process.stdout.write('\n');
}

function installViaSkills(ctx, prov) {
  const { say, opts, results } = ctx;
  results.detected++;
  say(`→ ${prov.label} detected`);
  // --yes --all: skip the upstream skill-selection TUI and confirmation prompts.
  // Without these, `curl|bash` (no TTY on stdin) renders an empty checkbox list
  // the user can't interact with, then exits 0 with zero skills installed —
  // and our installer happily reports success. See issue #370.
  // We've already decided which agent to install for via auto-detect / --only;
  // making the user re-select 7 skills inside skills CLI would be redundant.
  //
  // NOTE: `--all` expands to `--skill '*' --agent '*'`, which OVERRIDES `-a
  // <profile>` and fans the install out to every agent the skills CLI knows
  // (~50), into the shared ~/.agents store — not what a scoped, per-agent
  // install wants. Use `-s '*'` (all TLDR skills) + `-a <profile>` (this agent
  // only) + `-g` (user-global, not the CWD project store) instead.
  const args = ['-y', 'skills', 'add', REPO, '-a', prov.profile, '-s', '*', '-g', '--yes'];
  const r = runSpawn('npx', args, null, opts.dryRun);
  if ((r.status || 0) === 0) results.installed.push(prov.id);
  else results.failed.push([prov.id, `npx skills add (${prov.profile}) failed`]);
  process.stdout.write('\n');
}

// ── opencode native install ───────────────────────────────────────────────
// Drops the in-repo plugin (src/plugins/tldr-opencode/) plus skills, agents,
// commands, and an AGENTS.md ruleset into ~/.config/opencode/. Patches
// opencode.json with a "plugin" array entry. Mirrors the Claude Code hook
// architecture as closely as opencode allows — only the statusline is missing
// (opencode's TUI exposes no plugin-writable badge).
const OPENCODE_SKILL_DIRS  = ['tldr', 'tldr-commit', 'tldr-review', 'tldr-help', 'tldr-stats', 'tldr-compress', 'tldrcrew', 'tldr-update'];
const OPENCODE_AGENT_FILES = ['tldrcrew-investigator.md', 'tldrcrew-builder.md', 'tldrcrew-reviewer.md'];
const OPENCODE_COMMAND_FILES = ['tldr.md', 'tldr-commit.md', 'tldr-review.md', 'tldr-compress.md', 'tldr-stats.md', 'tldr-help.md', 'tldr-update.md'];
const OPENCODE_PLUGIN_REL = './plugins/tldr/plugin.js';
// Legacy sentinel from installs that pre-date the marker fence and the
// persona-register cleanup. Detection-only (idempotency + uninstall of old
// unfenced blocks) — never written to disk or emitted to the model.
const OPENCODE_AGENTS_MD_SENTINEL = 'Respond terse like smart TLDR';
// Marker fence for the opencode AGENTS.md ruleset block. Same convention as
// bin/lib/openclaw.js for SOUL.md — lets us strip our block cleanly even when
// the user has authored content above AND below it.
const OPENCODE_AGENTS_MD_BEGIN = '<!-- tldr-begin -->';
const OPENCODE_AGENTS_MD_END = '<!-- tldr-end -->';

function opencodeConfigDir() {
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'opencode');
  return path.join(os.homedir(), '.config', 'opencode');
}

// ── Shared AGENTS.md ruleset writer / stripper ────────────────────────────
// Write the fenced TLDR ruleset (src/rules/tldr-activate.md) into an agent's
// global AGENTS.md-style rules file. Preserves user content above and below the
// begin/end fence, is idempotent on the markers, and recognizes the legacy
// unfenced sentinel. Shared by installOpencode and installNativeAgentsMd
// (codex/pi/grok) so every AGENTS.md-convention agent uses one code path. The
// marker/sentinel constants are TLDR-generic (values `<!-- tldr-begin -->` …).
function writeFencedRuleset(agentsMd, repoRoot, opts, note) {
  const ruleBody = fs.readFileSync(path.join(repoRoot, 'src', 'rules', 'tldr-activate.md'), 'utf8').trimEnd() + '\n';
  // blockCore has NO trailing newline: the newline after the END marker belongs
  // to the surrounding file so an in-place replace can be byte-idempotent.
  const blockCore = `${OPENCODE_AGENTS_MD_BEGIN}\n${ruleBody}${OPENCODE_AGENTS_MD_END}`;
  const fencedBlock = blockCore + '\n';
  // atomicWrite (temp file + rename) replaces a planted symlink with a real
  // file instead of writing THROUGH it to an out-of-tree target.
  if (!fs.existsSync(agentsMd)) {
    atomicWrite(agentsMd, fencedBlock, 0o644);
    process.stdout.write(`  installed: ${agentsMd}\n`);
    return;
  }
  const existing = fs.readFileSync(agentsMd, 'utf8');
  const blocks = findFencedBlocks(existing, OPENCODE_AGENTS_MD_BEGIN, OPENCODE_AGENTS_MD_END);
  if (blocks.length > 0) {
    // UPSERT via nearest-preceding pairing: replace the LAST well-formed block,
    // drop earlier duplicates, and preserve ALL surrounding user text — including
    // an orphan BEGIN above the block. Byte-identical ⇒ no-op (idempotent), so an
    // upgrade refreshes a stale ruleset instead of leaving it behind.
    const next = upsertFencedBlock(existing, OPENCODE_AGENTS_MD_BEGIN, OPENCODE_AGENTS_MD_END, ruleBody);
    if (next === existing) {
      note(`  ${agentsMd} already contains the current TLDR ruleset`);
    } else {
      atomicWrite(agentsMd, next, 0o644);
      process.stdout.write(`  refreshed TLDR ruleset in ${agentsMd}\n`);
    }
    return;
  }
  // No well-formed block. Legacy unfenced sentinel handling — only when there is
  // no stray begin/end marker to confuse it.
  const hasStrayMarker = existing.includes(OPENCODE_AGENTS_MD_BEGIN) || existing.includes(OPENCODE_AGENTS_MD_END);
  if (!hasStrayMarker && existing.includes(OPENCODE_AGENTS_MD_SENTINEL)) {
    note(`  ${agentsMd} contains a legacy (un-fenced) TLDR block — leaving as-is`);
    note('  re-run with --force to replace it with a fenced block');
    if (opts.force) {
      atomicWrite(agentsMd, fencedBlock, 0o644);
      process.stdout.write(`  rewrote ${agentsMd} with fenced TLDR block\n`);
    }
    return;
  }
  // Malformed markers (end-before-begin, orphan begin/end) or plain user text:
  // append a fresh, well-formed block rather than skipping. upsertFencedBlock
  // appends when it finds no well-formed block, leaving stray markers intact.
  atomicWrite(agentsMd, upsertFencedBlock(existing, OPENCODE_AGENTS_MD_BEGIN, OPENCODE_AGENTS_MD_END, ruleBody), 0o644);
  process.stdout.write(`  appended TLDR ruleset to ${agentsMd}\n`);
}

// stripFencedBlocks / findFencedBlocks / upsertFencedBlock now live in
// bin/lib/fenced.js (one data-loss-safe implementation, shared with openclaw.js).

// Strip every fenced [beginMark..endMark] block from a file (nearest-preceding
// pairing), preserving user content. Deletes the file if only whitespace
// survives. Symlink-safe via atomicWrite. Returns true if it touched the file.
function stripFencedFile(filePath, beginMark, endMark, opts, note) {
  if (!fs.existsSync(filePath)) return false;
  const body = fs.readFileSync(filePath, 'utf8');
  const { text, removed } = stripFencedBlocks(body, beginMark, endMark);
  if (!removed) return false;
  let next = text.trimEnd();
  next = next ? next + '\n' : '';
  if (!opts.dryRun) {
    if (next === '') { try { fs.unlinkSync(filePath); } catch (_) {} }
    else atomicWrite(filePath, next, 0o644);
  }
  note(next === '' ? `  removed ${filePath}` : `  stripped TLDR block from ${filePath}`);
  return true;
}

// Remove the fenced TLDR block(s) from an AGENTS.md-style file, preserving user
// content above and below. Deletes the file if nothing else survives. Falls
// back to legacy unfenced-sentinel handling. Returns true if it touched a file.
function stripFencedRuleset(agentsMd, opts, note) {
  if (stripFencedFile(agentsMd, OPENCODE_AGENTS_MD_BEGIN, OPENCODE_AGENTS_MD_END, opts, note)) return true;
  // No well-formed fenced block — check the legacy unfenced sentinel.
  if (!fs.existsSync(agentsMd)) return false;
  const body = fs.readFileSync(agentsMd, 'utf8');
  if (body.includes(OPENCODE_AGENTS_MD_SENTINEL)) {
    if (body.trim() === '' || body.trim().startsWith(OPENCODE_AGENTS_MD_SENTINEL)) {
      if (!opts.dryRun) { try { fs.unlinkSync(agentsMd); } catch (_) {} }
      note(`  removed ${agentsMd}`);
    } else {
      note(`  left ${agentsMd} in place (legacy mixed content — strip TLDR block manually)`);
    }
    return true;
  }
  return false;
}

// ── Generic native install for AGENTS.md-convention agents ────────────────
// For agents that auto-load a global AGENTS.md and auto-discover skills from a
// directory. Writes the fenced ruleset into <dir>/<rules> (skipped when
// rules:null) and copies the full TLDR skill suite (OPENCODE_SKILL_DIRS) into
// <dir>/<skills>/<name>/. Driven by a provider's `native` config. Used by codex
// (~/.codex), pi (~/.pi/agent), grok (~/.grok), antigravity (~/.gemini/config),
// omp (~/.omp/agent), and cursor (~/.cursor, skill-only). Needs a local clone.
// ── Native-agent hook wiring ──────────────────────────────────────────────
// Codex, Cursor, Grok and Antigravity all ship real hook systems. We copy the
// hook scripts to <dir>/hooks/tldr/ — two levels under the agent's skills dir,
// so tldr-activate.js's `../../skills/tldr/SKILL.md` lookup resolves to the
// skill suite we just installed — then merge our entries into the agent's hook
// config, preserving anything the user or another tool already put there.
const AGENT_HOOK_SCRIPTS = ['package.json', 'tldr-config.js', 'tldr-activate.js', 'tldr-mode-tracker.js', 'tldrcrew-model-overrides.js'];

function installAgentHooks(ctx, prov, dir) {
  const { note, warn, opts, repoRoot } = ctx;
  const h = prov.native && prov.native.hooks;
  if (!h) return;

  const hooksDir = path.join(dir, 'hooks', 'tldr');
  const cfgPath = path.join(dir, h.file);
  const q = (p) => JSON.stringify(p);
  const activate = `${q(process.execPath)} ${q(path.join(hooksDir, 'tldr-activate.js'))} --config-dir=${q(dir)}` +
                   (h.style === 'claude' ? '' : ` --format=${h.style}`);
  const tracker = `${q(process.execPath)} ${q(path.join(hooksDir, 'tldr-mode-tracker.js'))} --config-dir=${q(dir)}`;

  if (opts.dryRun) {
    note(`  would install ${AGENT_HOOK_SCRIPTS.length} hook scripts into ${hooksDir}/`);
    note(`  would merge TLDR hooks into ${cfgPath}`);
    if (h.trust) note(`  ${h.trust}`);
    return;
  }

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    for (const f of AGENT_HOOK_SCRIPTS) {
      const src = path.join(repoRoot, 'src', 'hooks', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(hooksDir, f));
    }

    let existing = {};
    if (fs.existsSync(cfgPath)) {
      try { existing = JSON.parse(SETTINGS.stripJsonComments(fs.readFileSync(cfgPath, 'utf8'))) || {}; }
      catch (e) {
        warn(`  ${cfgPath} is not valid JSON; leaving it alone (hooks not wired)`);
        return;
      }
      // First-install backup only — repeat runs must not overwrite the only
      // known-good copy with an already-merged file. COPYFILE_EXCL refuses a
      // pre-existing destination, including a planted symlink.
      const bak = cfgPath + '.bak';
      if (!fs.existsSync(bak)) {
        try { fs.copyFileSync(cfgPath, bak, fs.constants.COPYFILE_EXCL); } catch (_) {}
      }
    }

    let next;
    if (h.style === 'cursor')           next = AGENT_HOOKS.buildCursorStyle(existing, activate);
    else if (h.style === 'antigravity') next = AGENT_HOOKS.buildAntigravityStyle(existing, activate);
    else                                next = AGENT_HOOKS.buildClaudeStyle(existing, activate, tracker);

    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    atomicWrite(cfgPath, JSON.stringify(next, null, 2) + '\n', 0o644);
    process.stdout.write(`  hooks wired in ${cfgPath}\n`);
    if (h.trust) note(`  ${h.trust}`);
  } catch (e) {
    warn(`  hook wiring failed for ${prov.label}: ` + ((e && e.message) || e));
  }
}

function installNativeAgentsMd(ctx, prov) {
  const { say, note, warn, opts, repoRoot, results } = ctx;
  results.detected++;
  say(`→ ${prov.label} detected`);
  const n = prov.native;
  const dir = expandHome(n.dir);
  // `rules: null` means the agent has NO global always-on rules file (e.g.
  // cursor-agent, which only honors per-project AGENTS.md/.cursor/rules); we
  // still install the auto-discovered skills and point users at --with-init.
  const rulesFile = n.rules === null ? null : path.join(dir, n.rules || 'AGENTS.md');
  const skillsDir = path.join(dir, n.skills || 'skills');
  const noRulesNote = n.hooks
    ? '  no global rules file for this agent — always-on delivered via its sessionStart hook instead'
    : '  no global always-on rules file for this agent — skills installed; use --with-init for a per-repo rule file';

  if (!repoRoot) {
    warn(`  ${prov.label} native install requires a local clone of the TLDR repo.`);
    note('  Re-run from a clone: git clone https://github.com/' + REPO + ' && cd TLDR && node bin/install.js --only ' + prov.id);
    results.failed.push([prov.id, 'native install requires local repo clone']);
    process.stdout.write('\n');
    return;
  }
  if (opts.dryRun) {
    if (rulesFile) note(`  would write fenced TLDR ruleset to ${rulesFile}`);
    else note(noRulesNote);
    note(`  would copy ${OPENCODE_SKILL_DIRS.length} skill dirs into ${skillsDir}/`);
    if (opts.withHooks) installAgentHooks(ctx, prov, dir);
    results.installed.push(prov.id);
    process.stdout.write('\n');
    return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Full TLDR skill suite (same canonical list opencode/hermes ship) so native
    // agents auto-discover all skills, not just skills/tldr. Per-skill skip
    // (unless --force) mirrors the opencode loop.
    const skillSrcDir = path.join(repoRoot, 'skills');
    for (const name of OPENCODE_SKILL_DIRS) {
      const src = path.join(skillSrcDir, name);
      const dest = path.join(skillsDir, name);
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dest) && !opts.force) { note(`  skipped ${dest}/ (exists; --force to overwrite)`); continue; }
      fs.cpSync(src, dest, { recursive: true });
      process.stdout.write(`  installed: ${dest}/\n`);
    }
    if (rulesFile) writeFencedRuleset(rulesFile, repoRoot, opts, note);
    else note(noRulesNote);
    if (opts.withHooks) installAgentHooks(ctx, prov, dir);
    results.installed.push(prov.id);
  } catch (e) {
    warn(`  ${prov.label} install failed: ` + (e && e.message || e));
    results.failed.push([prov.id, (e && e.message) || 'unknown error']);
  }
  process.stdout.write('\n');
}

function installOpencode(ctx) {
  const { say, note, warn, opts, repoRoot, results } = ctx;
  results.detected++;
  say('→ opencode detected');

  if (!repoRoot) {
    warn('  opencode native install requires a local clone of the TLDR repo.');
    note('  Re-run from a clone: git clone https://github.com/' + REPO + ' && cd TLDR && node bin/install.js --only opencode');
    results.failed.push(['opencode', 'native install requires local repo clone']);
    process.stdout.write('\n');
    return;
  }

  const dir = opencodeConfigDir();
  const pluginDir   = path.join(dir, 'plugins', 'tldr');
  const commandsDir = path.join(dir, 'commands');
  const agentsDir   = path.join(dir, 'agents');
  const skillsDir   = path.join(dir, 'skills');
  // opencode reads EITHER opencode.json OR opencode.jsonc. Patch whichever the
  // user already has so we never create a second, competing config file that
  // shadows theirs. Prefer an existing .jsonc; otherwise use/create .json.
  const opencodeJsonc  = path.join(dir, 'opencode.jsonc');
  const opencodeJsonP  = path.join(dir, 'opencode.json');
  const opencodeJson = (fs.existsSync(opencodeJsonc) && !fs.existsSync(opencodeJsonP))
    ? opencodeJsonc : opencodeJsonP;
  const agentsMd     = path.join(dir, 'AGENTS.md');

  if (opts.dryRun) {
    note(`  would mkdir ${pluginDir}/, ${commandsDir}/, ${agentsDir}/, ${skillsDir}/`);
    note(`  would copy plugin.js + package.json + tldr-config.cjs into ${pluginDir}/`);
    note(`  would copy ${OPENCODE_COMMAND_FILES.length} command files into ${commandsDir}/`);
    note(`  would copy ${OPENCODE_AGENT_FILES.length} tldrcrew agents into ${agentsDir}/`);
    note(`  would copy ${OPENCODE_SKILL_DIRS.length} skill dirs into ${skillsDir}/`);
    note(`  would patch ${opencodeJson} with "plugin" entry${opts.withMcpShrink ? ' + tldr-shrink MCP' : ''}`);
    note(`  would write Tier-3 ruleset to ${agentsMd}`);
    results.installed.push('opencode');
    process.stdout.write('\n');
    return;
  }

  try {
    // 1. Plugin dir — copy plugin.js, package.json, tldr-config.js (sibling).
    //    Same `--force` semantic as commands/agents/skills below: re-runs leave
    //    user edits to plugin.js alone unless --force is passed.
    fs.mkdirSync(pluginDir, { recursive: true });
    const pluginSrc = path.join(repoRoot, 'src', 'plugins', 'tldr-opencode');
    const pluginPayload = [
      [path.join(pluginSrc, 'plugin.js'),    path.join(pluginDir, 'plugin.js')],
      [path.join(pluginSrc, 'package.json'), path.join(pluginDir, 'package.json')],
      // Renamed to .cjs because the plugin dir is "type": "module" — a bare .js
      // sibling would be loaded as ESM and break the plugin's require() bridge.
      [path.join(repoRoot, 'src', 'hooks', 'tldr-config.js'),
       path.join(pluginDir, 'tldr-config.cjs')],
    ];
    for (const [src, dest] of pluginPayload) {
      if (fs.existsSync(dest) && !opts.force) {
        note(`  skipped ${dest} (exists; --force to overwrite)`);
        continue;
      }
      fs.copyFileSync(src, dest);
    }
    process.stdout.write(`  installed: ${pluginDir}\n`);

    // 2. Commands.
    fs.mkdirSync(commandsDir, { recursive: true });
    const cmdSrcDir = path.join(pluginSrc, 'commands');
    for (const f of OPENCODE_COMMAND_FILES) {
      const src = path.join(cmdSrcDir, f);
      const dest = path.join(commandsDir, f);
      if (fs.existsSync(dest) && !opts.force) { note(`  skipped ${dest} (exists; --force to overwrite)`); continue; }
      fs.copyFileSync(src, dest);
      process.stdout.write(`  installed: ${dest}\n`);
    }

    // 3. Subagents.
    fs.mkdirSync(agentsDir, { recursive: true });
    const agentSrcDir = path.join(repoRoot, 'agents');
    for (const f of OPENCODE_AGENT_FILES) {
      const src = path.join(agentSrcDir, f);
      const dest = path.join(agentsDir, f);
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dest) && !opts.force) { note(`  skipped ${dest} (exists; --force to overwrite)`); continue; }
      fs.writeFileSync(dest, stripOpencodeAgentTools(fs.readFileSync(src, 'utf8')));
      process.stdout.write(`  installed: ${dest}\n`);
    }

    // 4. Skills — opencode auto-discovers SKILL.md from ~/.config/opencode/skills/.
    fs.mkdirSync(skillsDir, { recursive: true });
    const skillSrcDir = path.join(repoRoot, 'skills');
    for (const name of OPENCODE_SKILL_DIRS) {
      const src = path.join(skillSrcDir, name);
      const dest = path.join(skillsDir, name);
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dest) && !opts.force) { note(`  skipped ${dest}/ (exists; --force to overwrite)`); continue; }
      fs.cpSync(src, dest, { recursive: true });
      process.stdout.write(`  installed: ${dest}/\n`);
    }

    // 5. AGENTS.md — Tier-3 always-on ruleset (fenced so --uninstall can strip
    //    it cleanly even amid user content above/below). Shared writer.
    writeFencedRuleset(agentsMd, repoRoot, opts, note);

    // 6. opencode.json — add plugin entry; optional tldr-shrink MCP.
    let cfg = SETTINGS.readSettings(opencodeJson);
    if (cfg === null) {
      warn(`  ${opencodeJson} unparseable; will not touch it. Edit manually then re-run.`);
      results.failed.push(['opencode', 'opencode.json unparseable']);
      process.stdout.write('\n');
      return;
    }
    // Preserve the original on first install only — repeat installs would
    // otherwise overwrite the only known-good copy with an already-merged file.
    const opencodeBak = opencodeJson + '.bak';
    if (fs.existsSync(opencodeJson) && !fs.existsSync(opencodeBak)) {
      // COPYFILE_EXCL fails (EEXIST) on any pre-existing destination, including
      // a planted symlink, so the backup never follows/clobbers a link target.
      try { fs.copyFileSync(opencodeJson, opencodeBak, fs.constants.COPYFILE_EXCL); } catch (_) {}
    }
    if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
    if (!cfg.plugin.includes(OPENCODE_PLUGIN_REL)) {
      cfg.plugin.push(OPENCODE_PLUGIN_REL);
    }
    if (opts.withMcpShrink) {
      // opts.withMcpShrink is the array of upstream-cmd tokens parseArgs
      // produced. tldr-shrink is a proxy — it exits without an upstream.
      if (!cfg.mcp || typeof cfg.mcp !== 'object') cfg.mcp = {};
      if (!cfg.mcp['tldr-shrink']) {
        const launch = resolveMcpShrinkLaunch(repoRoot);
        if (!launch) {
          warn('  tldr-shrink unavailable (npm + local path both missing); skipped MCP wiring');
        } else {
          cfg.mcp['tldr-shrink'] = {
            type: 'local',
            command: [...launch, ...opts.withMcpShrink],
            enabled: true,
          };
          process.stdout.write(`  registered tldr-shrink MCP server (wraps: ${opts.withMcpShrink.join(' ')})\n`);
        }
      }
    }
    SETTINGS.writeSettings(opencodeJson, cfg);
    process.stdout.write(`  patched: ${opencodeJson}\n`);

    results.installed.push('opencode');
  } catch (e) {
    warn('  opencode install failed: ' + (e && e.message || e));
    results.failed.push(['opencode', (e && e.message) || 'unknown error']);
  }
  process.stdout.write('\n');
}

// ── OpenClaw native install ───────────────────────────────────────────────
// Drops skills/tldr/ into the OpenClaw workspace and appends a small
// auto-injected bootstrap block to the workspace SOUL.md. Always-on behavior
// comes from SOUL.md (auto-injected each turn); the skill folder makes
// TLDR discoverable via `openclaw skills list`. See bin/lib/openclaw.js
// for the actual file writes.
function installOpenclaw(ctx) {
  const { say, note, warn, opts, repoRoot, results } = ctx;
  results.detected++;
  say('→ OpenClaw detected');

  const log = {
    write: (s) => process.stdout.write(s),
    note: (s) => note(s),
    warn: (s) => warn(s),
  };

  const r = OPENCLAW.installOpenclaw({
    workspace: process.env.OPENCLAW_WORKSPACE || undefined,
    repoRoot,
    dryRun: opts.dryRun,
    force: opts.force,
    log,
  });

  if (r.ok) results.installed.push('openclaw');
  else results.failed.push(['openclaw', r.reason || 'install failed']);

  process.stdout.write('\n');
}

// ── Hermes Agent native install ─────────────────────────────────────────────
// Hermes reads its live instructions from <HERMES_HOME>/SOUL.md (default
// ~/.hermes/SOUL.md). We MERGE the TLDR ruleset (TLDR.md) into SOUL.md between
// managed markers — the SAME markers the prompt-only `install.sh --with-hermes`
// path uses — so both installers converge on one file, stay idempotent against
// each other, and never double-insert. Uninstall strips exactly the marked
// block, preserving any user-authored content above and below.
//
// Interop note: install.sh honors only $HOME/.hermes; we additionally respect
// HERMES_HOME (matches the full-installer convention and makes the path
// testable). When HERMES_HOME is unset both resolve to ~/.hermes, so real-world
// default installs remain byte-interoperable via the shared markers.
const HERMES_MARK_BEGIN = '<!-- TLDR.MD START -->';
const HERMES_MARK_END = '<!-- TLDR.MD END -->';

function hermesConfigDir() {
  return process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
}

function hermesSoulPath() {
  return path.join(hermesConfigDir(), 'SOUL.md');
}

function hermesSkillsRoot() {
  return path.join(hermesConfigDir(), 'skills', 'productivity');
}

function resolveHermesSkillSrc(repoRoot, skillDir) {
  const primary = path.join(repoRoot, 'skills', skillDir);
  return fs.existsSync(primary) ? primary : null;
}

// The managed block body is TLDR.md (repo root) — the same source install.sh
// resolves as PROMPT_PATH. Returns null when there's no local clone on disk.
function loadHermesRuleset(repoRoot) {
  if (!repoRoot) return null;
  try { return fs.readFileSync(path.join(repoRoot, 'TLDR.md'), 'utf8'); }
  catch (_) { return null; }
}

// Compute the next SOUL.md contents for an install. Mirrors the merge algorithm
// in install.sh's `install_hermes` python block, but always wraps the ruleset
// in the managed markers (install.sh writes raw on a fresh file) so our own
// --uninstall can strip cleanly. Idempotency uses the same `promptBody in text`
// short-circuit as install.sh, so it also recognizes install.sh's raw write.
function mergeHermesSoul(existing, promptText) {
  const promptBody = promptText.replace(/\n+$/, '');           // python rstrip("\n")
  const managed = `${HERMES_MARK_BEGIN}\n${promptBody}\n${HERMES_MARK_END}`;

  if (existing === null || existing.trim() === '') {
    return { action: 'installed', text: managed + '\n' };
  }
  if (existing.includes(promptBody)) {
    return { action: 'unchanged', text: null };
  }
  const begin = existing.indexOf(HERMES_MARK_BEGIN);
  const end = existing.indexOf(HERMES_MARK_END);
  if (begin !== -1 && end !== -1 && begin < end) {
    const before = existing.slice(0, begin);
    const after = existing.slice(end + HERMES_MARK_END.length);
    let next = before.replace(/\s+$/, '') + '\n\n' + managed;   // before.rstrip()
    if (after.trim()) next += '\n\n' + after.replace(/^\n+/, ''); // after.lstrip("\n")
    else next += '\n';
    return { action: 'updated', text: next };
  }
  return { action: 'merged', text: existing.replace(/\s+$/, '') + '\n\n' + managed + '\n' };
}

function installHermes(ctx) {
  const { say, note, warn, opts, repoRoot, results } = ctx;
  results.detected++;
  say('→ Hermes Agent detected');

  const promptText = loadHermesRuleset(repoRoot);
  if (!promptText) {
    warn('  Hermes native install requires a local clone of the TLDR repo (TLDR.md missing).');
    note('  Re-run from a clone: git clone https://github.com/' + REPO + ' && cd TLDR && node bin/install.js --only hermes');
    results.failed.push(['hermes', 'native install requires local repo clone']);
    process.stdout.write('\n');
    return;
  }

  const soul = hermesSoulPath();
  const skillsRoot = hermesSkillsRoot();

  if (opts.dryRun) {
    note(`  would merge TLDR.md ruleset into ${soul}`);
    note(`  (between ${HERMES_MARK_BEGIN} / ${HERMES_MARK_END} markers)`);
    note(`  would mkdir ${skillsRoot}/`);
    note(`  would copy ${HERMES_SKILL_DIRS.length} skill dirs into ${skillsRoot}/`);
    results.installed.push('hermes');
    process.stdout.write('\n');
    return;
  }

  try {
    const existing = fs.existsSync(soul) ? fs.readFileSync(soul, 'utf8') : null;
    const r = mergeHermesSoul(existing, promptText);
    if (r.action === 'unchanged') {
      note(`  ${soul} already contains the current TLDR ruleset`);
    } else {
      // atomicWrite (temp + rename) replaces a planted symlink with a real file
      // instead of following it and writing THROUGH to an out-of-tree target.
      atomicWrite(soul, r.text, 0o644);
      process.stdout.write(`  ${r.action}: ${soul}\n`);
    }

    // Also copy the TLDR skill suite into ~/.hermes/skills/productivity/
    // (same pattern as caveman HERMES_SKILL_DIRS).
    fs.mkdirSync(skillsRoot, { recursive: true });
    for (const skillDir of HERMES_SKILL_DIRS) {
      const srcDir = resolveHermesSkillSrc(repoRoot, skillDir);
      const destDir = path.join(skillsRoot, skillDir);
      if (srcDir) {
        if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
        fs.cpSync(srcDir, destDir, { recursive: true });
        note(`  copied ${skillDir} → ${destDir}`);
      } else {
        warn(`  skill dir not found: skills/${skillDir}`);
      }
    }

    results.installed.push('hermes');
  } catch (e) {
    warn('  hermes install failed: ' + (e && e.message || e));
    results.failed.push(['hermes', (e && e.message) || 'unknown error']);
  }
  process.stdout.write('\n');
}

// ── Hooks installer ────────────────────────────────────────────────────────
// Replaces src/hooks/install.sh + src/hooks/install.ps1.
async function installHooks(ctx) {
  const { note, warn, opts, repoRoot, configDir } = ctx;
  const hooksDir = path.join(configDir, 'hooks');
  const settingsPath = path.join(configDir, 'settings.json');
  const sourceDir = repoRoot ? path.join(repoRoot, 'src', 'hooks') : null;

  if (opts.dryRun) {
    note(`  would mkdir -p ${hooksDir}`);
    for (const f of HOOK_FILES) note(`  would install ${path.join(hooksDir, f)}`);
    note(`  would merge SessionStart + UserPromptSubmit + statusline into ${settingsPath}`);
    return 'ok';
  }

  // All file + settings writes below can throw ENOENT/EACCES/EROFS on a
  // read-only or otherwise unwritable config dir. Wrap them so we return a
  // clean failure message (recorded by the caller) instead of dumping a raw
  // stack trace and aborting the whole multi-agent run.
  let settings;
  try {
    fs.mkdirSync(hooksDir, { recursive: true });

    // Copy or download each hook file. Local-clone-first for offline installs.
    // Downloaded files (the rare detached-script / curl fallback) are verified
    // against the SHA-256 manifest published alongside them
    // (src/hooks/checksums.sha256); a mismatch aborts before the file is wired
    // into settings.json. Local copies are trusted — they come from the same
    // clone as this script.
    let checksums; // undefined = not yet loaded; null = unavailable
    let warnedNoChecksums = false;
    for (const f of HOOK_FILES) {
      const dest = path.join(hooksDir, f);
      if (sourceDir && fs.existsSync(path.join(sourceDir, f))) {
        fs.copyFileSync(path.join(sourceDir, f), dest);
      } else {
        try { await downloadTo(`${HOOKS_REMOTE}/${f}`, dest); }
        catch (e) { return `download ${f} failed: ${e.message}`; }
        if (checksums === undefined) checksums = await loadRemoteHookChecksums();
        if (checksums) {
          const want = checksums.get(f);
          const got = sha256File(dest);
          if (!want || want !== got) {
            try { fs.unlinkSync(dest); } catch (_) {}
            return `integrity check failed for ${f} (expected ${want || '<not in manifest>'}, got ${got}) — ` +
                   `refusing to install a hook that does not match the published manifest`;
          }
        } else if (!warnedNoChecksums) {
          warnedNoChecksums = true;
          warn('  note: integrity manifest unavailable — downloaded hooks installed unverified.');
        }
      }
      process.stdout.write(`  installed: ${dest}\n`);
    }

    // chmod statusline (no-op on Windows)
    try { fs.chmodSync(path.join(hooksDir, 'tldr-statusline.sh'), 0o755); } catch (_) {}

    // Merge into settings.json
    settings = SETTINGS.readSettings(settingsPath);
    if (settings === null) {
      warn('  settings.json unparseable; will not touch it. Edit manually then re-run.');
      return 'settings.json unparseable';
    }
    // A valid-JSON but non-object root (array / bare string / number) can't
    // carry a hooks map. Leave it untouched rather than crash the run.
    if (Array.isArray(settings) || typeof settings !== 'object') {
      warn('  settings.json is not a JSON object; leaving it untouched.');
      return 'settings.json is not a JSON object';
    }
    // Backup once, preserved across reinstalls. Without the !fs.existsSync(bak)
    // guard, the second install would overwrite the only known-good copy with
    // the already-merged file, destroying recovery.
    const bak = settingsPath + '.bak';
    if (fs.existsSync(settingsPath) && !fs.existsSync(bak)) {
      // COPYFILE_EXCL: refuse a pre-existing destination (incl. a planted
      // symlink) instead of following it and clobbering the link target.
      try { fs.copyFileSync(settingsPath, bak, fs.constants.COPYFILE_EXCL); } catch (_) {}
    }

    const node = process.execPath;
    const activate = path.join(hooksDir, 'tldr-activate.js');
    const tracker  = path.join(hooksDir, 'tldr-mode-tracker.js');
    const statusline = path.join(hooksDir, 'tldr-statusline.sh');

    // Migrate any legacy bare-`node` invocations of our managed scripts.
    SETTINGS.rewriteLegacyManagedHookCommands(settings, node);

    SETTINGS.addCommandHook(settings, 'SessionStart', {
      command: `"${node}" "${activate}"`,
      marker: 'tldr-activate',
      timeout: 5,
      statusMessage: 'Loading tldr mode...',
    });

    SETTINGS.addCommandHook(settings, 'UserPromptSubmit', {
      command: `"${node}" "${tracker}"`,
      marker: 'tldr-mode-tracker',
      timeout: 5,
      statusMessage: 'Tracking tldr mode...',
    });

    // Statusline — set if absent or already pointing at our script.
    // Windows: prefer pwsh (PowerShell 7+, cross-platform), fall back to
    // powershell.exe (Windows PowerShell 5.1, ships with every Windows install).
    // Use -ExecutionPolicy Bypass so users without RemoteSigned policy can run.
    const psHost = IS_WIN && hasCmd('pwsh') ? 'pwsh' : (IS_WIN ? 'powershell' : null);
    const slCmd = IS_WIN
      ? `${psHost} -NoProfile -ExecutionPolicy Bypass -File "${path.join(hooksDir, 'tldr-statusline.ps1')}"`
      : `bash "${statusline}"`;
    if (!settings.statusLine) {
      settings.statusLine = { type: 'command', command: slCmd };
      process.stdout.write('  statusline badge configured.\n');
    } else {
      const existing = typeof settings.statusLine === 'string'
        ? settings.statusLine
        : (settings.statusLine.command || '');
      if (existing.includes(statusline) || existing.includes('tldr-statusline')) {
        process.stdout.write('  statusline badge already configured.\n');
      } else {
        process.stdout.write('  NOTE: existing statusline detected — TLDR badge NOT added.\n');
        process.stdout.write('        See src/hooks/README.md to add the badge to your existing statusline.\n');
      }
    }

    // Defensive validation before write — Claude Code Zod will discard the
    // entire settings.json if any single hook is malformed (#249-class footgun).
    SETTINGS.validateHookFields(settings, warn);
    SETTINGS.writeSettings(settingsPath, settings);
    process.stdout.write(`  hooks wired in ${settingsPath}\n`);
    return 'ok';
  } catch (e) {
    warn('  hook install failed: ' + ((e && e.message) || e));
    return `hook install failed: ${(e && e.message) || 'unknown error'}`;
  }
}

// ── MCP shrink wiring ─────────────────────────────────────────────────────
// Prefer published scoped package via npx; fall back to in-repo index.js when
// `npm view` fails (unpublished / air-gapped clone). Returns argv prefix
// (without upstream tokens), or null when neither is available.
function resolveMcpShrinkLaunch(repoRoot) {
  const probe = captureSpawn('npm', ['view', MCP_SHRINK_PKG, 'name']);
  if (probe.status === 0) return ['npx', '-y', MCP_SHRINK_PKG];
  const local = repoRoot && path.join(repoRoot, MCP_SHRINK_LOCAL);
  if (local && fs.existsSync(local)) return [process.execPath, local];
  return null;
}

function installMcpShrink(ctx) {
  const { note, warn, opts, repoRoot } = ctx;
  const launch = resolveMcpShrinkLaunch(repoRoot);
  if (!launch) {
    warn(`    'npm view ${MCP_SHRINK_PKG}' failed and local ${MCP_SHRINK_LOCAL} missing.`);
    note('    Skipping registration. Re-run --with-mcp-shrink from a clone, or publish the package.');
    return { kind: 'skip', why: 'tldr-shrink not available (npm + local)' };
  }
  if (launch[0] !== 'npx') {
    note(`    npm package unavailable — using local ${MCP_SHRINK_LOCAL}`);
  }
  // Detect modern `claude mcp add`
  const help = captureSpawn('claude', ['mcp', '--help']);
  if (help.status !== 0) {
    note("    'claude mcp add' not available on this CLI. Add the snippet from");
    note('    src/hooks/README.md to your Claude Code MCP config manually.');
    return { kind: 'skip', why: 'manual config required' };
  }
  // opts.withMcpShrink is always an array of upstream-cmd tokens by the
  // time we get here; parseArgs rejects bare --with-mcp-shrink.
  const upstream = opts.withMcpShrink;
  const r = runSpawn(
    'claude',
    ['mcp', 'add', 'tldr-shrink', '--', ...launch, ...upstream],
    null, opts.dryRun
  );
  if ((r.status || 0) === 0) {
    note(`    registered, wrapping: ${upstream.join(' ')}`);
    note(`    Edit ~/.claude.json mcpServers["tldr-shrink"] to change the upstream,`);
    note('    or `claude mcp remove tldr-shrink` to drop it.');
    note(`    Docs: https://github.com/${REPO}/tree/main/src/mcp-servers/tldr-shrink`);
    return { kind: 'ok' };
  }
  return { kind: 'fail', why: 'claude mcp add failed' };
}

// ── Init writers (per-repo rule files) ────────────────────────────────────
async function runInit(ctx) {
  const { note, warn, opts, repoRoot } = ctx;
  const local = repoRoot && path.join(repoRoot, 'src/tools/tldr-init.js');
  const args = [process.cwd()];
  if (opts.dryRun) args.push('--dry-run');
  if (opts.force)  args.push('--force');
  if (local && fs.existsSync(local)) {
    const r = runSpawn(process.execPath, [local, ...args], null, opts.dryRun);
    return (r.status || 0) === 0;
  }
  // Curl-pipe fallback
  if (opts.dryRun) {
    note(`  would download ${INIT_SCRIPT_URL} and run it on ${process.cwd()}`);
    return true;
  }
  try {
    const tmpDir = createSecureTempDir('tldr-init-');
    const tmpFile = path.join(tmpDir, 'tldr-init.js');
    await downloadTo(INIT_SCRIPT_URL, tmpFile);
    const r = child_process.spawnSync(process.execPath, [tmpFile, ...args], { stdio: 'inherit' });
    try {
      fs.unlinkSync(tmpFile);
      safeRmdir(tmpDir);
    } catch (_) {}
    return (r.status || 0) === 0;
  } catch (e) {
    warn('  ' + e.message);
    return false;
  }
}

// ── HTTPS download via stdlib ─────────────────────────────────────────────
// Strict host allowlist — enforced on the initial URL and on every redirect hop.
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'raw.githubusercontent.com',
  'github.com',
]);

function assertDownloadUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(u.hostname)) {
    throw new Error(`Refusing download from untrusted URL: ${url}`);
  }
  return url;
}

async function downloadTo(url, dest, redirects = 3) {
  assertDownloadUrl(url);

  const buf = await fetchCapped(url, redirects);
  fs.writeFileSync(dest, buf);
}

// Fetch with the same limits the curl/https pair used to enforce separately:
// 512 KiB hard cap, 30s timeout, max 3 redirects. Redirects are followed
// MANUALLY so every hop re-enters downloadTo's host/protocol allowlist — a
// redirect cannot walk us off ALLOWED_DOWNLOAD_HOSTS.
async function fetchCapped(url, redirects = 3) {
  const MAX_BYTES = 512 * 1024; // hook files and manifests are tiny
  const res = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });

  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc || redirects <= 0) throw new Error(`Too many redirects for ${url}`);
    return fetchCapped(assertDownloadUrl(new URL(loc, url).href), redirects - 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  const chunks = [];
  let received = 0;
  for await (const chunk of res.body) {
    received += chunk.length;
    if (received > MAX_BYTES) throw new Error(`Download size limit exceeded for ${url}`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ── Integrity verification for downloaded hooks ─────────────────────────────
function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// Download + parse the hook integrity manifest published next to the hook
// files. Returns Map<basename, sha256hex>, or null when the manifest is
// unavailable — the caller treats null as "cannot verify" and warns rather
// than aborting, for back-compat with checkouts that predate the manifest.
// Parses the standard `sha256sum` text format: "<64-hex>  <path>" (two
// spaces, or " *<path>" binary marker).
async function loadRemoteHookChecksums() {
  try {
    const url = assertDownloadUrl(`${HOOKS_REMOTE}/checksums.sha256`);
    const txt = (await fetchCapped(url)).toString('utf8');
    const map = new Map();
    for (const line of txt.split('\n')) {
      const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
      if (m) map.set(path.basename(m[2].trim()), m[1].toLowerCase());
    }
    return map.size ? map : null;
  } catch (_) {
    return null;
  }
}

// ── Uninstall ─────────────────────────────────────────────────────────────
function uninstall(ctx) {
  const { say, note, warn, ok, opts, configDir } = ctx;
  say('🦉 TLDR uninstall');

  if (opts.dryRun) note('  (dry run — nothing will be removed)');

  // Hooks: remove from settings.json + delete hook files.
  const hooksDir = path.join(configDir, 'hooks');
  const settingsPath = path.join(configDir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    const settings = SETTINGS.readSettings(settingsPath);
    if (settings) {
      let removed = 0;
      for (const marker of ['tldr-activate', 'tldr-mode-tracker', 'tldr-stats']) {
        removed += SETTINGS.removeTldrHooks(settings, marker);
      }
      // Drop our statusline if it points at our script
      if (settings.statusLine) {
        const cmd = typeof settings.statusLine === 'string' ? settings.statusLine : (settings.statusLine.command || '');
        if (cmd.includes('tldr-statusline')) delete settings.statusLine;
      }
      SETTINGS.validateHookFields(settings, warn);
      if (!opts.dryRun) SETTINGS.writeSettings(settingsPath, settings);
      ok(`  removed ${removed} TLDR hook entr${removed === 1 ? 'y' : 'ies'} from settings.json`);
    }
  }

  if (fs.existsSync(hooksDir)) {
    for (const f of HOOK_FILES) {
      const p = path.join(hooksDir, f);
      if (!fs.existsSync(p)) continue;
      if (!opts.dryRun) { try { fs.unlinkSync(p); } catch (_) {} }
      note(`  removed ${p}`);
    }
    // Don't rmdir hooksDir — other plugins may use it.
  }

  // Plugin uninstall on Claude. Probe `plugin list` first so a re-run on a
  // machine where TLDR was never installed (or was already removed) doesn't
  // print "Plugin not installed" stderr noise.
  if (hasCmd('claude')) {
    const probe = captureSpawn('claude', ['plugin', 'list']);
    if (probe.status === 0 && /tldr/i.test(probe.stdout || '')) {
      const r = runSpawn('claude', ['plugin', 'uninstall', 'tldr@tldr'], null, opts.dryRun);
      if ((r.status || 0) === 0) ok('  removed claude plugin');
    } else {
      note('  claude plugin not installed — skipping');
    }

    // Remove the plugin marketplace we registered at install time
    // (`claude plugin marketplace add 0p9b/TLDR` → named "tldr"). Idempotent:
    // probe `marketplace list` first so a machine that never had it stays quiet;
    // on --dry-run always print the intent.
    if (opts.dryRun) {
      runSpawn('claude', ['plugin', 'marketplace', 'remove', 'tldr'], null, true);
    } else {
      const mkProbe = captureSpawn('claude', ['plugin', 'marketplace', 'list']);
      if (mkProbe.status === 0 && /\btldr\b/i.test(mkProbe.stdout || '')) {
        const rm = runSpawn('claude', ['plugin', 'marketplace', 'remove', 'tldr'], null, false);
        if ((rm.status || 0) === 0) ok('  removed claude plugin marketplace');
      } else {
        note('  claude plugin marketplace not present — skipping');
      }
    }

    // tldr-shrink MCP — only run if `claude mcp` subcommand exists. Tolerate
    // non-zero exit (server may have never been registered).
    const mcpHelp = captureSpawn('claude', ['mcp', '--help']);
    if (mcpHelp.status === 0) {
      runSpawn('claude', ['mcp', 'remove', 'tldr-shrink'], null, opts.dryRun);
    }
  }

  // Gemini extension. Same idempotency probe as claude.
  if (hasCmd('gemini')) {
    const probe = captureSpawn('gemini', ['extensions', 'list']);
    if (probe.status === 0 && /tldr/i.test(probe.stdout || '')) {
      runSpawn('gemini', ['extensions', 'uninstall', 'tldr'], null, opts.dryRun);
    } else {
      note('  gemini extension not installed — skipping');
    }
  }

  // opencode native install — strip plugin entry, MCP entry, and our files.
  // Probed by the existence of the plugin dir we own; if absent, skip silently.
  const ocDir = opencodeConfigDir();
  const ocPluginDir = path.join(ocDir, 'plugins', 'tldr');
  const ocArtifactsPresent =
    fs.existsSync(ocPluginDir) ||
    fs.existsSync(path.join(ocDir, 'AGENTS.md')) ||
    fs.existsSync(path.join(ocDir, 'opencode.json')) ||
    OPENCODE_COMMAND_FILES.some(f => fs.existsSync(path.join(ocDir, 'commands', f))) ||
    OPENCODE_AGENT_FILES.some(f => fs.existsSync(path.join(ocDir, 'agents', f))) ||
    OPENCODE_SKILL_DIRS.some(name => fs.existsSync(path.join(ocDir, 'skills', name)));
  if (ocArtifactsPresent) {
    const ocJson = path.join(ocDir, 'opencode.json');
    if (fs.existsSync(ocJson)) {
      const cfg = SETTINGS.readSettings(ocJson);
      if (cfg) {
        if (Array.isArray(cfg.plugin)) {
          cfg.plugin = cfg.plugin.filter(p => p !== OPENCODE_PLUGIN_REL);
          if (cfg.plugin.length === 0) delete cfg.plugin;
        }
        if (cfg.mcp && typeof cfg.mcp === 'object' && cfg.mcp['tldr-shrink']) {
          delete cfg.mcp['tldr-shrink'];
          if (Object.keys(cfg.mcp).length === 0) delete cfg.mcp;
        }
        if (!opts.dryRun) SETTINGS.writeSettings(ocJson, cfg);
        ok(`  pruned TLDR entries from ${ocJson}`);
      }
    }
    if (!opts.dryRun) { try { fs.rmSync(ocPluginDir, { recursive: true, force: true }); } catch (_) {} }
    note(`  removed ${ocPluginDir}`);
    // Commands, agents, skills — only files matching our manifest (don't
    // sweep the parent dirs; user may have other entries there).
    for (const f of OPENCODE_COMMAND_FILES) {
      const p = path.join(ocDir, 'commands', f);
      if (fs.existsSync(p) && !opts.dryRun) { try { fs.unlinkSync(p); } catch (_) {} }
    }
    for (const f of OPENCODE_AGENT_FILES) {
      const p = path.join(ocDir, 'agents', f);
      if (fs.existsSync(p) && !opts.dryRun) { try { fs.unlinkSync(p); } catch (_) {} }
    }
    for (const name of OPENCODE_SKILL_DIRS) {
      const p = path.join(ocDir, 'skills', name);
      if (fs.existsSync(p) && !opts.dryRun) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
    }
    // AGENTS.md — strip the fenced TLDR block(s), preserving user content above
    // and below, via the shared nearest-preceding-BEGIN stripper (data-loss-safe
    // on orphan/duplicate markers). Falls back to legacy unfenced-sentinel
    // handling for installs that pre-date the marker fence.
    const ocAgentsMd = path.join(ocDir, 'AGENTS.md');
    stripFencedRuleset(ocAgentsMd, opts, note);
    // opencode flag file
    const ocFlag = path.join(ocDir, '.tldr-active');
    if (fs.existsSync(ocFlag) && !opts.dryRun) { try { fs.unlinkSync(ocFlag); } catch (_) {} }
  }

  // OpenClaw native install — strip skill folder + SOUL.md marker block.
  // Probed by the skill folder we own; if absent, skip silently.
  const ocwWs = process.env.OPENCLAW_WORKSPACE || path.join(os.homedir(), '.openclaw', 'workspace');
  if (fs.existsSync(path.join(ocwWs, 'skills', 'tldr')) || fs.existsSync(path.join(ocwWs, 'SOUL.md'))) {
    const log = {
      write: (s) => process.stdout.write(s),
      note: (s) => note(s),
      warn: (s) => warn(s),
    };
    const r = OPENCLAW.uninstallOpenclaw({ workspace: ocwWs, dryRun: opts.dryRun, log });
    if (r.touched) ok('  pruned TLDR entries from OpenClaw workspace');
  }

  // Hermes native install — strip the TLDR marker block(s) from SOUL.md,
  // preserving any user-authored content above and below, via the shared
  // nearest-preceding-BEGIN stripper (data-loss-safe on orphan/duplicate
  // markers). Probed by SOUL.md existence; if absent (or no marker block), the
  // stripper is a no-op. Also remove skill folders installHermes copied.
  const hermesSoul = hermesSoulPath();
  stripFencedFile(hermesSoul, HERMES_MARK_BEGIN, HERMES_MARK_END, opts, note);
  const hermesRoot = hermesSkillsRoot();
  if (fs.existsSync(hermesRoot)) {
    let prunedHermes = false;
    for (const name of HERMES_SKILL_DIRS) {
      const p = path.join(hermesRoot, name);
      if (fs.existsSync(p)) {
        if (!opts.dryRun) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
        note(`  removed ${p}`);
        prunedHermes = true;
      }
    }
    if (prunedHermes) ok('  pruned TLDR skills from Hermes');
  }
  // Legacy sweep: an older installer copied skills into ~/.hermes/skills/tldr
  // (current path is ~/.hermes/skills/productivity/). Remove the stale dir so
  // uninstall doesn't orphan it. Guarded; no-op when absent.
  const hermesLegacy = path.join(hermesConfigDir(), 'skills', 'tldr');
  if (fs.existsSync(hermesLegacy)) {
    if (!opts.dryRun) { try { fs.rmSync(hermesLegacy, { recursive: true, force: true }); } catch (_) {} }
    note(`  removed ${hermesLegacy}`);
    ok('  pruned legacy TLDR skill dir from Hermes');
  }

  // Flag file
  const flag = path.join(configDir, '.tldr-active');
  if (fs.existsSync(flag) && !opts.dryRun) { try { fs.unlinkSync(flag); } catch (_) {} }

  // Native AGENTS.md-convention installs (codex/pi/grok/antigravity/omp/cursor)
  // — strip the fenced TLDR block from each agent's rules file and remove every
  // skill dir the install copied (the full OPENCODE_SKILL_DIRS suite).
  for (const prov of PROVIDERS.filter(p => p.native)) {
    const ndir = expandHome(prov.native.dir);
    const rulesFile = prov.native.rules === null ? null : path.join(ndir, prov.native.rules || 'AGENTS.md');
    const skillsDir = path.join(ndir, prov.native.skills || 'skills');
    let touched = rulesFile ? stripFencedRuleset(rulesFile, opts, note) : false;
    for (const name of OPENCODE_SKILL_DIRS) {
      const skillDir = path.join(skillsDir, name);
      if (fs.existsSync(skillDir)) {
        if (!opts.dryRun) { try { fs.rmSync(skillDir, { recursive: true, force: true }); } catch (_) {} }
        note(`  removed ${skillDir}`);
        touched = true;
      }
    }
    // Hook wiring: prune only our entries from the agent's hook config, then
    // drop the scripts dir. A hook file that becomes empty is left in place —
    // the user may still own the file itself.
    if (prov.native.hooks) {
      const cfgPath = path.join(ndir, prov.native.hooks.file);
      if (fs.existsSync(cfgPath)) {
        try {
          const cfg = JSON.parse(SETTINGS.stripJsonComments(fs.readFileSync(cfgPath, 'utf8'))) || {};
          if (prov.native.hooks.style === 'antigravity') {
            delete cfg.tldr;
          } else if (cfg.hooks && typeof cfg.hooks === 'object') {
            for (const ev of Object.keys(cfg.hooks)) {
              const pruned = prov.native.hooks.style === 'cursor'
                ? AGENT_HOOKS.pruneFlat(cfg.hooks[ev])
                : AGENT_HOOKS.pruneGrouped(cfg.hooks[ev]);
              if (pruned.length) cfg.hooks[ev] = pruned;
              else delete cfg.hooks[ev];
            }
          }
          if (!opts.dryRun) atomicWrite(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 0o644);
          note(`  pruned TLDR hooks from ${cfgPath}`);
          touched = true;
        } catch (_) { /* unparseable — leave the user's file alone */ }
      }
      const hookScripts = path.join(ndir, 'hooks', 'tldr');
      if (fs.existsSync(hookScripts)) {
        if (!opts.dryRun) { try { fs.rmSync(hookScripts, { recursive: true, force: true }); } catch (_) {} }
        note(`  removed ${hookScripts}`);
        touched = true;
      }
    }
    if (touched) ok(`  pruned TLDR entries for ${prov.label}`);
  }

  process.stdout.write('\n');
  ok('uninstall done.');
  ok('npx-skills installs (Cursor/Windsurf/etc.) — remove via your IDE\'s skill manager');
  ok('per-repo init files (.cursor/, .windsurf/, AGENTS.md) — remove with your editor');
}

// ── Interactive prompt (TTY-only) ─────────────────────────────────────────
async function promptForOnly(detected) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  if (detected.length === 0) return null;
  process.stdout.write('\nDetected agents:\n');
  detected.forEach((p, i) => process.stdout.write(`  [${i + 1}] ${p.label}\n`));
  process.stdout.write('  [a] all   [q] quit\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise(res => rl.question('Install which? (default: all) ', res));
  rl.close();
  const t = (ans || '').trim().toLowerCase();
  if (t === 'q') process.exit(0);
  if (t === '' || t === 'a' || t === 'all') return null;
  const picks = t.split(/[\s,]+/).map(s => parseInt(s, 10)).filter(n => n >= 1 && n <= detected.length);
  if (picks.length === 0) return null;
  return picks.map(n => detected[n - 1].id);
}

// ── --list ─────────────────────────────────────────────────────────────────
function printList(noColor) {
  const c = makeChalk(noColor);
  process.stdout.write(c.orange('🦉 TLDR provider matrix') + '\n\n');
  process.stdout.write(`  ${String('ID').padEnd(13)} ${String('AGENT').padEnd(22)} INSTALL MECHANISM\n`);
  process.stdout.write(`  ${String('--').padEnd(13)} ${String('-----').padEnd(22)} -----------------\n`);
  for (const p of PROVIDERS) {
    const tag = p.soft ? ' (soft)' : '';
    process.stdout.write(`  ${String(p.id).padEnd(13)} ${String(p.label).padEnd(22)} ${p.mech}${tag}\n`);
  }
  process.stdout.write('\n');
  process.stdout.write(c.dim('  Defaults: --with-hooks ON, --with-mcp-shrink OFF, --with-init OFF.\n'));
  process.stdout.write(c.dim('  --all = hooks + init (mcp-shrink needs an upstream — opt in explicitly).\n'));
  process.stdout.write(c.dim('  --minimal turns hooks + init + mcp-shrink off.\n'));
}


// ── Help ───────────────────────────────────────────────────────────────────
function printHelp() {
  process.stdout.write(`tldr installer — detects your agents and installs TLDR for each one.

USAGE
  tldr [install] [flags]               # default when no subcommand
  tldr update [flags]                  # fetch latest + reinstall agents
  tldr uninstall [flags]
  tldr list
  npx -y github:0p9b/TLDR -- [flags]
  node bin/install.js [update|install|uninstall|list] [flags]
  bash install-full.sh [flags]         # shim → npx
  pwsh install.ps1 [flags]             # shim → npx

SUBCOMMANDS
  install               Install / refresh (default; bare flags = install).
  update                Fetch latest from GitHub and re-run install.
                        See: tldr update --help
  uninstall             Remove TLDR from this machine (same as --uninstall).
  list                  Print provider matrix (same as --list).

FLAGS
  --dry-run             Print what would run, do nothing.
  --force               Re-run even if a target reports already installed.
  --only <agent>        Install only for the named agent. Repeatable.
                        See --list for valid ids.
  --skip-skills         Don't run the npx-skills auto-detect fallback.
  --all                 Turn on hooks + init. (mcp-shrink needs an upstream;
                        pass --with-mcp-shrink="<cmd>" to add it.)
  --minimal             Just the plugin/extension install.
  --with-hooks          Claude Code: install SessionStart/UserPromptSubmit hooks
                        + statusline badge. (Default ON.)
  --no-hooks            Skip the hooks installer.
  --with-init           Write per-repo IDE rule files into \$PWD.
  --with-mcp-shrink="<upstream cmd>"
                        Claude Code: register tldr-shrink MCP proxy wrapping
                        the given upstream MCP server. (Default OFF.) Required
                        value — tldr-shrink exits immediately without one.
                        Example: --with-mcp-shrink="npx @modelcontextprotocol/server-filesystem /tmp"
  --no-mcp-shrink       Skip MCP shrink. (Default.)
  --uninstall, -u       Remove TLDR from this machine.
  --config-dir <path>   Claude Code config dir for hook files + settings.json.
                        Default: \$CLAUDE_CONFIG_DIR or ~/.claude. Does NOT
                        scope \`claude plugin install\`, \`gemini extensions
                        install\`, opencode (XDG_CONFIG_HOME), or openclaw
                        (OPENCLAW_WORKSPACE) — those use their own paths.
  --non-interactive     Never prompt; use defaults. (Auto when stdin is not a TTY.)
  --list                Print provider matrix and exit.
  --no-color            Disable ANSI colors.
  -h, --help            Show this help.

EXAMPLES
  npx -y github:0p9b/TLDR                        # default install
  npx -y github:0p9b/TLDR -- --all               # hooks + init
  npx -y github:0p9b/TLDR -- --only claude --no-mcp-shrink
  npx -y github:0p9b/TLDR -- --uninstall
  tldr update                                          # from clone or ~/.tldr/src
  tldr update --check                                  # report only
  node bin/install.js update --ref v0.20.0

  Issues: https://github.com/${REPO}/issues
`);
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const peeled = peelCommand(process.argv.slice(2));

  // update is its own flow (git fetch + reinstall) — never enter install parseArgs.
  if (peeled.command === 'update') {
    let updateOpts;
    try {
      updateOpts = UPDATE.parseUpdateArgs(peeled.argv);
    } catch (e) {
      process.stderr.write((e && e.message ? e.message : String(e)) + '\n');
      return 1;
    }
    const result = UPDATE.runUpdate(updateOpts, {
      repoRoot: detectRepoRoot(),
      candidates: [detectRepoRoot(), process.cwd()],
    });
    return result.exitCode || 0;
  }

  // Subcommand aliases → legacy flags (bare --list / --uninstall still work).
  let argv = peeled.argv;
  if (peeled.command === 'uninstall') argv = ['--uninstall', ...argv];
  if (peeled.command === 'list') argv = ['--list', ...argv];

  const opts = parseArgs(argv);
  const c = makeChalk(opts.noColor);
  if (opts.help) { printHelp(); return 0; }
  if (opts.listOnly) { printList(opts.noColor); return 0; }

  checkWslWindowsNode();
  checkNodeVersion();

  const configDir = opts.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const repoRoot = detectRepoRoot();

  const ctx = {
    opts, configDir, repoRoot,
    say:  (s) => process.stdout.write(c.orange(s) + '\n'),
    note: (s) => process.stdout.write(c.dim(s) + '\n'),
    warn: (s) => process.stderr.write(c.red(s) + '\n'),
    ok:   (s) => process.stdout.write(c.green(s) + '\n'),
    results: { installed: [], skipped: [], failed: [], detected: 0 },
  };

  // Uninstall only edits settings.json — it never interpolates configDir into a
  // shell command — so it runs before the shell-safety guard below.
  if (opts.uninstall) { uninstall(ctx); return 0; }

  // The resolved config-dir path is interpolated into settings.json hook
  // command strings that Claude Code later runs through a shell, always inside
  // double quotes (e.g. `"${node}" "${activate}"`). Reject only the characters
  // that stay active INSIDE double quotes and enable injection: `"` (breaks out
  // of the quoting), and `` ` `` / `$` (command/variable substitution on POSIX),
  // plus newlines. Do NOT reject ( ) & < > ; | (literal when double-quoted, so
  // they block legit paths like `C:\Program Files (x86)\...\.claude`) and do NOT
  // reject `\` (the Windows path separator — every Windows config dir has it).
  if (/["`$\n\r]/.test(configDir)) {
    process.stderr.write(
      c.red(`config-dir contains shell-unsafe characters and was refused: ${configDir}\n`)
    );
    return 2;
  }

  ctx.say('🦉 TLDR installer');
  ctx.note(`  ${REPO}`);
  if (opts.dryRun) ctx.note('  (dry run — nothing will be written)');
  process.stdout.write('\n');

  // Detect everything once
  const detected = PROVIDERS.filter(p => detectMatch(p.detect));

  // TTY-only multi-select prompt when no --only and no --non-interactive.
  if (opts.only.length === 0 && !opts.nonInteractive) {
    const picks = await promptForOnly(detected);
    if (picks) opts.only = picks;
  }

  const want = (id) => opts.only.length === 0 || opts.only.includes(id);
  const explicit = (id) => opts.only.includes(id);

  // Run installs in declared order. Soft providers (no reliable detect probe)
  // are auto-skipped — user must opt in via `--only <id>`. Stops the installer
  // from firing `npx skills add ...` against agents the user never installed
  // just because some other tool created `~/.foo` along the way.
  for (const prov of PROVIDERS) {
    if (!want(prov.id)) continue;
    if (prov.soft && !explicit(prov.id)) continue;
    // Auto-detect mode: skip providers we can't see. With --only <id> the user
    // is explicitly opting in, so trust them and let the per-provider installer
    // bail itself if its preconditions aren't met (e.g. opencode bails when
    // no repo clone is available; openclaw bails when the workspace dir is
    // missing without --force).
    if (!explicit(prov.id) && !detectMatch(prov.detect)) continue;
    if (prov.id === 'claude')   { await installClaude(ctx); continue; }
    if (prov.id === 'gemini')   { installGemini(ctx); continue; }
    if (prov.id === 'opencode') { installOpencode(ctx); continue; }
    if (prov.id === 'openclaw') { installOpenclaw(ctx); continue; }
    if (prov.id === 'hermes')   { installHermes(ctx); continue; }
    if (prov.native)            { installNativeAgentsMd(ctx, prov); continue; }
    if (prov.profile)           { installViaSkills(ctx, prov); continue; }
  }

  // Auto-detect fallback if nothing matched
  if (!opts.skipSkills && opts.only.length === 0 && ctx.results.detected === 0) {
    ctx.say('→ no known agents detected — running npx-skills auto-detect fallback');
    // --yes --all for the same reason as installViaSkills above (issue #370):
    // skip the interactive skill picker so curl|bash actually installs.
    const r = runSpawn('npx', ['-y', 'skills', 'add', REPO, '--yes', '--all'], null, opts.dryRun);
    if ((r.status || 0) === 0) ctx.results.installed.push('skills-auto');
    else ctx.results.failed.push(['skills-auto', 'npx skills add (auto) failed']);
    process.stdout.write('\n');
  }

  // Per-repo init
  if (opts.withInit) {
    ctx.say(`→ writing per-repo IDE rule files into ${process.cwd()} (--with-init)`);
    if (await runInit(ctx)) ctx.results.installed.push(`tldr-init (${process.cwd()})`);
    else                    ctx.results.failed.push(['tldr-init', 'src/tools/tldr-init.js failed']);
    process.stdout.write('\n');
  } else if (ctx.results.installed.length || ctx.results.skipped.length) {
    ctx.note('  tip: re-run inside a repo with --all (or --with-init) to also write per-repo');
    ctx.note('       Cursor/Windsurf/Cline/Copilot/AGENTS.md rule files.');
  }

  // Summary
  process.stdout.write('\n');
  ctx.say('🦉 done');
  if (ctx.results.installed.length) {
    ctx.ok('  installed:');
    for (const a of ctx.results.installed) process.stdout.write(`    • ${a}\n`);
  }
  if (ctx.results.skipped.length) {
    process.stdout.write('  skipped:\n');
    for (const [id, why] of ctx.results.skipped) process.stdout.write(`    • ${id} — ${why}\n`);
  }
  if (ctx.results.failed.length) {
    ctx.warn('  failed:');
    for (const [id, why] of ctx.results.failed) process.stderr.write(`    • ${id} — ${why}\n`);
  }
  if (!ctx.results.installed.length && !ctx.results.skipped.length && !ctx.results.failed.length) {
    process.stdout.write('  nothing detected. run with --list to see all 30+ supported agents,\n');
    process.stdout.write('  or pass --only <agent> to force a specific target.\n');
  }
  process.stdout.write('\n');
  ctx.note("  start any session and say 'tldr mode', or run /tldr in Claude Code");
  ctx.note(`  uninstall: npx -y github:${REPO} -- --uninstall`);

  // Exit code: nonzero only if every detected agent failed
  if (ctx.results.detected > 0 && !ctx.results.installed.length && !ctx.results.skipped.length) return 1;
  return 0;
}

main().then(code => process.exit(code || 0))
      .catch(err => { process.stderr.write((err && err.stack || String(err)) + '\n'); process.exit(1); });
