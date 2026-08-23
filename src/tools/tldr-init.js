#!/usr/bin/env node
// TLDR init — drop the always-on TLDR activation rule into a target
// repo for every IDE agent we support. Idempotent. Safe to re-run.
//
// Usage:
//   node src/tools/tldr-init.js [target-dir] [--dry-run] [--force] [--only <agent>]
//   curl -fsSL https://raw.githubusercontent.com/0p9b/TLDR/main/src/tools/tldr-init.js | node - [args]
//
// Without args, runs in cwd. Generates the rule files for Cursor, Windsurf,
// Cline, Copilot, opencode, and AGENTS.md. Does NOT modify CLAUDE.md or compress
// existing memory files — that's the job of `/tldr:compress`.

const fs = require('fs');
const path = require('path');
let atomicWrite, resolveSafeTarget;
try {
  ({ atomicWrite, resolveSafeTarget } = require(path.join(__dirname, '..', '..', 'bin', 'lib', 'safe-fs.js')));
} catch (_) {
  atomicWrite = (dest, content, mode = 0o644) => {
    const dir = path.dirname(dest);
    fs.mkdirSync(dir, { recursive: true });
    // Write into a fresh unpredictable 0700 temp dir, then rename over dest.
    // mkdtempSync (not a predictable .pid-Date name) means an attacker can't
    // pre-plant a symlink at the temp path to be followed by the write; the
    // rename replaces any symlink planted at dest rather than clobbering its
    // target. Matches bin/lib/safe-fs.js semantics.
    const tmpDir = fs.mkdtempSync(path.join(dir, '.tldr-init-'));
    const tmp = path.join(tmpDir, 'rule');
    try {
      fs.writeFileSync(tmp, content, { mode });
      fs.renameSync(tmp, dest);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw e;
    } finally {
      try { fs.rmdirSync(tmpDir); } catch (_) {}
    }
  };
  resolveSafeTarget = (target) => {
    try { return fs.realpathSync(target); }
    catch (_) { return path.resolve(target); }
  };
}

// Embedded so the tool works standalone (npx-style) without the src/rules/ dir.
// Mirrors src/rules/tldr-activate.md verbatim — keep these in sync.
const RULE_BODY = `Respond in TLDR style: verdict first, no filler. All technical substance stays.

Rules:
- 1 sentence default. 3-word target. 6-word hard max unless correctness requires more.
- No preamble, filler, postscript, recap, hedges. Verdict first.
- Shapes: confirm/opinion → verdict first; error → 1 cause + 1 fix ≤6w; cmd/code → artifact only; flawed premise → correct first (shortest).
- Fragments OK. Drop articles. Never open with validation. Answer-only. Prioritize truth and utility.
- Expansion only on explicit request.

Switch: /tldr lite|full|ultra|wenyan
Stop: "stop tldr" or "normal mode"

Auto-Clarity: drop TLDR for security warnings, irreversible actions, ambiguity risk, user confusion. Resume after.

Boundaries: code/commits/PRs written normal.
TLDR footer: replying to the user only (never code/commits/tool output), if the response exceeds ANY of 3 sentences, 30 words, or 100 characters, append a brief \`TLDR:\` summary line at the bottom. No footer when none are true.
`;

const SENTINEL = 'Respond in TLDR style';
// Sentinel written by installs that pre-date the persona-register cleanup.
// Detection-only: matched to keep re-runs idempotent, never written or emitted.
const LEGACY_SENTINEL = 'Respond terse like smart TLDR';

// OpenClaw is a global workspace tool (not per-repo) and needs two write
// targets — a skill folder + a SOUL.md bootstrap block. The shared helper
// lives at bin/lib/openclaw.js; we require it lazily so tldr-init.js
// keeps working when run standalone (curl|node) without the helper on disk.
function loadOpenclawHelper() {
  try {
    return require(path.join(__dirname, '..', '..', 'bin', 'lib', 'openclaw.js'));
  } catch (_) { return null; }
}

const AGENTS = [
  { id: 'cursor',   file: '.cursor/rules/tldr.mdc',
    frontmatter: '---\ndescription: "TLDR mode — terse communication, ~75% fewer tokens, full technical accuracy"\nalwaysApply: true\n---\n\n',
    mode: 'replace' },
  { id: 'windsurf', file: '.windsurf/rules/tldr.md',
    frontmatter: '---\ntrigger: always_on\n---\n\n',
    mode: 'replace' },
  { id: 'cline',    file: '.clinerules/tldr.md',
    frontmatter: '',
    mode: 'replace' },
  { id: 'copilot',  file: '.github/copilot-instructions.md',
    frontmatter: '',
    mode: 'append' },
  { id: 'opencode', file: '.opencode/AGENTS.md',
    frontmatter: '',
    mode: 'append' },
  { id: 'agents',   file: 'AGENTS.md',
    frontmatter: '',
    mode: 'append' },
  // OpenClaw — global workspace install, not per-repo. The `installer`
  // callback escape hatch bypasses the file/frontmatter/mode triple and
  // hands off to the shared helper. `description` is what `--help` prints.
  { id: 'openclaw', description: '~/.openclaw/workspace/{skills/tldr/, SOUL.md}',
    installer: 'openclaw' },
];

