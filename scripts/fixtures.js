'use strict';

/**
 * Deterministic fixtures shared by the smoke tests. Built programmatically so
 * the expected original positions are exact.
 */
const { buildMappings } = require('../test/helpers');

function plainMapFixture() {
  return {
    version: 3,
    file: 'app.min.js',
    sources: ['webpack:///src/index.ts', 'webpack:///src/util.ts'],
    names: ['renderApp', 'formatBytes'],
    mappings: buildMappings([
      // generated line 0 (frame line 1)
      [
        [0, 0, 0, 0, 0], // index.ts:0:0 as renderApp
        [15, 1, 2, 4, 1], // util.ts:2:4 as formatBytes
      ],
      // generated line 1: nothing mapped
      [],
      // generated line 2 (frame line 3)
      [
        [3, 0, 10, 8], // index.ts:10:8
        [20, 1, 7, 0], //  util.ts:7:0
      ],
    ]),
  };
}

function sectionedMapFixture() {
  return {
    version: 3,
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: {
          version: 3,
          sources: ['webpack:///chunk-vendors.js'],
          names: [],
          mappings: buildMappings([
            [[0, 0, 100, 0]], // vendors:100:0
            [[8, 0, 100, 30]], // vendors:100:30
          ]),
        },
      },
      {
        offset: { line: 2, column: 6 },
        map: {
          version: 3,
          sources: ['webpack:///chunk-app.js'],
          names: ['bootstrap'],
          mappings: buildMappings([
            [[0, 0, 0, 0, 0]], // app:0:0 as bootstrap
            [[12, 0, 5, 2]], //   app:5:2
          ]),
        },
      },
    ],
  };
}

module.exports = { plainMapFixture, sectionedMapFixture };
