import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSourceMap } from '../src/parser.js';
import { resolveFrame, resolveAll } from '../src/resolver.js';
import { flatMap } from './helpers.js';

test('flat map: picks rightmost segment with column <= target', () => {
  const map = parseSourceMap(
    flatMap({
      sources: ['app.js'],
      names: ['foo'],
      // Line 0: cols 0 -> src 1:2 name foo ; col 10 -> src 3:4 (no name)
      lines: [[[0, 0, 0, 2, 0], [10, 0, 2, 2]]]
    })
  );

  // Columns 0..9 hit the first segment.
  assert.deepEqual(resolveFrame(map, 1, 0).result, {
    source: 'app.js',
    line: 1,
    column: 2,
    name: 'foo'
  });
  assert.equal(resolveFrame(map, 1, 9).result.line, 1);

  // Column 10+ hits the second segment; name absent.
  const hit = resolveFrame(map, 1, 10);
  assert.equal(hit.result.source, 'app.js');
  assert.equal(hit.result.line, 3);
  assert.equal(hit.result.column, 4);
  assert.equal(hit.result.name, undefined);

  // A column far beyond the last segment still maps to it.
  assert.equal(resolveFrame(map, 1, 9999).result.line, 3);
});

test('flat map: no segment on target line is unmapped', () => {
  const map = parseSourceMap(flatMap({ lines: [[[0, 0, 0, 0]], []] }));
  assert.equal(resolveFrame(map, 2, 0).status, 'unmapped');
  // Empty mappings: everything unmapped.
  const empty = parseSourceMap({ version: 3, mappings: '' });
  assert.equal(resolveFrame(empty, 1, 0).status, 'unmapped');
  assert.equal(resolveFrame(empty, 100, 5).status, 'unmapped');
});

test('flat map: frame before first generated column is unmapped', () => {
  const map = parseSourceMap(flatMap({ sources: ['a.js'], lines: [[[8, 0, 0, 0]]] }));
  assert.equal(resolveFrame(map, 1, 7).status, 'unmapped');
  assert.equal(resolveFrame(map, 1, 8).status, 'mapped');
});

test('flat map: 1-field marker segment means unmapped even with earlier mapping', () => {
  // Col 0 mapped, col 20 explicit unmap marker.
  const map = parseSourceMap(
    flatMap({ sources: ['a.js'], lines: [[[0, 0, 0, 0], [20]]] })
  );
  assert.equal(resolveFrame(map, 1, 19).status, 'mapped');
  assert.equal(resolveFrame(map, 1, 20).status, 'unmapped');
  assert.equal(resolveFrame(map, 1, 50).status, 'unmapped');
});

test('flat map: multiple lines with per-line reset of VLQ state', () => {
  const map = parseSourceMap(
    flatMap({
      sources: ['a.js', 'b.js'],
      lines: [
        [[0, 1, 5, 6]], // generated line 1 -> b.js (source index 1), orig 6:7
        [[0, 0, 0, 0]], // generated line 2 -> a.js source index resets to 0
        [] // empty line 3
      ]
    })
  );
  assert.equal(resolveFrame(map, 1, 0).result.source, 'b.js');
  assert.equal(resolveFrame(map, 2, 0).result.source, 'a.js');
  assert.equal(resolveFrame(map, 3, 0).status, 'unmapped');
  assert.equal(resolveFrame(map, 4, 0).status, 'unmapped');
});

test('resolveAll preserves request order and echoes coordinates', () => {
  const map = parseSourceMap(flatMap({ sources: ['a.js'], lines: [[[0, 0, 0, 0], [10]]] }));
  const frames = [
    { id: 'z', line: 1, column: 10 },
    { id: 'a', line: 1, column: 0 },
    { id: 42, line: 9, column: 3 }
  ];
  const out = resolveAll(map, frames);
  assert.deepEqual(out.map((r) => r.id), ['z', 'a', 42]);
  assert.equal(out[0].status, 'unmapped');
  assert.equal(out[1].status, 'mapped');
  assert.equal(out[2].status, 'unmapped');
  assert.deepEqual(out[0].frame, { line: 1, column: 10 });
});

// ---- Sections --------------------------------------------------------------

function section(offLine, offCol, map) {
  return { offset: { line: offLine, column: offCol }, map };
}

test('sections: offsets translate coordinates to section-local space', () => {
  const indexed = parseSourceMap({
    version: 3,
    sections: [
      section(0, 0, flatMap({ sources: ['chunk0.js'], lines: [[[0, 0, 2, 3]]] })),
      section(0, 100, flatMap({ sources: ['chunk1.js'], lines: [[[0, 0, 4, 5]]] })),
      section(2, 0, flatMap({ sources: ['chunk2.js'], lines: [[[0, 0, 6, 7]]] }))
    ]
  });

  assert.equal(resolveFrame(indexed, 1, 0).result.source, 'chunk0.js');
  assert.equal(resolveFrame(indexed, 1, 0).section, 0);
  assert.equal(resolveFrame(indexed, 1, 99).section, 0);
  assert.equal(resolveFrame(indexed, 1, 100).result.source, 'chunk1.js');
  assert.equal(resolveFrame(indexed, 1, 100).section, 1);
  assert.equal(resolveFrame(indexed, 1, 100).result.line, 5);

  // Global line 3 (zero-based 2) lands in section 2; columns are global.
  const r = resolveFrame(indexed, 3, 0);
  assert.equal(r.section, 2);
  assert.equal(r.result.source, 'chunk2.js');
  assert.equal(r.result.line, 7);

  // Global line 2 (zero-based 1) belongs to section 0's tail (height 1),
  // which has no second line -> unmapped, not chunk2.
  assert.equal(resolveFrame(indexed, 2, 50).status, 'unmapped');
});

