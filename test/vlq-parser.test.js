import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeVlq } from '../src/vlq.js';
import { parseSourceMap } from '../src/parser.js';
import { MapError } from '../src/errors.js';
import { flatMap } from './helpers.js';

test('decodeVlq handles standard spec values', () => {
  const cases = [
    ['A', 0],
    ['C', 1],
    ['D', -1],
    ['E', 2],
    ['F', -2],
    ['c', 14],
    ['gB', 16],
    ['w+B', 1000],
    ['x+B', -1000]
  ];
  for (const [text, expected] of cases) {
    assert.equal(decodeVlq(text, 0, {}).value, expected, text);
  }
});

test('decodeVlq reports next position', () => {
  const r = decodeVlq('AA', 0, {});
  assert.equal(r.value, 0);
  assert.equal(r.next, 1);
});

test('illegal Base64 character is rejected with context', () => {
  try {
    decodeVlq('A=B', 1, { generatedLine: 2, segmentIndex: 3 });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof MapError);
    assert.equal(err.code, 'VLQ_INVALID');
    assert.equal(err.context.generatedLine, 2);
    assert.equal(err.context.segmentIndex, 3);
    assert.equal(err.context.character, '=');
  }
});

test('dangling continuation digit is rejected', () => {
  // 'g' decodes to 32 (continuation bit set, payload 0) with no terminator.
  assert.throws(() => decodeVlq('g', 0, {}), (err) => err.code === 'VLQ_INVALID');
});

test('parser rejects non-object and wrong version', () => {
  assert.throws(() => parseSourceMap(null), (e) => e.code === 'SOURCEMAP_INVALID');
  assert.throws(() => parseSourceMap([]), (e) => e.code === 'SOURCEMAP_INVALID');
  assert.throws(
    () => parseSourceMap({ version: 2, mappings: '' }),
    (e) => e.code === 'SOURCEMAP_VERSION_UNSUPPORTED'
  );
  assert.throws(
    () => parseSourceMap({ version: 3 }),
    (e) => e.code === 'SOURCEMAP_INVALID'
  );
});

test('parser rejects segment with 2 or 3 fields', () => {
  const bad2 = flatMap({ lines: [[[0, 0]]] });
  assert.throws(() => parseSourceMap(bad2), (e) => e.code === 'SEGMENT_INVALID_LENGTH');
  const bad3 = flatMap({ lines: [[[0, 0, 0]]] });
  assert.throws(() => parseSourceMap(bad3), (e) => e.code === 'SEGMENT_INVALID_LENGTH');
});

test('parser rejects out of bounds source index', () => {
  const map = flatMap({ sources: ['a.js'], lines: [[[0, 1, 0, 0]]] });
  assert.throws(() => parseSourceMap(map), (e) => {
    assert.equal(e.code, 'INDEX_OUT_OF_BOUNDS');
    assert.equal(e.context.indexKind, 'source');
    assert.equal(e.context.bound, 1);
    assert.equal(e.context.generatedLine, 0);
    assert.equal(e.context.segmentIndex, 0);
    return true;
  });
});

test('parser rejects negative running source index', () => {
  const map = flatMap({ sources: ['a.js'], lines: [[[0, -1, 0, 0]]] });
  assert.throws(() => parseSourceMap(map), (e) => e.code === 'INDEX_OUT_OF_BOUNDS');
});

test('parser rejects out of bounds name index', () => {
  const map = flatMap({ sources: ['a.js'], names: ['n'], lines: [[[0, 0, 0, 0, 1]]] });
  assert.throws(() => parseSourceMap(map), (e) => {
    assert.equal(e.code, 'INDEX_OUT_OF_BOUNDS');
    assert.equal(e.context.indexKind, 'name');
    return true;
  });
});

test('parser rejects negative original coordinates', () => {
  const line = flatMap({ sources: ['a.js'], lines: [[[0, 0, -1, 0]]] });
  assert.throws(() => parseSourceMap(line), (e) => e.code === 'ORIGINAL_COORDINATE_INVALID');
  const col = flatMap({ sources: ['a.js'], lines: [[[0, 0, 0, -1]]] });
  assert.throws(() => parseSourceMap(col), (e) => e.code === 'ORIGINAL_COORDINATE_INVALID');
});

test('parser rejects regressed generated columns', () => {
  // First segment at col 5, then delta -1 -> col 4.
  const map = flatMap({ sources: ['a.js'], lines: [[[5], [4 - 5 + 0, 0, 0, 0].slice(0, 1)]] });
  assert.throws(() => parseSourceMap(map), (e) => e.code === 'GENERATED_COLUMN_REGRESSED');

  // Negative delta on the first segment.
  const neg = flatMap({ sources: ['a.js'], lines: [[[-1, 0, 0, 0]]] });
  assert.throws(() => parseSourceMap(neg), (e) => e.code === 'GENERATED_COLUMN_REGRESSED');

  // Equal columns (delta 0 second segment) also regresses.
  const eq = flatMap({ sources: ['a.js'], lines: [[[0, 0, 0, 0], [0, 0, 0, 0]]] });
  assert.throws(() => parseSourceMap(eq), (e) => e.code === 'GENERATED_COLUMN_REGRESSED');
});

test('parser accepts valid running indices across segments', () => {
  // Two mapped segments, second reuses running source index via deltas.
  const map = flatMap({
    sources: ['a.js'],
    names: ['x'],
    lines: [[[0, 0, 0, 0, 0], [5, 0, 2, 4]]]
  });
  const parsed = parseSourceMap(map);
  assert.equal(parsed.kind, 'flat');
  assert.equal(parsed.lines[0].length, 2);
});
