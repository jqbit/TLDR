'use strict';
// TLDR update — refresh a git checkout (local clone or ~/.tldr/src), then
// re-run the installer non-interactively so hooks/skills/MCP/rules match
// the new tree. CommonJS to match bin/install.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');

const REPO = '0p9b/TLDR';
const REPO_URL = `https://github.com/${REPO}.git`;
const CACHE_DIR = path.join(os.homedir(), '.tldr', 'src');
const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/;

function parseUpdateArgs(argv) {
  const opts = {
    dryRun: false,
    force: false,
    check: false,
    ref: null,
    noColor: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run': opts.dryRun = true; break;
      case '--force': opts.force = true; break;
      case '--check': opts.check = true; break;
      case '--no-color': opts.noColor = true; break;
      case '-h': case '--help': opts.help = true; break;
      case '--': break;
      case '--ref': case '--tag': {
        const v = argv[++i];
        if (!v || v.startsWith('--')) {
          throw new Error(`error: ${a} requires a tag or branch name`);
        }
        opts.ref = v;
        break;
      }
      default:
        throw new Error(`error: unknown update flag: ${a}\nrun 'tldr update --help' for usage`);
    }
  }
  return opts;
}

function printUpdateHelp() {
  process.stdout.write(`tldr update — fetch latest TLDR and refresh installed agents.

USAGE
  tldr update [flags]
  node bin/install.js update [flags]

FLAGS
  --check               Report whether an update is available; do not apply.
  --dry-run             Show git + reinstall steps; write nothing.
  --ref <tag|branch>    Update to this ref (tag or branch). Alias: --tag.
  --force               If a fast-forward pull fails, hard-reset the local
                        checkout to origin/<ref>. Never force-pushes.
  --no-color            Disable ANSI colors.
  -h, --help            Show this help.

SOURCE
  Prefers the local TLDR git checkout when the current tree is that repo.
  Otherwise uses ~/.tldr/src (clones https://github.com/${REPO}.git if missing).

DEFAULT REF
  On a branch: fast-forward the tracking branch after fetch.
  Detached on a tag: move to the latest vX.Y.Z release tag.
  curl|npx installs stay pinned via PINNED_REF in install.js — this
  command updates from a git clone only.

EXIT
  0  success or already up to date (also --check with/without updates)
  1  failure
`);
}

function looksLikeTldrTree(dir) {
  if (!dir) return false;
  return fs.existsSync(path.join(dir, 'bin', 'install.js')) &&
    fs.existsSync(path.join(dir, 'skills', 'tldr', 'SKILL.md'));
}

function gitOk(r) {
  return r && (r.status === 0);
}

function makeGit(spawnSync) {
  return function git(cwd, args, opts) {
    const r = spawnSync('git', args, Object.assign({
      cwd,
      encoding: 'utf8',
      env: process.env,
    }, opts || {}));
    return {
      status: r.status,
      stdout: (r.stdout || '').toString(),
      stderr: (r.stderr || '').toString(),
      error: r.error || null,
    };
  };
}

function isInsideGitWorkTree(dir, git) {
  const r = git(dir, ['rev-parse', '--is-inside-work-tree']);
  return gitOk(r) && r.stdout.trim() === 'true';
}

function remotesMentionTldr(dir, git) {
  const r = git(dir, ['remote', '-v']);
  if (!gitOk(r)) return false;
  return /github\.com[/:]0p9b\/TLDR(?:\.git)?(?:\s|$)/i.test(r.stdout);
}

function packageIsTldrInstaller(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg && pkg.name === 'tldr-installer';
  } catch (_) {
    return false;
  }
}

function isTldrGitRepo(dir, git) {
  if (!looksLikeTldrTree(dir)) return false;
  if (!isInsideGitWorkTree(dir, git)) return false;
  return remotesMentionTldr(dir, git) || packageIsTldrInstaller(dir);
}

