'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveRequest } = require('../src/sourcemap');
const { ApiError } = require('../src/errors');
const { buildMappings, plainMap } = require('./helpers');

function resolveOne(sourceMap, line, column) {
  const { results } = resolveRequest({ sourceMap, frames: [{ id: 'f', line, column }] });
  assert.equal(results.length, 1);
  return results[0];
}

function expectError(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${error}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected ${code} to be thrown`);
}

// ---------------------------------------------------------------------------
// Plain mappings
// ---------------------------------------------------------------------------

const PLAIN = {
  version: 3,
  sources: ['src/a.ts', 'src/b.ts'],
  names: ['alpha', 'beta'],
  mappings: buildMappings([
    // generated line 0
    [
      [0, 0, 0, 0, 0], // a.ts:0:0 name alpha
      [10, 1, 5, 3], //   b.ts:5:3
    ],
    // generated line 1: empty
    [],
    // generated line 2: unmapped segment only
    [[5]],
    // generated line 3
    [
      [2, 0, 10, 2], //  a.ts:10:2
      [8, 0, 10, 9, 1], // a.ts:10:9 name beta
    ],
  ]),
};

test('maps exact generated positions to original locations', () => {
  const hit = resolveOne(PLAIN, 1, 0);
  assert.deepEqual(hit, {
    id: 'f',
    status: 'mapped',
    mapped: true,
    source: 'src/a.ts',
    line: 1, // original lines are returned 1-based
    column: 0,
    name: 'alpha',
  });
});

test('selects the rightmost segment with column <= target on the same line', () => {
  assert.equal(resolveOne(PLAIN, 1, 9).source, 'src/a.ts');
  const atBoundary = resolveOne(PLAIN, 1, 10);
  assert.equal(atBoundary.source, 'src/b.ts');
  assert.equal(atBoundary.line, 6);
  assert.equal(atBoundary.column, 3);
  assert.equal(atBoundary.name, null);
  assert.equal(resolveOne(PLAIN, 1, 9999).source, 'src/b.ts');

  assert.equal(resolveOne(PLAIN, 4, 5).column, 2);
  const withName = resolveOne(PLAIN, 4, 8);
  assert.equal(withName.column, 9);
  assert.equal(withName.name, 'beta');
});

test('marks frames unmapped when there is no candidate', () => {
  for (const [line, column] of [
    [2, 0], // empty generated line
    [3, 4], // before the only (unmapped) segment on the line
    [3, 5], // unmapped segment selected
    [99, 0], // beyond the last generated line
  ]) {
    const result = resolveOne(PLAIN, line, column);
    assert.equal(result.mapped, false, `line ${line} column ${column}`);
    assert.equal(result.status, 'unmapped');
    assert.equal(result.source, null);
    assert.equal(result.line, null);
    assert.equal(result.column, null);
    assert.equal(result.name, null);
  }
});

test('handles an entirely empty mappings string', () => {
  const map = { version: 3, sources: [], names: [], mappings: '' };
  assert.equal(resolveOne(map, 1, 0).mapped, false);
});

test('preserves frame order and ids in results', () => {
  const { results } = resolveRequest({
    sourceMap: PLAIN,
    frames: [
      { id: 'third', line: 4, column: 8 },
      { id: 'first', line: 1, column: 0 },
      { id: 'gap', line: 2, column: 0 },
    ],
  });
  assert.deepEqual(
    results.map((r) => [r.id, r.status]),
    [
      ['third', 'mapped'],
      ['first', 'mapped'],
      ['gap', 'unmapped'],
    ],
  );
});

test('is deterministic across repeated calls', () => {
  const request = {
    sourceMap: PLAIN,
    frames: [
      { id: 1, line: 1, column: 0 },
      { id: 2, line: 1, column: 10 },
      { id: 3, line: 4, column: 8 },
      { id: 4, line: 2, column: 0 },
    ],
  };
  assert.deepEqual(resolveRequest(request), resolveRequest(request));
});

// ---------------------------------------------------------------------------
// Malformed plain maps
// ---------------------------------------------------------------------------

test('rejects invalid Base64 VLQ with context', () => {
  const map = { version: 3, sources: ['a.js'], names: [], mappings: 'AAAA,A!AA' };
  const error = expectError(
    () => resolveRequest({ sourceMap: map, frames: [{ id: 'f', line: 1, column: 0 }] }),
    'INVALID_VLQ',
  );
  assert.equal(error.context.generatedLine, 0);
  assert.equal(error.context.segmentIndex, 1);
});

test('rejects truncated VLQ at end of mappings', () => {
  const map = { version: 3, sources: ['a.js'], names: [], mappings: 'AAAg' };
  expectError(
    () => resolveRequest({ sourceMap: map, frames: [{ id: 'f', line: 1, column: 0 }] }),
    'INVALID_VLQ',
  );
});

test('rejects segments with 2 or 3 fields', () => {
  for (const mappings of ['AC', 'AAC']) {
    expectError(
      () =>
        resolveRequest({
          sourceMap: { version: 3, sources: ['a.js'], names: [], mappings },
          frames: [{ id: 'f', line: 1, column: 0 }],
        }),
      'MALFORMED_SEGMENT',
    );
  }
});

test('rejects regressing generated columns within a line', () => {
  const map = plainMap({
    sources: ['a.js'],
    lines: [
      [
        [5, 0, 0, 0],
        [3, 0, 0, 0], // goes backwards
      ],
    ],
  });
  const error = expectError(
    () => resolveRequest({ sourceMap: map, frames: [{ id: 'f', line: 1, column: 0 }] }),
    'GENERATED_COLUMN_REGRESSION',
  );
  assert.equal(error.context.generatedLine, 0);
});

test('rejects negative generated column on the first segment of a line', () => {
  const map = { version: 3, sources: ['a.js'], names: [], mappings: 'FAAA' }; // genCol -2
  expectError(
    () => resolveRequest({ sourceMap: map, frames: [{ id: 'f', line: 1, column: 0 }] }),
    'GENERATED_COLUMN_REGRESSION',
  );
});

test('rejects out-of-bounds source and name indices', () => {
  const badSource = plainMap({ sources: ['a.js'], lines: [[[0, 5, 0, 0]]] });
  const error1 = expectError(
    () => resolveRequest({ sourceMap: badSource, frames: [{ id: 'f', line: 1, column: 0 }] }),
    'INDEX_OUT_OF_BOUNDS',
  );
  assert.equal(error1.context.sourceIndex, 5);

  const badName = plainMap({ sources: ['a.js'], names: [], lines: [[[0, 0, 0, 0, 2]]] });
  const error2 = expectError(
    () => resolveRequest({ sourceMap: badName, frames: [{ id: 'f', line: 1, column: 0 }] }),
    'INDEX_OUT_OF_BOUNDS',
  );
  assert.equal(error2.context.nameIndex, 2);

  const negativeSource = plainMap({ sources: ['a.js'], lines: [[[0, -1, 0, 0]]] });
  expectError(
    () => resolveRequest({ sourceMap: negativeSource, frames: [{ id: 'f', line: 1, column: 0 }] }),
    'INDEX_OUT_OF_BOUNDS',
  );
});

test('rejects structurally invalid maps', () => {
  const cases = [
    { sources: [], mappings: '' }, // missing version
    { version: 2, sources: [], mappings: '' }, // wrong version
    { version: 3, sources: [] }, // missing mappings
    { version: 3, sources: 'a.js', mappings: '' }, // sources not an array
    { version: 3, sources: [], names: 'x', mappings: '' }, // names not an array
  ];
  for (const map of cases) {
    expectError(
      () => resolveRequest({ sourceMap: map, frames: [{ id: 'f', line: 1, column: 0 }] }),
      'INVALID_SOURCE_MAP',
    );
  }
});

// ---------------------------------------------------------------------------
// Index maps (sections)
// ---------------------------------------------------------------------------

const SECTIONED = {
  version: 3,
  sections: [
    {
      offset: { line: 0, column: 0 },
      map: plainMap({ sources: ['chunk0/a.ts'], lines: [[[0, 0, 0, 0]]] }),
    },
    {
      offset: { line: 10, column: 5 },
      map: {
        version: 3,
        sources: ['chunk1/b.ts'],
        names: ['work'],
        mappings: buildMappings([
          [[0, 0, 3, 1, 0]], // b.ts:3:1 name work
          [[4, 0, 1, 2]], //    b.ts:1:2
        ]),
      },
    },
  ],
};

test('translates coordinates through section offsets', () => {
  const first = resolveOne(SECTIONED, 1, 0);
  assert.deepEqual([first.source, first.line, first.column], ['chunk0/a.ts', 1, 0]);

  // Section 2 starts at generated line 11 (1-based), column 5.
  const second = resolveOne(SECTIONED, 11, 5);
  assert.deepEqual(
    [second.source, second.line, second.column, second.name],
    ['chunk1/b.ts', 4, 1, 'work'],
  );

  // Same line, further right: still the first segment of the section line.
  assert.equal(resolveOne(SECTIONED, 11, 40).source, 'chunk1/b.ts');

  // Second line of section 2: column is NOT offset-adjusted.
  const third = resolveOne(SECTIONED, 12, 4);
  assert.deepEqual([third.source, third.line, third.column], ['chunk1/b.ts', 2, 2]);
});

test('positions outside every section range are unmapped', () => {
  for (const [line, column] of [
    [5, 0], // gap between sections
    [11, 4], // before the section's column offset on its first line
    [12, 3], // before the first segment of the section's second line
    [50, 0], // beyond everything
  ]) {
    assert.equal(resolveOne(SECTIONED, line, column).status, 'unmapped', `${line}:${column}`);
  }
});

test('rejects sections with external url', () => {
  const map = {
    version: 3,
    sections: [{ offset: { line: 0, column: 0 }, url: 'https://cdn.example.com/app.js.map' }],
  };
  const error = expectError(
    () => resolveRequest({ sourceMap: map, frames: [{ id: 'f', line: 1, column: 0 }] }),
    'UNSUPPORTED_SECTION_URL',
  );
  assert.deepEqual(error.context.sectionPath, [0]);
});

test('rejects more than 32 sections', () => {
  const sections = [];
  for (let i = 0; i < 33; i += 1) {
    sections.push({
      offset: { line: i, column: 0 },
      map: { version: 3, sources: [], names: [], mappings: '' },
    });
  }
  const error = expectError(
    () => resolveRequest({ sourceMap: { version: 3, sections }, frames: [{ id: 'f', line: 1, column: 0 }] }),
    'TOO_MANY_SECTIONS',
  );
  assert.equal(error.context.sectionCount, 33);
});

test('accepts exactly 32 sections', () => {
  const sections = [];
  for (let i = 0; i < 32; i += 1) {
    sections.push({
      offset: { line: i, column: 0 },
      map: plainMap({ sources: [`s${i}.js`], lines: [[[0, 0, 0, 0]]] }),
    });
  }
  const hit = resolveOne({ version: 3, sections }, 32, 0);
  assert.equal(hit.source, 's31.js');
});

test('rejects overlapping sections by line range', () => {
  const map = {
    version: 3,
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: plainMap({ sources: ['a.js'], lines: [[[0, 0, 0, 0]], [], [], [], []] }), // covers lines 0-4
      },
      {
        offset: { line: 3, column: 0 }, // starts inside the first section
        map: plainMap({ sources: ['b.js'], lines: [[[0, 0, 0, 0]]] }),
      },
    ],
  };
  const error = expectError(
    () => resolveRequest({ sourceMap: map, frames: [{ id: 'f', line: 1, column: 0 }] }),
    'SECTION_OVERLAP',
  );
  assert.deepEqual(error.context.sectionPath, [1]);
});

test('rejects equal or backwards section offsets', () => {
  const section = (line, column) => ({
    offset: { line, column },
    map: { version: 3, sources: [], names: [], mappings: '' },
  });
  for (const sections of [
    [section(0, 0), section(0, 0)], // equal
    [section(4, 0), section(2, 0)], // backwards
    [section(2, 8), section(2, 4)], // same line, backwards column
  ]) {
    expectError(
      () => resolveRequest({ sourceMap: { version: 3, sections }, frames: [{ id: 'f', line: 1, column: 0 }] }),
      'SECTION_OVERLAP',
    );
  }
});

test('supports nested index maps inside sections', () => {
  const map = {
    version: 3,
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: {
          version: 3,
          sections: [
            {
              offset: { line: 2, column: 0 },
              map: plainMap({ sources: ['deep.js'], lines: [[[0, 0, 7, 7]]] }),
            },
          ],
        },
      },
    ],
  };
  const hit = resolveOne(map, 3, 0);
  assert.deepEqual([hit.source, hit.line, hit.column], ['deep.js', 8, 7]);
});

test('errors inside unused sections still reject the whole request', () => {
  const map = {
    version: 3,
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: plainMap({ sources: ['ok.js'], lines: [[[0, 0, 0, 0]]] }),
      },
      {
        offset: { line: 5, column: 0 },
        map: { version: 3, sources: ['bad.js'], names: [], mappings: 'A!AA' },
      },
    ],
  };
  // Frame only hits the first (valid) section, but the request must fail.
  expectError(
    () => resolveRequest({ sourceMap: map, frames: [{ id: 'f', line: 1, column: 0 }] }),
    'INVALID_VLQ',
  );
});

// ---------------------------------------------------------------------------
// Frame validation
// ---------------------------------------------------------------------------

test('validates frame count bounds', () => {
  expectError(() => resolveRequest({ sourceMap: PLAIN, frames: [] }), 'INVALID_REQUEST');
  const tooMany = Array.from({ length: 501 }, (_, i) => ({ id: i, line: 1, column: 0 }));
  expectError(() => resolveRequest({ sourceMap: PLAIN, frames: tooMany }), 'INVALID_REQUEST');
});

test('validates frame shape and coordinates', () => {
  const badFrames = [
    [{ line: 1, column: 0 }], // missing id
    [{ id: 'a', line: 0, column: 0 }], // line is 1-based
    [{ id: 'a', line: 1.5, column: 0 }],
    [{ id: 'a', line: 1, column: -1 }], // column is 0-based
    [{ id: 'a', line: 1, column: 0.5 }],
    ['not-an-object'],
  ];
  for (const frames of badFrames) {
    expectError(() => resolveRequest({ sourceMap: PLAIN, frames }), 'INVALID_REQUEST');
  }
});

test('rejects duplicate frame ids with locatable context', () => {
  const error = expectError(
    () =>
      resolveRequest({
        sourceMap: PLAIN,
        frames: [
          { id: 'dup', line: 1, column: 0 },
          { id: 'other', line: 1, column: 0 },
          { id: 'dup', line: 2, column: 0 },
        ],
      }),
    'DUPLICATE_FRAME_ID',
  );
  assert.equal(error.context.frameIndex, 2);
  assert.equal(error.context.id, 'dup');
});

test('rejects invalid request envelopes', () => {
  for (const body of [null, [], 'x', 42, { frames: [] }, { sourceMap: {}, frames: 'no' }]) {
    expectError(() => resolveRequest(body), 'INVALID_REQUEST');
  }
});

test('rejects source maps larger than 2 MiB', () => {
  const map = {
    version: 3,
    sources: ['a.js'],
    names: [],
    mappings: 'AAAA',
    padding: 'x'.repeat(2 * 1024 * 1024),
  };
  const error = expectError(
    () => resolveRequest({ sourceMap: map, frames: [{ id: 'f', line: 1, column: 0 }] }),
    'SOURCE_MAP_TOO_LARGE',
  );
  assert.equal(error.status, 413);
});
