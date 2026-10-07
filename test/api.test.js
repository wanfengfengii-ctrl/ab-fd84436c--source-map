'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { server } = require('../src/server');
const { plainMap } = require('./helpers');

let baseUrl;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function postResolve(body) {
  const response = await fetch(`${baseUrl}/api/sourcemaps/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

const MAP = plainMap({
  sources: ['webpack:///src/app.ts'],
  names: ['boot'],
  lines: [
    [[0, 0, 0, 0, 0]],
    [],
    [[4, 0, 2, 6]],
  ],
});

test('GET /health returns ok', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('resolves frames and preserves request order', async () => {
  const { status, json } = await postResolve({
    sourceMap: MAP,
    frames: [
      { id: 'frame-c', line: 3, column: 4 },
      { id: 'frame-a', line: 1, column: 0 },
      { id: 'frame-gap', line: 2, column: 0 },
    ],
  });
  assert.equal(status, 200);
  assert.deepEqual(json, {
    results: [
      {
        id: 'frame-c',
        status: 'mapped',
        mapped: true,
        source: 'webpack:///src/app.ts',
        line: 3,
        column: 6,
        name: null,
      },
      {
        id: 'frame-a',
        status: 'mapped',
        mapped: true,
        source: 'webpack:///src/app.ts',
        line: 1,
        column: 0,
        name: 'boot',
      },
      {
        id: 'frame-gap',
        status: 'unmapped',
        mapped: false,
        source: null,
        line: null,
        column: null,
        name: null,
      },
    ],
  });
});

test('repeated identical requests return identical results', async () => {
  const request = {
    sourceMap: MAP,
    frames: [
      { id: 1, line: 1, column: 0 },
      { id: 2, line: 3, column: 100 },
      { id: 3, line: 2, column: 0 },
    ],
  };
  const first = await postResolve(request);
  const second = await postResolve(request);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, second.json);
});

test('rejects invalid JSON body', async () => {
  const { status, json } = await postResolve('{not json');
  assert.equal(status, 400);
  assert.equal(json.error.code, 'INVALID_JSON');
});

test('rejects non-object body', async () => {
  const { status, json } = await postResolve('[1,2,3]');
  assert.equal(status, 400);
  assert.equal(json.error.code, 'INVALID_REQUEST');
});

test('rejects invalid frames with frame context', async () => {
  const { status, json } = await postResolve({
    sourceMap: MAP,
    frames: [{ id: 'x', line: 0, column: 0 }],
  });
  assert.equal(status, 400);
  assert.equal(json.error.code, 'INVALID_REQUEST');
  assert.equal(json.error.context.frameIndex, 0);
  assert.equal(json.error.context.id, 'x');
});

test('rejects duplicate frame ids', async () => {
  const { status, json } = await postResolve({
    sourceMap: MAP,
    frames: [
      { id: 'a', line: 1, column: 0 },
      { id: 'a', line: 1, column: 1 },
    ],
  });
  assert.equal(status, 400);
  assert.equal(json.error.code, 'DUPLICATE_FRAME_ID');
});

test('rejects malformed mappings with stable code and location context', async () => {
  const { status, json } = await postResolve({
    sourceMap: { version: 3, sources: ['a.js'], names: [], mappings: 'AAAA,B!BA' },
    frames: [{ id: 'f', line: 1, column: 0 }],
  });
  assert.equal(status, 422);
  assert.equal(json.error.code, 'INVALID_VLQ');
  assert.equal(json.error.context.generatedLine, 0);
  assert.equal(json.error.context.segmentIndex, 1);
});

test('rejects unsupported external section url', async () => {
  const { status, json } = await postResolve({
    sourceMap: {
      version: 3,
      sections: [{ offset: { line: 0, column: 0 }, url: 'https://example.com/x.map' }],
    },
    frames: [{ id: 'f', line: 1, column: 0 }],
  });
  assert.equal(status, 422);
  assert.equal(json.error.code, 'UNSUPPORTED_SECTION_URL');
  assert.deepEqual(json.error.context.sectionPath, [0]);
});

test('rejects non-POST methods on the resolve endpoint', async () => {
  const response = await fetch(`${baseUrl}/api/sourcemaps/resolve`, { method: 'GET' });
  assert.equal(response.status, 405);
  const json = await response.json();
  assert.equal(json.error.code, 'METHOD_NOT_ALLOWED');
});

test('unknown routes return 404', async () => {
  const response = await fetch(`${baseUrl}/nope`, { method: 'GET' });
  assert.equal(response.status, 404);
  const json = await response.json();
  assert.equal(json.error.code, 'NOT_FOUND');
});
