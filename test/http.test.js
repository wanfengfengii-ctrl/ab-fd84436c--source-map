import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHandler } from '../src/app.js';
import { flatMap } from './helpers.js';

let server;
let base;

before(async () => {
  server = createServer(createHandler());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(pathname, init) {
  const res = await fetch(base + pathname, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const post = (body) =>
  call('/api/sourcemaps/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });

const sampleFlat = flatMap({
  sources: ['src/app.ts'],
  names: ['bootstrap'],
  lines: [[[0, 0, 11, 8, 0], [20, 0, 14, 2]]]
});

test('GET /health reports ok', async () => {
  const { status, body } = await call('/health');
  assert.equal(status, 200);
  assert.deepEqual(body, { status: 'ok' });
});

test('resolves a flat map with source, line, column and name', async () => {
  const { status, body } = await post({
    sourceMap: sampleFlat,
    frames: [{ id: 'f1', line: 1, column: 0 }]
  });
  assert.equal(status, 200);
  assert.deepEqual(body.results[0], {
    id: 'f1',
    frame: { line: 1, column: 0 },
    status: 'mapped',
    result: { source: 'src/app.ts', line: 12, column: 8, name: 'bootstrap' }
  });
});

test('rightmost mapping wins and unmapped frames are marked explicitly', async () => {
  const { body } = await post({
    sourceMap: sampleFlat,
    frames: [
      { id: 1, line: 1, column: 19 },
      { id: 2, line: 1, column: 20 },
      { id: 3, line: 1, column: 1000 },
      { id: 4, line: 2, column: 0 }
    ]
  });
  assert.equal(body.results[0].result.column, 8);
  assert.equal(body.results[1].result.line, 26);
  assert.equal(body.results[1].result.column, 10);
  assert.equal(body.results[1].result.name, undefined);
  assert.equal(body.results[2].result.line, 26);
  assert.equal(body.results[3].status, 'unmapped');
});

test('results keep the exact request order', async () => {
  const frames = [
    { id: 'z', line: 1, column: 20 },
    { id: 'a', line: 1, column: 0 },
    { id: 'm', line: 9, column: 0 }
  ];
  const { body } = await post({ sourceMap: sampleFlat, frames });
  assert.deepEqual(body.results.map((r) => r.id), ['z', 'a', 'm']);
});

test('repeated calls return byte-identical results', async () => {
  const payload = {
    sourceMap: sampleFlat,
    frames: [
      { id: 'a', line: 1, column: 0 },
      { id: 'b', line: 1, column: 25 },
      { id: 'c', line: 3, column: 9 }
    ]
  };
  const r1 = await post(payload);
  const r2 = await post(payload);
  assert.equal(JSON.stringify(r1.body), JSON.stringify(r2.body));
});

test('indexed map with sections resolves with offset translation', async () => {
  const indexed = {
    version: 3,
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: flatMap({ sources: ['chunk0.js'], lines: [[[0, 0, 1, 1]]] })
      },
      {
        offset: { line: 0, column: 500 },
        map: flatMap({ sources: ['chunk1.js'], names: ['init'], lines: [[[0, 0, 9, 3, 0]]] })
      }
    ]
  };
  const { status, body } = await post({
    sourceMap: indexed,
    frames: [
      { id: 'a', line: 1, column: 10 },
      { id: 'b', line: 1, column: 500 },
      { id: 'c', line: 2, column: 0 }
    ]
  });
  assert.equal(status, 200);
  assert.equal(body.results[0].result.source, 'chunk0.js');
  assert.equal(body.results[0].section, 0);
  assert.equal(body.results[1].result.source, 'chunk1.js');
  assert.equal(body.results[1].result.name, 'init');
  assert.equal(body.results[1].section, 1);
  assert.equal(body.results[2].status, 'unmapped');
});

test('malformed JSON is rejected with REQUEST_INVALID', async () => {
  const { status, body } = await post('{not json');
  assert.equal(status, 400);
  assert.equal(body.error.code, 'REQUEST_INVALID');
});

test('wrong source map version gives a stable code', async () => {
  const { status, body } = await post({
    sourceMap: { version: 2, mappings: '' },
    frames: [{ id: 1, line: 1, column: 0 }]
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'SOURCEMAP_VERSION_UNSUPPORTED');
  assert.equal(body.error.context.version, 2);
});

test('illegal VLQ rejects the whole request with frame/section context', async () => {
  const { status, body } = await post({
    sourceMap: { version: 3, sources: ['a.js'], mappings: 'AAAA,=' },
    frames: [{ id: 1, line: 1, column: 0 }]
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'VLQ_INVALID');
  assert.equal(body.error.context.generatedLine, 0);
  assert.equal(body.error.context.segmentIndex, 1);
  assert.equal(body.error.context.character, '=');
});

test('out of bounds source index is rejected', async () => {
  const map = flatMap({ sources: ['a.js'], lines: [[[0, 1, 0, 0]]] });
  const { status, body } = await post({ sourceMap: map, frames: [{ id: 1, line: 1, column: 0 }] });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'INDEX_OUT_OF_BOUNDS');
  assert.equal(body.error.context.indexKind, 'source');
});

test('external url sections are rejected with EXTERNAL_SECTION_UNSUPPORTED', async () => {
  const { status, body } = await post({
    sourceMap: {
      version: 3,
      sections: [{ offset: { line: 0, column: 0 }, url: 'https://cdn.example.com/a.map' }]
    },
    frames: [{ id: 1, line: 1, column: 0 }]
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'EXTERNAL_SECTION_UNSUPPORTED');
  assert.equal(body.error.context.section, 0);
});

test('overlapping sections are rejected with the offending section index', async () => {
  const { status, body } = await post({
    sourceMap: {
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: flatMap({ sources: ['a.js'], lines: [[[50, 0, 0, 0]]] }) },
        { offset: { line: 0, column: 40 }, map: flatMap({ sources: ['b.js'], lines: [[[0, 0, 0, 0]]] }) }
      ]
    },
    frames: [{ id: 1, line: 1, column: 0 }]
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'SECTIONS_NOT_ORDERED');
  assert.equal(body.error.context.section, 1);
});

test('frame count outside 1..500 is rejected', async () => {
  const tooFew = await post({ sourceMap: sampleFlat, frames: [] });
  assert.equal(tooFew.status, 400);
  assert.equal(tooFew.body.error.code, 'FRAMES_INVALID');

  const tooMany = await post({
    sourceMap: sampleFlat,
    frames: Array.from({ length: 501 }, (_, i) => ({ id: i, line: 1, column: 0 }))
  });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error.code, 'FRAMES_INVALID');
  assert.equal(tooMany.body.error.context.frameCount, 501);
});

test('duplicate frame ids are rejected with frame index context', async () => {
  const { status, body } = await post({
    sourceMap: sampleFlat,
    frames: [
      { id: 'x', line: 1, column: 0 },
      { id: 'x', line: 1, column: 1 }
    ]
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'FRAME_DUPLICATE_ID');
  assert.equal(body.error.context.frameIndex, 1);
});

test('line must be >= 1 and column >= 0', async () => {
  const badLine = await post({
    sourceMap: sampleFlat,
    frames: [{ id: 1, line: 0, column: 0 }]
  });
  assert.equal(badLine.body.error.code, 'FRAME_INVALID');
  assert.equal(badLine.body.error.context.field, 'line');

  const badCol = await post({
    sourceMap: sampleFlat,
    frames: [{ id: 1, line: 1, column: -1 }]
  });
  assert.equal(badCol.body.error.code, 'FRAME_INVALID');
  assert.equal(badCol.body.error.context.field, 'column');
});

test('bodies above 2 MiB are rejected with 413', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024 + 16);
  const { status, body } = await post(big);
  assert.equal(status, 413);
  assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(body.error.context.limitBytes, 2 * 1024 * 1024);
});

test('wrong method and unknown route give stable codes', async () => {
  const get = await call('/api/sourcemaps/resolve');
  assert.equal(get.status, 405);
  assert.equal(get.body.error.code, 'METHOD_NOT_ALLOWED');

  const missing = await call('/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});
