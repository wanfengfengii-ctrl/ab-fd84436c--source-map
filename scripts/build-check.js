#!/usr/bin/env node
// Production build validation.
//
// The service ships as dependency-free native ESM, so the "build" is the
// guarantee that every source file parses and that the production import
// graph loads and resolves a representative map. Failing any check exits
// non-zero so the `verify` container reports a failed build.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSourceMap } from '../src/parser.js';
import { resolveAll } from '../src/resolver.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function listJs(dir) {
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => join(e.parentPath ?? join(root, dir), e.name));
}

let failed = 0;

// 1. Syntax check every JavaScript file that ships in the image.
const files = [...listJs('src'), ...listJs('scripts'), ...listJs('test')];
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`syntax check failed: ${file}\n${r.stderr}`);
  }
}
console.log(`syntax check: ${files.length} files`);

// 2. Exercise the production modules (imports resolve, map parses and
//    resolves end to end without any third-party dependency).
const map = parseSourceMap({
  version: 3,
  sources: ['src/app.ts'],
  names: ['main'],
  mappings: 'AAAAA;AACA'
});
const verdicts = resolveAll(map, [
  { id: 'a', line: 1, column: 0 },
  { id: 'b', line: 2, column: 0 },
  { id: 'c', line: 3, column: 0 }
]);
if (verdicts[0].status !== 'mapped' || verdicts[0].result.name !== 'main') {
  console.error('production module check failed at frame a:', verdicts[0]);
  failed++;
}
if (verdicts[1].status !== 'mapped') {
  console.error('production module check failed at frame b:', verdicts[1]);
  failed++;
}
if (verdicts[2].status !== 'unmapped') {
  console.error('production module check failed at frame c:', verdicts[2]);
  failed++;
}
console.log('production module check: parse + resolve ok');

if (failed > 0) {
  console.error(`BUILD CHECK FAILED (${failed} problem(s))`);
  process.exit(1);
}
console.log('build check: PASS');
