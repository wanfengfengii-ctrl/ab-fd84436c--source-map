'use strict';

/**
 * Production build validation for this zero-dependency service:
 *   1. syntax-check every shipped source file (`node --check`)
 *   2. load every module to catch missing requires / top-level failures
 *   3. run a resolution self-check against a known map
 *   4. emit dist/build-manifest.json with file hashes for traceability
 */
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIRS = ['src', 'scripts'];
const DIST_DIR = path.join(ROOT, 'dist');

function listJsFiles(dir) {
  const absolute = path.join(ROOT, dir);
  return fs
    .readdirSync(absolute)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(dir, name))
    .sort();
}

function main() {
  const files = SOURCE_DIRS.flatMap(listJsFiles);
  if (files.length === 0) {
    throw new Error('no source files found');
  }

  for (const file of files) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
  }
  console.log(`build: syntax check passed for ${files.length} files`);

  // Module load check (server.js must not start listening when required).
  const { resolveRequest } = require(path.join(ROOT, 'src', 'sourcemap.js'));
  require(path.join(ROOT, 'src', 'server.js'));
  require(path.join(ROOT, 'src', 'vlq.js'));
  require(path.join(ROOT, 'src', 'errors.js'));
  console.log('build: module load check passed');

  // Resolution self-check: known input must produce the known output.
  const probe = resolveRequest({
    sourceMap: { version: 3, sources: ['self-check.js'], names: [], mappings: 'AAAA' },
    frames: [{ id: 'self-check', line: 1, column: 0 }],
  });
  const hit = probe.results[0];
  if (!hit.mapped || hit.source !== 'self-check.js' || hit.line !== 1 || hit.column !== 0) {
    throw new Error(`resolution self-check failed: ${JSON.stringify(probe)}`);
  }
  console.log('build: resolution self-check passed');

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const manifest = {
    service: 'sourcemap-resolve-service',
    builtAt: new Date().toISOString(),
    node: process.version,
    files: files.map((file) => ({
      path: file,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex'),
    })),
  };
  fs.writeFileSync(path.join(DIST_DIR, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`build: manifest written to ${path.relative(ROOT, DIST_DIR)}/build-manifest.json`);
  console.log('build: OK');
}

main();
