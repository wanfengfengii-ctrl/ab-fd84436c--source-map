#!/usr/bin/env node
// End-to-end smoke test against a running server.
//
// Exercises the real HTTP stack: health check, a plain mapping resolution,
// an indexed (sections) resolution with chunk-offset translation, explicit
// unmapped verdicts, and repeat-call determinism. Exits non-zero on the
// first failed expectation so the one-shot `verify` service reports
// accurately.
import { encodeMappings } from './vlq-builder.js';

const PORT = process.env.PORT ?? '8080';
const HOST = process.env.HOST ?? '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitForHealth(deadlineMs) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become healthy: ${lastErr?.message ?? 'no response'}`);
}

async function resolve(payload) {
  const res = await fetch(`${BASE}/api/sourcemaps/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await res.json();
  return { status: res.status, body };
}

// Plain map:
//  gen line 1: col 0  -> src/index.ts 12:10(0-based 9) name bootstrap
//              col 30 -> explicit unmapped marker
//  gen line 2: col 0  -> src/utils.ts 41:0
//  gen line 3: empty
const flatMap = {
  version: 3,
  file: 'bundle.min.js',
  sources: ['src/index.ts', 'src/utils.ts'],
  names: ['bootstrap'],
  mappings: encodeMappings([
    [[0, 0, 11, 9, 0], [30]],
    [[0, 1, 40, 0]],
    []
  ])
};

const sectionedMap = {
  version: 3,
  sections: [
    {
      offset: { line: 0, column: 0 },
      map: {
        version: 3,
        sources: ['chunk-vendor.js'],
        names: ['react'],
        mappings: encodeMappings([[[0, 0, 0, 0, 0]]]) // -> vendor 1:1 name react
      }
    },
    {
      offset: { line: 0, column: 1000 },
      map: {
        version: 3,
        sources: ['chunk-app.js'],
        names: ['render'],
        mappings: encodeMappings([
          [[0, 0, 19, 4, 0]], // local line 1 -> app 20:5(0-based 4) name render
          [[0, 0, 20, 0]] // local line 2 -> app 21:1
        ])
      }
    },
    {
      offset: { line: 3, column: 0 },
      map: {
        version: 3,
        sources: ['chunk-runtime.js'],
        mappings: encodeMappings([[[0, 0, 0, 0]]]) // -> runtime 1:1
      }
    }
  ]
};

async function main() {
  console.log(`smoke against ${BASE}`);
  await waitForHealth(30_000);
  console.log('  ok   GET /health');

  // ---- 1. Plain mapping ------------------------------------------------
  console.log('plain mappings:');
  const frames = [
    { id: 'f-0', line: 1, column: 0 },
    { id: 'f-5', line: 1, column: 5 },
    { id: 'f-30', line: 1, column: 30 },
    { id: 'f-40', line: 1, column: 40 },
    { id: 'f-l2', line: 2, column: 0 },
    { id: 'f-l3', line: 3, column: 0 }
  ];
  const r1 = await resolve({ sourceMap: flatMap, frames });
  check('status 200', r1.status === 200, `got ${r1.status}`);

  const byId = Object.fromEntries((r1.body.results ?? []).map((r) => [r.id, r]));
  check(
    'f-0 maps with source/line/column/name',
    (() => {
      const v = byId['f-0']?.result;
      return v && v.source === 'src/index.ts' && v.line === 12 && v.column === 9 && v.name === 'bootstrap';
    })(),
    JSON.stringify(byId['f-0'])
  );
  check(
    'f-5 (col < 30) still resolves to the first segment',
    byId['f-5']?.status === 'mapped' && byId['f-5'].result.source === 'src/index.ts',
    JSON.stringify(byId['f-5'])
  );
  check('f-30 hits the explicit unmapped marker', byId['f-30']?.status === 'unmapped',
    JSON.stringify(byId['f-30']));
  check('f-40 stays unmapped after marker', byId['f-40']?.status === 'unmapped',
    JSON.stringify(byId['f-40']));
  check(
    'line 2 maps to utils.ts 41:1',
    byId['f-l2']?.status === 'mapped'
      && byId['f-l2'].result.source === 'src/utils.ts'
      && byId['f-l2'].result.line === 41
      && byId['f-l2'].result.column === 0,
    JSON.stringify(byId['f-l2'])
  );
  check('line 3 (empty) is unmapped', byId['f-l3']?.status === 'unmapped',
    JSON.stringify(byId['f-l3']));
  check(
    'result order matches request order',
    JSON.stringify(r1.body.results.map((x) => x.id)) === JSON.stringify(frames.map((f) => f.id))
  );

  // ---- 2. Sections ------------------------------------------------------
  console.log('indexed sections:');
  const sframes = [
    { id: 'vendor', line: 1, column: 0 },
    { id: 'pre-app', line: 1, column: 999 },
    { id: 'app', line: 1, column: 1000 },
    { id: 'app-l2', line: 2, column: 0 },
    { id: 'gap', line: 3, column: 5 },
    { id: 'runtime', line: 4, column: 0 }
  ];
  const r2 = await resolve({ sourceMap: sectionedMap, frames: sframes });
  check('status 200', r2.status === 200, `got ${r2.status}: ${JSON.stringify(r2.body)}`);
  const sby = Object.fromEntries((r2.body.results ?? []).map((r) => [r.id, r]));

  check(
    'vendor section at (1,0)',
    sby.vendor?.status === 'mapped'
      && sby.vendor.result.source === 'chunk-vendor.js'
      && sby.vendor.result.line === 1
      && sby.vendor.result.name === 'react'
      && sby.vendor.section === 0,
    JSON.stringify(sby.vendor)
  );
  check('column 999 still belongs to vendor', sby['pre-app']?.section === 0
    && sby['pre-app'].status === 'mapped', JSON.stringify(sby['pre-app']));
  check(
    'app section at offset column 1000',
    sby.app?.status === 'mapped'
      && sby.app.result.source === 'chunk-app.js'
      && sby.app.result.line === 20 && sby.app.result.column === 4
      && sby.app.result.name === 'render' && sby.app.section === 1,
    JSON.stringify(sby.app)
  );
  check(
    'app section second generated line (no column shift)',
    sby['app-l2']?.status === 'mapped'
      && sby['app-l2'].result.source === 'chunk-app.js'
      && sby['app-l2'].result.line === 21
      && sby['app-l2'].result.column === 0
      && sby['app-l2'].section === 1,
    JSON.stringify(sby['app-l2'])
  );
  check('global line 3 before runtime offset is unmapped',
    sby.gap?.status === 'unmapped' && sby.gap.section === 1,
  JSON.stringify(sby.gap));
  check(
    'runtime section at global line 4',
    sby.runtime?.status === 'mapped'
      && sby.runtime.result.source === 'chunk-runtime.js'
      && sby.runtime.result.line === 1
      && sby.runtime.section === 2,
    JSON.stringify(sby.runtime)
  );

  // ---- 3. Determinism ---------------------------------------------------
  console.log('determinism:');
  const r1b = await resolve({ sourceMap: flatMap, frames });
  const r2b = await resolve({ sourceMap: sectionedMap, frames: sframes });
  check('flat map repeated call is identical',
    JSON.stringify(r1b.body) === JSON.stringify(r1.body));
  check('sections repeated call is identical',
    JSON.stringify(r2b.body) === JSON.stringify(r2.body));

  // ---- 4. A representative rejection -----------------------------------
  console.log('rejection:');
  const bad = await resolve({
    sourceMap: { version: 3, sources: ['a.js'], mappings: 'AAAA,=' },
    frames: [{ id: 1, line: 1, column: 0 }]
  });
  check(
    'illegal VLQ rejected with stable code and context',
    bad.status === 400 && bad.body?.error?.code === 'VLQ_INVALID'
      && bad.body.error.context?.segmentIndex === 1
      && bad.body.error.context?.character === '=',
    JSON.stringify(bad.body)
  );

  if (failures > 0) {
    console.error(`SMOKE FAILED: ${failures} check(s)`);
    process.exit(1);
  }
  console.log('smoke: ALL PASS');
}

main().catch((err) => {
  console.error(`SMOKE ERRORED: ${err.stack ?? err}`);
  process.exit(1);
});
