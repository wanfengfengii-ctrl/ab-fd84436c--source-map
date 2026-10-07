'use strict';

const { encodeVlqField } = require('../src/vlq');

/**
 * Build a `mappings` string from absolute coordinates so tests stay readable.
 *
 * lines: array of generated lines; each line is an array of segments:
 *   [generatedColumn]                                  -> unmapped segment
 *   [generatedColumn, sourceIndex, origLine, origCol]  -> mapped segment
 *   [generatedColumn, sourceIndex, origLine, origCol, nameIndex]
 *
 * generatedColumn is absolute within its line; source/original/name values
 * are absolute across the whole map (the builder computes the relative
 * deltas the format requires).
 */
function buildMappings(lines) {
  let source = 0;
  let origLine = 0;
  let origCol = 0;
  let name = 0;

  return lines
    .map((segments) => {
      let previousColumn = 0;
      return segments
        .map((segment) => {
          const fields = [segment[0] - previousColumn];
          previousColumn = segment[0];
          if (segment.length > 1) {
            fields.push(segment[1] - source, segment[2] - origLine, segment[3] - origCol);
            source = segment[1];
            origLine = segment[2];
            origCol = segment[3];
            if (segment.length > 4) {
              fields.push(segment[4] - name);
              name = segment[4];
            }
          }
          return fields.map(encodeVlqField).join('');
        })
        .join(',');
    })
    .join(';');
}

/** Shorthand for a plain v3 map object. */
function plainMap({ sources = [], names = [], lines = [] }) {
  return { version: 3, sources, names, mappings: buildMappings(lines) };
}

module.exports = { buildMappings, plainMap };