function resolveSourceDir(candidates, git) {
  for (const c of candidates) {
    if (!c) continue;
    const abs = path.resolve(c);
    if (isTldrGitRepo(abs, git)) {
      return { dir: abs, kind: 'local' };
    }
  }
  return { dir: CACHE_DIR, kind: 'cache' };
}

function shortSha(sha) {
  if (!sha) return '(unknown)';
  return String(sha).trim().slice(0, 12);
}

function getHeadSha(dir, git) {
  const r = git(dir, ['rev-parse', 'HEAD']);
  if (!gitOk(r)) return null;
  return r.stdout.trim();
}

function getAbbrevRef(dir, git) {
  const r = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!gitOk(r)) return null;
  return r.stdout.trim();
}

function currentDescribe(dir, git) {
  const r = git(dir, ['describe', '--tags', '--exact-match', 'HEAD']);
  if (gitOk(r) && r.stdout.trim()) return r.stdout.trim();
  const br = getAbbrevRef(dir, git);
  if (br && br !== 'HEAD') return br;
  return shortSha(getHeadSha(dir, git));
}

function findLatestReleaseTag(dir, git) {
  const r = git(dir, ['tag', '-l', 'v*', '--sort=-v:refname']);
  if (!gitOk(r)) return null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (RELEASE_TAG_RE.test(t)) return t;
  }
  return null;
}

function resolveTrackingRef(dir, git, branch) {
  const u = git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (gitOk(u) && u.stdout.trim()) return u.stdout.trim();
  // No upstream configured — fall back to origin/<branch> if it exists.
  const origin = `origin/${branch}`;
  const check = git(dir, ['rev-parse', '--verify', origin]);
  if (gitOk(check)) return origin;
  return null;
}