test('sections: same-line offset shifts columns only on first line', () => {
  const indexed = parseSourceMap({
    version: 3,
    sections: [
      section(0, 10, flatMap({ sources: ['c.js'], lines: [[[5, 0, 0, 0]], [[7, 0, 1, 1]]] }))
    ]
  });
  // First global line: local col = global col - 10.
  assert.equal(resolveFrame(indexed, 1, 14).status, 'unmapped'); // local 4 < 5
  assert.equal(resolveFrame(indexed, 1, 15).status, 'mapped'); // local 5
  // Second global line: no column shift; local segment at 7.
  assert.equal(resolveFrame(indexed, 2, 6).status, 'unmapped');
  assert.equal(resolveFrame(indexed, 2, 7).status, 'mapped');
});

test('sections: rejects more than 32 sections', () => {
  const sections = Array.from({ length: 33 }, (_, i) =>
    section(i * 10, 0, flatMap({ sources: ['a.js'], lines: [[[0, 0, 0, 0]]] }))
  );
  assert.throws(
    () => parseSourceMap({ version: 3, sections }),
    (e) => e.code === 'SECTIONS_LIMIT_EXCEEDED'
  );
});

test('sections: rejects unordered and duplicate offsets', () => {
  const mk = (l, c) => section(l, c, flatMap({ sources: ['a.js'], lines: [[[0, 0, 0, 0]]] }));
  assert.throws(
    () => parseSourceMap({ version: 3, sections: [mk(0, 5), mk(0, 3)] }),
    (e) => e.code === 'SECTIONS_NOT_ORDERED'
  );
  assert.throws(
    () => parseSourceMap({ version: 3, sections: [mk(0, 5), mk(0, 5)] }),
    (e) => e.code === 'SECTIONS_NOT_ORDERED'
  );
  assert.throws(
    () => parseSourceMap({ version: 3, sections: [mk(2, 0), mk(1, 9)] }),
    (e) => e.code === 'SECTIONS_NOT_ORDERED'
  );
});

test('sections: rejects same-line overlapping ranges', () => {
  // Section 0 occupies global columns [0, 50] on line 0; section 1 at col 40.
  const s0 = section(0, 0, flatMap({ sources: ['a.js'], lines: [[[50, 0, 0, 0]]] }));
  const s1 = section(0, 40, flatMap({ sources: ['b.js'], lines: [[[0, 0, 0, 0]]] }));
  assert.throws(
    () => parseSourceMap({ version: 3, sections: [s0, s1] }),
    (e) => e.code === 'SECTIONS_NOT_ORDERED'
  );
});

test('sections: adjacent non-overlapping ranges are accepted', () => {
  const s0 = section(0, 0, flatMap({ sources: ['a.js'], lines: [[[50, 0, 0, 0]]] }));
  const s1 = section(0, 51, flatMap({ sources: ['b.js'], lines: [[[0, 0, 0, 0]]] }));
  assert.doesNotThrow(() => parseSourceMap({ version: 3, sections: [s0, s1] }));
});

test('sections: rejects external url sections and nested sections', () => {
  assert.throws(
    () => parseSourceMap({ version: 3, sections: [{ offset: { line: 0, column: 0 }, url: 'http://x/map.json' }] }),
    (e) => {
      assert.equal(e.code, 'EXTERNAL_SECTION_UNSUPPORTED');
      assert.equal(e.context.section, 0);
      return true;
    }
  );
  assert.throws(
    () =>
      parseSourceMap({
        version: 3,
        sections: [
          { offset: { line: 0, column: 0 }, map: { version: 3, sections: [] } }
        ]
      }),
    (e) => e.code === 'NESTED_SECTIONS_UNSUPPORTED'
  );
});

test('sections: bad offset structure is rejected with section context', () => {
  const base = flatMap({ sources: ['a.js'], lines: [[[0, 0, 0, 0]]] });
  assert.throws(
    () => parseSourceMap({ version: 3, sections: [{ offset: { line: -1, column: 0 }, map: base }] }),
    (e) => {
      assert.equal(e.code, 'SECTION_INVALID');
      assert.equal(e.context.section, 0);
      return true;
    }
  );
  assert.throws(
    () => parseSourceMap({ version: 3, sections: [{ offset: { line: 0, column: 'x' }, map: base }] }),
    (e) => e.code === 'SECTION_INVALID'
  );
});

test('sections: VLQ errors inside a section carry the section index', () => {
  const bad = { version: 3, sources: ['a.js'], mappings: 'AAAA,=' };
  assert.throws(
    () =>
      parseSourceMap({
        version: 3,
        sections: [
          section(0, 0, flatMap({ sources: ['a.js'], lines: [[[0, 0, 0, 0]]] })),
          section(1, 0, bad)
        ]
      }),
    (e) => {
      assert.equal(e.code, 'VLQ_INVALID');
      assert.equal(e.context.section, 1);
      return true;
    }
  );
});

test('determinism: same inputs resolve identically across calls', () => {
  const map = parseSourceMap(
    flatMap({ sources: ['a.js'], names: ['n'], lines: [[[0, 0, 0, 0, 0], [6, 0, 3, 2]]] })
  );
  const frames = [{ id: 1, line: 1, column: 0 }, { id: 2, line: 1, column: 7 }];
  const a = JSON.stringify(resolveAll(map, frames));
  const b = JSON.stringify(resolveAll(map, frames));
  assert.equal(a, b);
});
