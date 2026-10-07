'use strict';

/**
 * One-shot verification pipeline, run by the `verify` compose service:
 *   1. code tests (node --test)
 *   2. production build validation (scripts/build.js)
 *   3. smoke tests: plain mappings + sectioned mappings (scripts/smoke.js)
 * Exits 0 when every step passes, 1 otherwise.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const steps = [
  { name: 'code tests', command: [process.execPath, ['--test', 'test/**/*.test.js']] },
  { name: 'production build validation', command: [process.execPath, ['scripts/build.js']] },
  { name: 'smoke: plain + sectioned mappings', command: [process.execPath, ['scripts/smoke.js']] },
];

function runStep({ name, command }) {
  console.log(`\n=== verify: ${name} ===`);
  const result = spawnSync(command[0], command[1], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(`verify: ${name}: failed to start: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`verify: ${name}: FAILED (exit ${result.status})`);
    return false;
  }
  console.log(`verify: ${name}: OK`);
  return true;
}

const results = steps.map((step) => ({ name: step.name, ok: runStep(step) }));
const failed = results.filter((r) => !r.ok);

console.log('\n=== verify summary ===');
for (const { name, ok } of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

if (failed.length > 0) {
  console.error(`verify: ${failed.length} step(s) failed`);
  process.exit(1);
}
console.log('verify: all checks passed');
process.exit(0);