function loadRuleBody() {
  // Prefer the in-repo source-of-truth when available.
  try {
    const local = path.join(__dirname, '..', 'rules', 'tldr-activate.md');
    if (fs.existsSync(local)) return fs.readFileSync(local, 'utf8').trimEnd() + '\n';
  } catch (e) {}
  return RULE_BODY;
}

function processAgent(agent, targetDir, ruleBody, opts) {
  if (agent.installer === 'openclaw') {
    return processOpenclaw(opts);
  }
  const fullPath = path.join(targetDir, agent.file);
  const exists = fs.existsSync(fullPath);

  if (!exists) {
    if (!opts.dryRun) {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      atomicWrite(fullPath, agent.frontmatter + ruleBody, 0o644);
    }
    return { status: 'added', label: '+' };
  }

  const existing = fs.readFileSync(fullPath, 'utf8');
  if (existing.includes(SENTINEL) || existing.includes(LEGACY_SENTINEL)) {
    return { status: 'skipped-already-installed', label: '=' };
  }

  if (agent.mode === 'append') {
    if (!opts.dryRun) {
      const sep = existing.endsWith('\n\n') ? '' : (existing.endsWith('\n') ? '\n' : '\n\n');
      atomicWrite(fullPath, existing + sep + ruleBody, 0o644);
    }
    return { status: 'appended', label: '~' };
  }

  if (opts.force) {
    if (!opts.dryRun) {
      atomicWrite(fullPath, agent.frontmatter + ruleBody, 0o644);
    }
    return { status: 'overwritten', label: '!' };
  }

  return { status: 'skipped-exists', label: '?' };
}

function processOpenclaw(opts) {
  const helper = loadOpenclawHelper();
  if (!helper) {
    return {
      status: 'unsupported-standalone',
      label: 'x',
      detail: '~/.openclaw/workspace (helper unavailable in standalone curl|node mode — use `npx -y github:0p9b/TLDR -- --only openclaw`)',
    };
  }
  const repoRoot = path.resolve(__dirname, '..', '..');
  const log = {
    write: (_) => {},
    note: (_) => {},
    warn: (_) => {},
  };
  const r = helper.installOpenclaw({
    workspace: process.env.OPENCLAW_WORKSPACE || undefined,
    repoRoot,
    dryRun: opts.dryRun,
    force: opts.force,
    log,
  });
  if (!r.ok) {
    return { status: 'skipped-' + (r.reason || 'failed'), label: '?', detail: helper.resolveWorkspace ? helper.resolveWorkspace() : '~/.openclaw/workspace' };
  }
  if (r.dryRun) return { status: 'would-add', label: '+', detail: helper.resolveWorkspace() };
  return { status: 'installed', label: '+', detail: helper.resolveWorkspace() };
}

function parseArgs(argv) {
  const opts = { dryRun: false, force: false, only: null, target: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--only') { opts.only = argv[++i]; }
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (!a.startsWith('-')) opts.target = path.resolve(a);
  }
  return opts;
}

function help() {
  console.log(`tldr init — drop always-on TLDR rule into a target repo

Usage: tldr-init.js [target-dir] [--dry-run] [--force] [--only <agent>]

Defaults to current working directory. Idempotent — safe to re-run.

Targets installed:
${AGENTS.map(a => `  ${a.id.padEnd(10)} ${a.file || a.description || ''}`).join('\n')}

Flags:
  --dry-run   show what would change, do not write
  --force     overwrite existing rule files (default: skip)
  --only <id> only install for one agent (id from list above)
`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { help(); return; }

  opts.target = resolveSafeTarget(opts.target);
  console.log(`🦉 TLDR init — ${opts.target}${opts.dryRun ? ' (dry run)' : ''}\n`);

  const ruleBody = loadRuleBody();
  const counts = { added: 0, appended: 0, overwritten: 0, skipped: 0 };

  for (const agent of AGENTS) {
    if (opts.only && opts.only !== agent.id) continue;
    // OpenClaw writes a global workspace, not a per-repo file. Keep default
    // tldr-init scoped to the target repo; install OpenClaw only explicitly.
    if (!opts.only && agent.installer === 'openclaw') continue;
    const result = processAgent(agent, opts.target, ruleBody, opts);
    const target = agent.file || result.detail || agent.description || agent.id;
    console.log(`  ${result.label} ${target} (${result.status})`);
    if (result.status === 'added' || result.status === 'installed' || result.status === 'would-add') counts.added++;
    else if (result.status === 'appended') counts.appended++;
    else if (result.status === 'overwritten') counts.overwritten++;
    else counts.skipped++;
  }

  console.log(`\n${counts.added} added, ${counts.appended} appended, ` +
              `${counts.overwritten} overwritten, ${counts.skipped} skipped`);
  if (opts.dryRun) console.log('(dry run — no files were written)');
}

if (require.main === module) main();

module.exports = { processAgent, loadRuleBody, AGENTS, SENTINEL, LEGACY_SENTINEL, RULE_BODY };
