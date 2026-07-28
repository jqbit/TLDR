#!/usr/bin/env node
// Tests for safeWriteFlag / readFlag behavior with symlinked parent directories.
// Covers fix for issue #207: safeWriteFlag refuses flag writes when ~/.claude
// is a symlink.
//
// Run: node tests/test_symlink_flag.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { safeWriteFlag, readFlag, VALID_MODES } = require('../src/hooks/tldr-config');

let passed = 0;
let failed = 0;

function test(name, fn) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tldr-symlink-test-'));
  try {
    fn(tmpBase);
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

console.log('safeWriteFlag + readFlag symlink tests\n');

// ---------- safeWriteFlag ----------

test('writes flag in normal (non-symlinked) directory', (tmp) => {
  const flagDir = path.join(tmp, 'claude-config');
  fs.mkdirSync(flagDir, { recursive: true });
  const flagPath = path.join(flagDir, '.tldr-active');

  safeWriteFlag(flagPath, 'full');

  assert.strictEqual(fs.readFileSync(flagPath, 'utf8'), 'full');
});

test('writes flag when parent directory is a symlink owned by current user', (tmp) => {
  // Create real directory and symlink to it (simulating ~/.claude -> /real/path)
  const realDir = path.join(tmp, 'real-claude-config');
  fs.mkdirSync(realDir, { recursive: true });
  const symlinkDir = path.join(tmp, 'claude-symlink');
  fs.symlinkSync(realDir, symlinkDir);

  const flagPath = path.join(symlinkDir, '.tldr-active');
  safeWriteFlag(flagPath, 'ultra');

  // Flag should exist in the real directory
  const realFlagPath = path.join(realDir, '.tldr-active');
  assert.strictEqual(fs.existsSync(realFlagPath), true, 'flag file should exist in resolved dir');
  assert.strictEqual(fs.readFileSync(realFlagPath, 'utf8'), 'ultra');
});

test('readFlag works through symlinked parent directory', (tmp) => {
  const realDir = path.join(tmp, 'real-claude-config');
  fs.mkdirSync(realDir, { recursive: true });
  const symlinkDir = path.join(tmp, 'claude-symlink');
  fs.symlinkSync(realDir, symlinkDir);

  // Write directly to real path, then read through symlink path
  const realFlagPath = path.join(realDir, '.tldr-active');
  fs.writeFileSync(realFlagPath, 'ultra', { mode: 0o600 });

  const result = readFlag(path.join(symlinkDir, '.tldr-active'));
  assert.strictEqual(result, 'ultra');
});

test('safeWriteFlag then readFlag round-trip through symlink', (tmp) => {
  const realDir = path.join(tmp, 'real-config');
  fs.mkdirSync(realDir, { recursive: true });
  const symlinkDir = path.join(tmp, 'link-config');
  fs.symlinkSync(realDir, symlinkDir);

  const flagPath = path.join(symlinkDir, '.tldr-active');
  safeWriteFlag(flagPath, 'ultra');

  // Read back through the same symlink path
  const result = readFlag(flagPath);
  assert.strictEqual(result, 'ultra');
});

test('refuses flag file that is itself a symlink (even through symlinked parent)', (tmp) => {
  const realDir = path.join(tmp, 'real-config');
  fs.mkdirSync(realDir, { recursive: true });
  const symlinkDir = path.join(tmp, 'link-config');
  fs.symlinkSync(realDir, symlinkDir);

  // Create a symlink at the flag file location pointing to some other file
  const decoyFile = path.join(tmp, 'decoy.txt');
  fs.writeFileSync(decoyFile, 'ATTACK');
  const realFlagPath = path.join(realDir, '.tldr-active');
  fs.symlinkSync(decoyFile, realFlagPath);

  // safeWriteFlag should refuse (flag file is a symlink)
  safeWriteFlag(path.join(symlinkDir, '.tldr-active'), 'full');
  // The decoy should NOT have been overwritten
  assert.strictEqual(fs.readFileSync(decoyFile, 'utf8'), 'ATTACK');
});

test('readFlag refuses flag file that is a symlink', (tmp) => {
  const realDir = path.join(tmp, 'real-config');
  fs.mkdirSync(realDir, { recursive: true });

  const secretFile = path.join(tmp, 'secret.txt');
  fs.writeFileSync(secretFile, 'SSH_PRIVATE_KEY_CONTENT');
  fs.symlinkSync(secretFile, path.join(realDir, '.tldr-active'));

  const result = readFlag(path.join(realDir, '.tldr-active'));
  assert.strictEqual(result, null, 'should refuse symlinked flag file');
});

test('flag file permissions are 0600 when written through symlink', (tmp) => {
  if (process.platform === 'win32') return; // skip on Windows

  const realDir = path.join(tmp, 'real-config');
  fs.mkdirSync(realDir, { recursive: true });
  const symlinkDir = path.join(tmp, 'link-config');
  fs.symlinkSync(realDir, symlinkDir);

  safeWriteFlag(path.join(symlinkDir, '.tldr-active'), 'full');

  const realFlagPath = path.join(realDir, '.tldr-active');
  const stat = fs.statSync(realFlagPath);
  const mode = stat.mode & 0o777;
  assert.strictEqual(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
});

test('overwrites existing flag through symlinked parent', (tmp) => {
  const realDir = path.join(tmp, 'real-config');
  fs.mkdirSync(realDir, { recursive: true });
  const symlinkDir = path.join(tmp, 'link-config');
  fs.symlinkSync(realDir, symlinkDir);

  const flagPath = path.join(symlinkDir, '.tldr-active');

  safeWriteFlag(flagPath, 'full');
  assert.strictEqual(readFlag(flagPath), 'full');

  safeWriteFlag(flagPath, 'ultra');
  assert.strictEqual(readFlag(flagPath), 'ultra');
});

test('creates parent directory via mkdirSync even when it does not exist yet', (tmp) => {
  const flagDir = path.join(tmp, 'nonexistent', 'nested');
  const flagPath = path.join(flagDir, '.tldr-active');

  safeWriteFlag(flagPath, 'full');

  assert.strictEqual(fs.existsSync(flagPath), true);
  assert.strictEqual(fs.readFileSync(flagPath, 'utf8'), 'full');
});

test('symlink to nonexistent target silently fails', (tmp) => {
  const symlinkDir = path.join(tmp, 'broken-link');
  try {
    fs.symlinkSync('/nonexistent/path/that/does/not/exist', symlinkDir);
  } catch (e) {
    // Can't create symlink — skip
    return;
  }

  const flagPath = path.join(symlinkDir, '.tldr-active');
  // Should not throw
  safeWriteFlag(flagPath, 'full');
  // Flag should not exist (target doesn't exist)
  assert.strictEqual(fs.existsSync(path.join(symlinkDir, '.tldr-active')), false);
});

test('all valid modes round-trip through symlinked parent', (tmp) => {
  const realDir = path.join(tmp, 'real-config');
  fs.mkdirSync(realDir, { recursive: true });
  const symlinkDir = path.join(tmp, 'link-config');
  fs.symlinkSync(realDir, symlinkDir);

  const flagPath = path.join(symlinkDir, '.tldr-active');

  for (const mode of VALID_MODES) {
    safeWriteFlag(flagPath, mode);
    const read = readFlag(flagPath);
    assert.strictEqual(read, mode, `mode '${mode}' did not round-trip`);
  }
});

// ---------- Source code audit ----------

// ---------- Summary ----------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
