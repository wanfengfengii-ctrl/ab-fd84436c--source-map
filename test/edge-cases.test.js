import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSourceMap } from '../src/parser.js';
import { resolveFrame } from '../src/resolver.js';
import { flatMap } from './helpers.js';

test('sourceRoot is prepended to relative sources', () => {
  const map = { version: 3, sourceRoot: 'https://cdn.test/src/', sources: ['a.ts'], mappings: 'AAAA' };
  assert.equal(resolveFrame(parseSourceMap(map), 1, 0).result.source, 'https://cdn.test/src/a.ts');

  const noSlash = { version: 3, sourceRoot: 'webpack:///src', sources: ['b.ts'], mappings: 'AAAA' };
  assert.equal(resolveFrame(parseSourceMap(noSlash), 1, 0).result.source, 'webpack:///src/b.ts');
});

test('absolute sources are not prefixed by sourceRoot', () => {
  for (const source of ['http://x/y.js', 'https://x/y.js', '/abs/y.js', '//cdn/y.js']) {
    const map = { version: 3, sourceRoot: 'root/', sources: [source], mappings: 'AAAA' };
    assert.equal(resolveFrame(parseSourceMap(map), 1, 0).result.source, source);
  }
});

test('null source entry resolves to null without crashing', () => {
  const map = { version: 3, sources: [null], mappings: 'AAAA' };
  const r = resolveFrame(parseSourceMap(map), 1, 0);
  assert.equal(r.status, 'mapped');
  assert.equal(r.result.source, null);
});

test('inline zero-field segments between distinct columns resolve normally', () => {
  // AAAA at col0, empty fields, then a 4-field segment at col10 (delta "U").
  const map = { version: 3, sources: ['a.js'], mappings: 'AAAA,,UAAA' };
  const parsed = parseSourceMap(map);
  assert.equal(parsed.lines[0].length, 2);
  assert.deepEqual(parsed.lines[0].map((e) => e.c), [0, 10]);
  assert.equal(resolveFrame(parsed, 1, 10).status, 'mapped');
});

test('multi-group VLQ values are decoded correctly', () => {
  // source index 1000 requires a multi-group VLQ; build raw mappings:
  // col 0 (A), source delta 1000 (w+B), origLine 0, origCol 0 -> Aw+BAA
  const map = {
    version: 3,
    sources: Array.from({ length: 1001 }, (_, i) => `s${i}.js`),
    mappings: 'Aw+BAA'
  };
  const r = resolveFrame(parseSourceMap(map), 1, 0);
  assert.equal(r.status, 'mapped');
  assert.equal(r.result.source, 's1000.js');
});

test('illegal character inside multi-group VLQ is rejected', () => {
  // Continuation digit 'g' followed by illegal '='.
  const map = { version: 3, sources: ['a.js'], mappings: 'Ag=AA' };
  assert.throws(() => parseSourceMap(map), (e) => e.code === 'VLQ_INVALID');
});

test('32 sections are accepted; section index is reported', () => {
  const sections = Array.from({ length: 32 }, (_, i) => ({
    offset: { line: i * 2, column: 0 },
    map: flatMap({ sources: [`c${i}.js`], lines: [[[0, 0, 0, 0]]] })
  }));
  const parsed = parseSourceMap({ version: 3, sections });
  assert.equal(resolveFrame(parsed, 1, 0).section, 0);
  assert.equal(resolveFrame(parsed, 63, 0).section, 31);
});

test('frame on a line beyond all mappings is unmapped', () => {
  const parsed = parseSourceMap(flatMap({ sources: ['a.js'], lines: [[[0, 0, 0, 0]]] }));
  assert.equal(resolveFrame(parsed, 1_000_000, 0).status, 'unmapped');
});
