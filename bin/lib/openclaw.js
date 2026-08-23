// TLDR → OpenClaw install / uninstall helper.
//
// OpenClaw is a self-hosted gateway that orchestrates Claude Code, Codex,
// Pi, OpenCode, and others. It has its own workspace + skills system at
// ~/.openclaw/workspace/. Skills there appear in a compact list and are
// loaded on-demand by the model — they are NOT injected as system prompt
// each turn. The bootstrap files (AGENTS.md, SOUL.md, TOOLS.md, MEMORY.md)
// ARE injected each turn under "Project Context", subject to a 12K-per-file
// and 60K-total cap.
//
// To make TLDR always-on through OpenClaw, we do two writes:
//   1. Drop a copy of skills/tldr/SKILL.md into <workspace>/skills/tldr/
//      with OpenClaw-required frontmatter (`version`, `always: true`) merged
//      in. Makes the skill discoverable via `openclaw skills list` and lets
//      the orchestrated agent `read` it on demand.
//   2. Append a tiny marker-fenced bootstrap snippet to <workspace>/SOUL.md
//      pointing the agent at the skill. SOUL.md is auto-injected each turn,
//      so this is what actually drives always-on behavior.
//
// Idempotent on both writes. Uninstall removes the skill folder and strips
// the marker block from SOUL.md while preserving any user-authored content.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWrite } = require('./safe-fs');
const { stripFencedBlocks } = require('./fenced');

const SKILL_NAME = 'tldr';
const SKILL_VERSION = '1.0.0';
const MARK_BEGIN = '<!-- tldr-begin -->';
const MARK_END = '<!-- tldr-end -->';
const SOUL_FILE = 'SOUL.md';

