'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Production-grade safe filesystem helpers for TLDR.
 * All security-sensitive writes and traversals in the installer
 * and hooks should eventually go through these.
 *
 * Goals:
 * - Eliminate predictable temp file names (CWE-377)
 * - Prevent symlink traversal / TOCTOU attacks on config and hook files
 * - Provide atomic writes with restrictive permissions
 * - Offer basic root confinement for user-supplied target directories
 */

function createSecureTempDir(prefix = 'tldr-') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Best-effort restrictive permissions (owner read/write/exec only)
  try { fs.chmodSync(base, 0o700); } catch (_) {}
  return base;
}

/**
 * Atomic write using a secure temp dir on the same filesystem as the target.
 * rename(2) is only atomic when source and destination share a device; using
 * os.tmpdir() can hit EXDEV for config dirs mounted elsewhere.
 */
function atomicWrite(dest, content, mode = 0o600) {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });

  const tempDir = fs.mkdtempSync(path.join(dir, '.tldr-atomic-'));
  try { fs.chmodSync(tempDir, 0o700); } catch (_) {}
  const tempFile = path.join(tempDir, 'write.tmp');

  try {
    fs.writeFileSync(tempFile, content, { mode });
    fs.renameSync(tempFile, dest);
  } finally {
    try { fs.unlinkSync(tempFile); } catch (_) {}
    try { fs.rmdirSync(tempDir); } catch (_) {}
  }
}

/**
 * Resolve a user-supplied target directory safely.
 * Returns the realpath if it exists, otherwise a resolved path.
 * Does NOT throw on traversal for tldr-init (user explicitly chooses target),
 * but we still resolve symlinks in the path for predictability.
 */
function resolveSafeTarget(target) {
  try {
    return fs.realpathSync(target);
  } catch (_) {
    return path.resolve(target);
  }
}

/**
 * Best-effort cleanup of a directory we created.
 */
function safeRmdir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

module.exports = {
  createSecureTempDir,
  atomicWrite,
  resolveSafeTarget,
  safeRmdir,
};
