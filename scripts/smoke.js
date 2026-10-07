'use strict';

/**
 * Smoke test against a running API: waits for the health check, then verifies
 * plain-mappings and sectioned-mappings resolution end to end, including
 * determinism across repeated calls. Exits non-zero on any failure.
 */
const { plainMapFixture, sectionedMapFixture } = require('./fixtures');

const API_URL = (process.env.API_URL || 'http://localhost:8080').replace(/\/$/, '');
const HEALTH_TIMEOUT_MS = 60_000;

function fail(message) {
  console.error(`smoke: FAIL: ${message}`);
  process.exit(1);
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_URL}/health`);
      if (response.ok) {
        console.log('smoke: health check passed');
        return;
      }
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail(`API did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s (${lastError})`);
}

async function resolveFrames(sourceMap, frames) {
  const response = await fetch(`${API_URL}/api/sourcemaps/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceMap, frames }),
  });
  if (response.status !== 200) {
    fail(`resolve returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    fail(`${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

async function smokePlainMappings() {
  const frames = [
    { id: 'smoke-1', line: 1, column: 0 },
    { id: 'smoke-2', line: 1, column: 20 },
    { id: 'smoke-3', line: 2, column: 0 },
    { id: 'smoke-4', line: 3, column: 10 },
    { id: 'smoke-5', line: 3, column: 25 },
  ];
  const { results } = await resolveFrames(plainMapFixture(), frames);

  const expected = [
    ['smoke-1', true, 'webpack:///src/index.ts', 1, 0, 'renderApp'],
    ['smoke-2', true, 'webpack:///src/util.ts', 3, 4, 'formatBytes'],
    ['smoke-3', false, null, null, null, null],
    ['smoke-4', true, 'webpack:///src/index.ts', 11, 8, null],
    ['smoke-5', true, 'webpack:///src/util.ts', 8, 0, null],
  ];
  assertDeepEqual(
    results.map((r) => [r.id, r.mapped, r.source, r.line, r.column, r.name]),
    expected,
    'plain mappings results mismatch',
  );

  // Determinism: the same request again must produce an identical body.
  const again = await resolveFrames(plainMapFixture(), frames);
  assertDeepEqual(again.results, results, 'plain mappings not deterministic');
  console.log('smoke: plain mappings OK (5 frames, deterministic)');
}

async function smokeSectionedMappings() {
  const frames = [
    { id: 'sec-1', line: 1, column: 0 }, // section 1, first line
    { id: 'sec-2', line: 2, column: 8 }, // section 1, second line
    { id: 'sec-3', line: 3, column: 5 }, // before section 2 column offset
    { id: 'sec-4', line: 3, column: 6 }, // section 2 starts here
    { id: 'sec-5', line: 4, column: 12 }, // section 2, second line
    { id: 'sec-6', line: 9, column: 0 }, // beyond everything
  ];
  const { results } = await resolveFrames(sectionedMapFixture(), frames);

  const expected = [
    ['sec-1', true, 'webpack:///chunk-vendors.js', 101, 0, null],
    ['sec-2', true, 'webpack:///chunk-vendors.js', 101, 30, null],
    ['sec-3', false, null, null, null, null],
    ['sec-4', true, 'webpack:///chunk-app.js', 1, 0, 'bootstrap'],
    ['sec-5', true, 'webpack:///chunk-app.js', 6, 2, null],
    ['sec-6', false, null, null, null, null],
  ];
  assertDeepEqual(
    results.map((r) => [r.id, r.mapped, r.source, r.line, r.column, r.name]),
    expected,
    'sectioned mappings results mismatch',
  );

  const again = await resolveFrames(sectionedMapFixture(), frames);
  assertDeepEqual(again.results, results, 'sectioned mappings not deterministic');
  console.log('smoke: sectioned mappings OK (6 frames, deterministic)');
}

async function main() {
  console.log(`smoke: targeting ${API_URL}`);
  await waitForHealth();
  await smokePlainMappings();
  await smokeSectionedMappings();
  console.log('smoke: all smoke checks passed');
}

main().catch((error) => fail(error.stack || error.message));