function resolveWorkspace(env = process.env) {
  if (env.OPENCLAW_WORKSPACE) return path.resolve(env.OPENCLAW_WORKSPACE);
  return path.join(os.homedir(), '.openclaw', 'workspace');
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

// ── Frontmatter helpers ───────────────────────────────────────────────────
// Lightweight YAML merge — we only need to insert `version` and `always` if
// they're absent. Avoids pulling in a YAML dep for a job this small. The
// TLDR SKILL.md uses block-scalar `description: >`, which a naive split
// would mangle — but since we're only ever appending top-level keys (never
// editing existing ones), a string-prepend after the leading `---\n` is safe.

function splitFrontmatter(src) {
  if (!src.startsWith('---\n') && !src.startsWith('---\r\n')) {
    return { frontmatter: '', body: src };
  }
  const after = src.slice(src.indexOf('\n') + 1);
  const endRe = /(^|\n)---\s*(\r?\n|$)/;
  const m = endRe.exec(after);
  if (!m) return { frontmatter: '', body: src };
  const fmEnd = m.index + (m[1] ? 1 : 0);
  const fm = after.slice(0, fmEnd);
  const rest = after.slice(m.index + m[0].length);
  return { frontmatter: fm, body: rest };
}

function frontmatterHasKey(fm, key) {
  const re = new RegExp('(^|\\n)' + key + '\\s*:', 'i');
  return re.test(fm);
}

function mergeOpenclawFrontmatter(src) {
  const { frontmatter, body } = splitFrontmatter(src);
  const additions = [];
  if (!frontmatterHasKey(frontmatter, 'name')) additions.push(`name: ${SKILL_NAME}`);
  if (!frontmatterHasKey(frontmatter, 'version')) additions.push(`version: ${SKILL_VERSION}`);
  if (!frontmatterHasKey(frontmatter, 'always')) additions.push('always: true');
  if (additions.length === 0 && frontmatter) return src;
  const fmBody = (frontmatter ? frontmatter.trimEnd() + '\n' : '') + additions.join('\n') + (additions.length ? '\n' : '');
  return '---\n' + fmBody + '---\n' + body;
}

// ── Bootstrap snippet load ────────────────────────────────────────────────
function loadBootstrapSnippet(repoRoot) {
  if (repoRoot) {
    const p = path.join(repoRoot, 'src', 'rules', 'tldr-openclaw-bootstrap.md');
    const body = readIfExists(p);
    if (body) return body.endsWith('\n') ? body : body + '\n';
  }
  // Standalone fallback (curl|node case where there's no repo on disk).
  // Keep this in sync with src/rules/tldr-openclaw-bootstrap.md.
  return [
    MARK_BEGIN,
    '## TLDR mode (always on)',
    '',
    'Respond in TLDR style: verdict first, no filler. All technical substance stays.',
    '',
    "The full ruleset and intensity levels live in this workspace's TLDR skill:",
    '',
    '  skills/tldr/SKILL.md',
    '',
    'Default intensity: `full`. Switch with `/tldr lite|full|ultra|wenyan`.',
    'Stop with: "stop tldr" / "normal mode" / "deactivate TLDR".',
    '',
    'Auto-Clarity: drop TLDR for security warnings, irreversible action',
    'confirmations, multi-step sequences where fragments risk misread, or when',
    'user is confused or repeating. Resume after.',
    '',
    'Boundaries: code, commit messages, and PR descriptions stay normal prose.\n\n' +
    'TLDR footer: replying to the user only (never code/commits/tool output), if the response exceeds ANY of 3 sentences, 30 words total, or 100 characters, append a brief `TLDR:` summary line at the bottom. No footer when none are true.',
    MARK_END,
    '',
  ].join('\n');
}

function loadSkillBody(repoRoot) {
  if (!repoRoot) return null;
  return readIfExists(path.join(repoRoot, 'skills', 'tldr', 'SKILL.md'));
}

// ── SOUL.md marker-block append/strip ─────────────────────────────────────
function appendBootstrapToSoul(soulPath, snippet) {
  const existing = readIfExists(soulPath);
  if (existing && existing.includes(MARK_BEGIN) && existing.includes(MARK_END)) {
    return { changed: false, reason: 'already present' };
  }
  let next;
  if (existing && existing.length) {
    const sep = existing.endsWith('\n\n') ? '' : (existing.endsWith('\n') ? '\n' : '\n\n');
    next = existing + sep + snippet;
  } else {
    next = snippet;
  }
  // atomicWrite (temp + rename) replaces a planted symlink with a real file
  // instead of writing THROUGH it to an out-of-tree target.
  atomicWrite(soulPath, next, 0o644);
  return { changed: true };
}

function stripBootstrapFromSoul(soulPath) {
  const existing = readIfExists(soulPath);
  if (!existing) return { changed: false, reason: 'no SOUL.md' };
  // Nearest-preceding pairing (shared engine): an orphan MARK_BEGIN above the
  // real block no longer causes the slice to eat the user's SOUL.md content.
  const { text, removed } = stripFencedBlocks(existing, MARK_BEGIN, MARK_END);
  if (!removed) return { changed: false, reason: 'no marker block' };
  let next = text.trimEnd();
  next = next ? next + '\n' : '';
  if (next === '') {
    // SOUL.md only contained our block — remove the file so OpenClaw doesn't
    // bootstrap an empty section every turn.
    try { fs.unlinkSync(soulPath); } catch (_) {}
    return { changed: true, removed: true };
  }
  atomicWrite(soulPath, next, 0o644);
  return { changed: true };
}

// ── Public API ────────────────────────────────────────────────────────────
function installOpenclaw({ workspace, repoRoot, dryRun = false, force = false, log = noopLog() } = {}) {
  const ws = workspace || resolveWorkspace();
  const skillBody = loadSkillBody(repoRoot);
  if (!skillBody) {
    log.warn('  openclaw install requires the TLDR repo on disk (skills/tldr/SKILL.md missing).');
    log.note('  Re-run from a clone or via `npx -y github:0p9b/TLDR -- --only openclaw`.');
    return { ok: false, reason: 'repo not available' };
  }
  const snippet = loadBootstrapSnippet(repoRoot);

  if (!fs.existsSync(ws)) {
    if (!force) {
      log.warn(`  openclaw workspace not found at ${ws}.`);
      log.note('  Either install OpenClaw (https://openclaw.ai) and re-run, or pass --force to mkdir.');
      return { ok: false, reason: 'workspace missing' };
    }
    if (!dryRun) fs.mkdirSync(ws, { recursive: true });
  }

  const skillDir = path.join(ws, 'skills', SKILL_NAME);
  const skillFile = path.join(skillDir, 'SKILL.md');
  const soulFile = path.join(ws, SOUL_FILE);

  if (dryRun) {
    log.note(`  would write ${skillFile} (with version/always frontmatter)`);
    log.note(`  would ${fs.existsSync(soulFile) ? 'append to' : 'create'} ${soulFile} (TLDR bootstrap block)`);
    return { ok: true, dryRun: true };
  }

  fs.mkdirSync(skillDir, { recursive: true });
  const merged = mergeOpenclawFrontmatter(skillBody);
  atomicWrite(skillFile, merged, 0o644);
  log.write(`  installed: ${skillFile}\n`);

  const soul = appendBootstrapToSoul(soulFile, snippet);
  if (soul.changed) log.write(`  wrote bootstrap block to ${soulFile}\n`);
  else log.note(`  ${soulFile} already contains TLDR bootstrap`);

  return { ok: true };
}

function uninstallOpenclaw({ workspace, dryRun = false, log = noopLog() } = {}) {
  const ws = workspace || resolveWorkspace();
  const skillDir = path.join(ws, 'skills', SKILL_NAME);
  const soulFile = path.join(ws, SOUL_FILE);

  let touched = false;

  if (fs.existsSync(skillDir)) {
    if (dryRun) {
      log.note(`  would remove ${skillDir}/`);
    } else {
      try { fs.rmSync(skillDir, { recursive: true, force: true }); } catch (_) {}
      log.note(`  removed ${skillDir}`);
    }
    touched = true;
  }

  if (fs.existsSync(soulFile)) {
    if (dryRun) {
      log.note(`  would strip TLDR block from ${soulFile}`);
      touched = true;
    } else {
      const r = stripBootstrapFromSoul(soulFile);
      if (r.changed) {
        log.note(r.removed ? `  removed ${soulFile}` : `  stripped TLDR block from ${soulFile}`);
        touched = true;
      }
    }
  }

  return { ok: true, touched };
}

function noopLog() {
  return {
    write: (_) => {},
    note: (_) => {},
    warn: (_) => {},
  };
}

module.exports = {
  installOpenclaw,
  uninstallOpenclaw,
  resolveWorkspace,
  // exported for tests
  mergeOpenclawFrontmatter,
  splitFrontmatter,
  appendBootstrapToSoul,
  stripBootstrapFromSoul,
  loadBootstrapSnippet,
  MARK_BEGIN,
  MARK_END,
  SKILL_NAME,
  SKILL_VERSION,
};
