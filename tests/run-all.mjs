#!/usr/bin/env node
// Runs every test suite in tests/ by glob, so new files are picked up without
// editing this script or ci.yml. `--js-only` skips the Python gates (used by
// the CI Node matrix; Python gates run once in their own job).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tests = path.dirname(fileURLToPath(import.meta.url));
const jsOnly = process.argv.includes('--js-only');
const ls = (dir, pred) => readdirSync(dir).filter(pred).sort().map((f) => path.join(dir, f));

const runs = [
  ['node', ['--test', ...ls(path.join(tests, 'installer'), (f) => f.endsWith('.test.mjs'))]],
  ...ls(tests, (f) => f.startsWith('test_') && f.endsWith('.js')).map((f) => ['node', [f]]),
  ...(jsOnly ? [] : ls(tests, (f) => f.endsWith('.py')).map((f) => ['python3', [f]])),
];

for (const [cmd, args] of runs) {
  console.log(`\n== ${cmd} ${args[args.length - 1]}`);
  const { status } = spawnSync(cmd, args, { stdio: 'inherit', cwd: path.dirname(tests) });
  if (status !== 0) process.exit(status ?? 1);
}
console.log('\nAll test suites passed.');