function ensureClone(dir, opts, git, log) {
  if (fs.existsSync(path.join(dir, '.git')) || looksLikeTldrTree(dir)) {
    return { ok: true, cloned: false };
  }
  if (opts.dryRun || opts.check) {
    log(`  would clone ${REPO_URL} → ${dir}`);
    return { ok: true, cloned: false, pending: true };
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  log(`  cloning ${REPO_URL} → ${dir}`);
  const r = git(path.dirname(dir), ['clone', REPO_URL, dir]);
  if (!gitOk(r)) {
    return {
      ok: false,
      error: `git clone failed: ${(r.stderr || r.stdout || r.error || 'unknown').toString().trim()}`,
    };
  }
  return { ok: true, cloned: true };
}

function fetchAll(dir, git) {
  const r = git(dir, ['fetch', '--tags', '--prune', 'origin']);
  if (!gitOk(r)) {
    return {
      ok: false,
      error: `git fetch failed: ${(r.stderr || r.stdout || 'unknown').toString().trim()}`,
    };
  }
  return { ok: true };
}

function resolveTarget(dir, git, opts) {
  if (opts.ref) {
    // Prefer origin/<ref> for branches; tags resolve as themselves.
    const asOrigin = `origin/${opts.ref}`;
    const originOk = gitOk(git(dir, ['rev-parse', '--verify', asOrigin]));
    const tagOk = gitOk(git(dir, ['rev-parse', '--verify', `refs/tags/${opts.ref}`]));
    const localOk = gitOk(git(dir, ['rev-parse', '--verify', opts.ref]));
    if (originOk) return { kind: 'ref', name: opts.ref, rev: asOrigin };
    if (tagOk) return { kind: 'tag', name: opts.ref, rev: opts.ref };
    if (localOk) return { kind: 'ref', name: opts.ref, rev: opts.ref };
    return { error: `ref not found after fetch: ${opts.ref}` };
  }

  const branch = getAbbrevRef(dir, git);
  if (branch && branch !== 'HEAD') {
    const upstream = resolveTrackingRef(dir, git, branch);
    if (!upstream) {
      return { error: `branch '${branch}' has no upstream (set upstream or pass --ref)` };
    }
    return { kind: 'branch', name: branch, rev: upstream };
  }

  // Detached HEAD — prefer latest release tag.
  const latest = findLatestReleaseTag(dir, git);
  if (!latest) {
    return { error: 'detached HEAD and no vX.Y.Z release tags found; pass --ref' };
  }
  return { kind: 'tag', name: latest, rev: latest };
}

function revSha(dir, git, rev) {
  const r = git(dir, ['rev-parse', rev]);
  if (!gitOk(r)) return null;
  return r.stdout.trim();
}

function applyUpdate(dir, git, target, opts, log) {
  const wantSha = revSha(dir, git, target.rev);
  const haveSha = getHeadSha(dir, git);
  if (wantSha && haveSha && wantSha === haveSha) {
    return { ok: true, changed: false };
  }

  if (target.kind === 'branch') {
    // Stay on current branch; fast-forward to upstream.
    log(`  fast-forward ${target.name} → ${target.rev}`);
    const pull = git(dir, ['merge', '--ff-only', target.rev]);
    if (gitOk(pull)) return { ok: true, changed: true };
    if (!opts.force) {
      return {
        ok: false,
        error: `fast-forward failed (local commits or dirty tree?). Re-run with --force to hard-reset to ${target.rev}.\n` +
          (pull.stderr || pull.stdout || '').trim(),
      };
    }
    log(`  --force: git reset --hard ${target.rev}`);
    const hard = git(dir, ['reset', '--hard', target.rev]);
    if (!gitOk(hard)) {
      return {
        ok: false,
        error: `git reset --hard failed: ${(hard.stderr || hard.stdout || '').trim()}`,
      };
    }
    return { ok: true, changed: true };
  }

  // Tag or explicit ref — checkout.
  log(`  checkout ${target.name}`);
  let co = git(dir, ['checkout', '--detach', target.rev]);
  if (!gitOk(co) && opts.force) {
    log(`  --force: git reset --hard ${target.rev}`);
    co = git(dir, ['reset', '--hard', target.rev]);
  }
  if (!gitOk(co)) {
    // Fallback: plain checkout (branch ref)
    co = git(dir, ['checkout', target.name]);
    if (!gitOk(co) && opts.force) {
      const rev = target.rev;
      log(`  --force: git reset --hard ${rev}`);
      co = git(dir, ['reset', '--hard', rev]);
    }
  }
  if (!gitOk(co)) {
    return {
      ok: false,
      error: `checkout ${target.name} failed: ${(co.stderr || co.stdout || '').trim()}`,
    };
  }
  return { ok: true, changed: true };
}

function defaultRunInstall(sourceDir, spawnSync, log) {
  const installer = path.join(sourceDir, 'bin', 'install.js');
  if (!fs.existsSync(installer)) {
    return { ok: false, error: `installer missing: ${installer}` };
  }
  log(`  $ node ${installer} --non-interactive --force`);
  const r = spawnSync(process.execPath, [installer, '--non-interactive', '--force'], {
    cwd: sourceDir,
    encoding: 'utf8',
    env: process.env,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    return { ok: false, error: `installer exited ${r.status}`, status: r.status };
  }
  // The child already printed its own summary; runUpdate falls back to
  // "(see installer summary above)" when the list is empty.
  return { ok: true, installed: [] };
}

/**
 * Run the update flow.
 * @param {object} opts — from parseUpdateArgs
 * @param {object} [deps] — injectable for tests
 * @returns {{ exitCode: number, before?: string, after?: string, reinstalled?: string[], changed?: boolean }}
 */
function runUpdate(opts, deps) {
  const spawnSync = (deps && deps.spawnSync) || child_process.spawnSync;
  const git = (deps && deps.git) || makeGit(spawnSync);
  const log = (deps && deps.log) || ((s) => process.stdout.write(s + '\n'));
  const err = (deps && deps.err) || ((s) => process.stderr.write(s + '\n'));
  const runInstall = (deps && deps.runInstall) || ((dir) => defaultRunInstall(dir, spawnSync, log));
  const candidates = (deps && deps.candidates) || [
    deps && deps.repoRoot,
    process.cwd(),
  ];

  if (opts.help) {
    printUpdateHelp();
    return { exitCode: 0 };
  }

  log('🦉 TLDR update');
  log(`  ${REPO}`);

  const source = resolveSourceDir(candidates, git);
  log(`  source: ${source.dir} (${source.kind})`);

  const cloned = ensureClone(source.dir, opts, git, log);
  if (!cloned.ok) {
    err(`error: ${cloned.error}`);
    return { exitCode: 1 };
  }
  if (cloned.pending) {
    // --check / --dry-run with no cache yet
    if (opts.check) {
      log('  status: no local source yet (run `tldr update` to clone + install)');
      return { exitCode: 0, before: null, after: null, changed: false };
    }
    log('  dry-run: would clone, fetch, update, and reinstall');
    return { exitCode: 0, before: null, after: null, changed: false };
  }

  const before = getHeadSha(source.dir, git);
  const beforeLabel = currentDescribe(source.dir, git);
  log(`  before: ${shortSha(before)} (${beforeLabel})`);

  const fetched = fetchAll(source.dir, git);
  if (!fetched.ok) {
    err(`error: ${fetched.error}`);
    return { exitCode: 1, before };
  }

  const target = resolveTarget(source.dir, git, opts);
  if (target.error) {
    err(`error: ${target.error}`);
    return { exitCode: 1, before };
  }

  const tipSha = revSha(source.dir, git, target.rev);
  const tipLabel = target.name;
  log(`  target: ${shortSha(tipSha)} (${tipLabel}, ${target.kind})`);

  if (opts.check) {
    const available = before && tipSha && before !== tipSha;
    if (available) {
      log(`  status: update available (${shortSha(before)} → ${shortSha(tipSha)})`);
    } else {
      log('  status: already up to date');
    }
    return {
      exitCode: 0,
      before,
      after: tipSha,
      changed: Boolean(available),
      check: true,
    };
  }

  if (opts.dryRun) {
    if (before && tipSha && before === tipSha) {
      log('  dry-run: already up to date (would skip reinstall)');
    } else {
      log(`  dry-run: would update ${shortSha(before)} → ${shortSha(tipSha)}`);
      log('  dry-run: would re-run installer --non-interactive --force');
    }
    return {
      exitCode: 0,
      before,
      after: tipSha,
      changed: Boolean(before && tipSha && before !== tipSha),
      dryRun: true,
    };
  }

  const applied = applyUpdate(source.dir, git, target, opts, log);
  if (!applied.ok) {
    err(`error: ${applied.error}`);
    return { exitCode: 1, before };
  }

  const after = getHeadSha(source.dir, git);
  const afterLabel = currentDescribe(source.dir, git);
  log(`  after:  ${shortSha(after)} (${afterLabel})`);

  let reinstalled = [];
  if (!applied.changed && before && after && before === after) {
    log('  already up to date — skipping reinstall');
  } else {
    log('  reinstalling agents (non-interactive)…');
    const inst = runInstall(source.dir);
    if (!inst.ok) {
      err(`error: ${inst.error}`);
      return { exitCode: 1, before, after, changed: true };
    }
    reinstalled = inst.installed || [];
  }

  log('');
  log('🦉 update complete');
  log(`  before: ${shortSha(before)}`);
  log(`  after:  ${shortSha(after)}`);
  if (reinstalled.length) {
    log(`  reinstalled: ${reinstalled.join(', ')}`);
  } else if (applied.changed) {
    log('  reinstalled: (see installer summary above)');
  } else {
    log('  reinstalled: (skipped — already up to date)');
  }

  return {
    exitCode: 0,
    before,
    after,
    changed: Boolean(applied.changed),
    reinstalled,
  };
}

module.exports = {
  REPO,
  REPO_URL,
  parseUpdateArgs,
  resolveSourceDir,
  findLatestReleaseTag,
  runUpdate,
};
