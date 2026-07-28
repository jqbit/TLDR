import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { atomicWrite, createSecureTempDir, safeLstat, resolveSafeTarget, safeRmdir } =
  require(path.join(root, 'bin', 'lib', 'safe-fs.js'));

test('atomicWrite writes content, creates parent dirs, leaves no temp litter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tldr-safefs-'));
  try {
    const dest = path.join(dir, 'nested', 'out.txt');
    atomicWrite(dest, 'hello');
    assert.equal(fs.readFileSync(dest, 'utf8'), 'hello');
    const litter = fs.readdirSync(path.dirname(dest)).filter((f) => f.startsWith('.tldr-atomic-'));
    assert.deepEqual(litter, []);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atomicWrite overwrites existing file atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tldr-safefs-'));
  try {
    const dest = path.join(dir, 'out.txt');
    atomicWrite(dest, 'one');
    atomicWrite(dest, 'two');
    assert.equal(fs.readFileSync(dest, 'utf8'), 'two');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('safeLstat refuses symlinks, allows regular files', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tldr-safefs-'));
  try {
    const file = path.join(dir, 'real.txt');
    fs.writeFileSync(file, 'x');
    assert.ok(safeLstat(file).isFile());
    const link = path.join(dir, 'link.txt');
    fs.symlinkSync(file, link);
    assert.throws(() => safeLstat(link), /symlink/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createSecureTempDir is owner-only and safeRmdir removes it', () => {
  const dir = createSecureTempDir();
  assert.ok(fs.existsSync(dir));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
  safeRmdir(dir);
  assert.ok(!fs.existsSync(dir));
});

test('resolveSafeTarget resolves symlinked existing paths and normalizes missing ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tldr-safefs-'));
  try {
    assert.equal(resolveSafeTarget(dir), fs.realpathSync(dir));
    const missing = path.join(dir, 'nope', '..', 'target');
    assert.equal(resolveSafeTarget(missing), path.join(dir, 'target'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
