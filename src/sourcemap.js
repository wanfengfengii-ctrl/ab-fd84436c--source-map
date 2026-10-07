'use strict';

const { ApiError, badRequest, unprocessable } = require('./errors');
const { decodeVlqField } = require('./vlq');

const MAX_SOURCE_MAP_BYTES = 2 * 1024 * 1024; // 2 MiB
const MAX_FRAMES = 500;
const MAX_SECTIONS = 32;
const MAX_SECTION_DEPTH = 8;

// ---------------------------------------------------------------------------
// Source Map v3 parsing
// ---------------------------------------------------------------------------

function invalidMap(message, context) {
  return unprocessable('INVALID_SOURCE_MAP', message, context);
}

function parseSegmentFields(segment, context) {
  const fields = [];
  let pos = 0;
  while (pos < segment.length) {
    const decoded = decodeVlqField(segment, pos, context);
    fields.push(decoded.value);
    pos = decoded.nextPos;
  }
  return fields;
}

/**
 * Parse a `mappings` string into an array of generated lines, each a list of
 * segments sorted by generated column. Source/name indices and original
 * positions are cumulative across the whole mappings string; the generated
 * column resets on every line.
 */
function parseMappings(mappings, sources, names, baseContext) {
  const lines = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;

  const rawLines = mappings.split(';');
  for (let line = 0; line < rawLines.length; line += 1) {
    const rawLine = rawLines[line];
    const segments = [];
    let generatedColumn = 0;
    let previousColumn = -1;

    if (rawLine !== '') {
      const rawSegments = rawLine.split(',');
      for (let segmentIndex = 0; segmentIndex < rawSegments.length; segmentIndex += 1) {
        const context = { ...baseContext, generatedLine: line, segmentIndex };
        const fields = parseSegmentFields(rawSegments[segmentIndex], context);

        if (fields.length !== 1 && fields.length !== 4 && fields.length !== 5) {
          throw unprocessable(
            'MALFORMED_SEGMENT',
            `mapping segment must have 1, 4 or 5 VLQ fields, got ${fields.length}`,
            context,
          );
        }

        generatedColumn += fields[0];
        if (generatedColumn < 0 || generatedColumn < previousColumn) {
          throw unprocessable(
            'GENERATED_COLUMN_REGRESSION',
            `generated column regressed to ${generatedColumn} on generated line ${line}`,
            { ...context, generatedColumn },
          );
        }
        previousColumn = generatedColumn;

        if (fields.length === 1) {
          // Unmapped segment: occupies a generated position only.
          segments.push({ generatedColumn });
          continue;
        }

        sourceIndex += fields[1];
        originalLine += fields[2];
        originalColumn += fields[3];

        if (sourceIndex < 0 || sourceIndex >= sources.length) {
          throw unprocessable(
            'INDEX_OUT_OF_BOUNDS',
            `source index ${sourceIndex} out of bounds (sources: ${sources.length})`,
            { ...context, sourceIndex },
          );
        }
        if (originalLine < 0) {
          throw unprocessable(
            'INDEX_OUT_OF_BOUNDS',
            `original line regressed below zero (${originalLine})`,
            { ...context, originalLine },
          );
        }
        if (originalColumn < 0) {
          throw unprocessable(
            'INDEX_OUT_OF_BOUNDS',
            `original column regressed below zero (${originalColumn})`,
            { ...context, originalColumn },
          );
        }

        let name;
        if (fields.length === 5) {
          nameIndex += fields[4];
          if (nameIndex < 0 || nameIndex >= names.length) {
            throw unprocessable(
              'INDEX_OUT_OF_BOUNDS',
              `name index ${nameIndex} out of bounds (names: ${names.length})`,
              { ...context, nameIndex },
            );
          }
          name = names[nameIndex];
        }

        segments.push({
          generatedColumn,
          source: sources[sourceIndex],
          originalLine,
          originalColumn,
          name,
        });
      }
    }

    lines.push(segments);
  }
  return lines;
}

function parsePlainMap(map, context) {
  if (typeof map.mappings !== 'string') {
    throw invalidMap('plain source map requires a string "mappings" field', context);
  }
  const sources = map.sources === undefined ? [] : map.sources;
  if (!Array.isArray(sources) || sources.some((s) => typeof s !== 'string')) {
    throw invalidMap('"sources" must be an array of strings', context);
  }
  const names = map.names === undefined ? [] : map.names;
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
    throw invalidMap('"names" must be an array of strings', context);
  }
  const lines = parseMappings(map.mappings, sources, names, context);
  return { kind: 'plain', lines, coveredLines: lines.length };
}

function parseIndexMap(map, context, depth) {
  if (depth > MAX_SECTION_DEPTH) {
    throw invalidMap(`sections nested deeper than ${MAX_SECTION_DEPTH} levels`, context);
  }
  const sections = map.sections;
  if (sections.length > MAX_SECTIONS) {
    throw unprocessable(
      'TOO_MANY_SECTIONS',
      `index map has ${sections.length} sections (max ${MAX_SECTIONS})`,
      { ...context, sectionCount: sections.length },
    );
  }

  const parsed = [];
  let coveredLines = 0;
  let previousOffset = null;
  let previousEndLine = -1;

  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    const sectionContext = { ...context, sectionPath: [...(context.sectionPath || []), i] };

    if (section === null || typeof section !== 'object' || Array.isArray(section)) {
      throw invalidMap('section must be an object', sectionContext);
    }
    const { offset } = section;
    if (offset === null || typeof offset !== 'object' || Array.isArray(offset)) {
      throw invalidMap('section requires an "offset" object with line and column', sectionContext);
    }
    if (!Number.isInteger(offset.line) || offset.line < 0) {
      throw invalidMap('section offset.line must be a non-negative integer', sectionContext);
    }
    if (!Number.isInteger(offset.column) || offset.column < 0) {
      throw invalidMap('section offset.column must be a non-negative integer', sectionContext);
    }
    if (section.url !== undefined && section.url !== null) {
      throw unprocessable(
        'UNSUPPORTED_SECTION_URL',
        'sections referencing external maps via "url" are not supported; embed the map with "map" instead',
        sectionContext,
      );
    }
    if (section.map === undefined || section.map === null) {
      throw invalidMap('section requires an embedded "map" object', sectionContext);
    }

    const child = parseMap(section.map, sectionContext, depth + 1);

    if (previousOffset !== null) {
      const notStrictlyAfter =
        offset.line < previousOffset.line ||
        (offset.line === previousOffset.line && offset.column <= previousOffset.column);
      if (notStrictlyAfter) {
        throw unprocessable(
          'SECTION_OVERLAP',
          `section offset (${offset.line},${offset.column}) does not strictly follow the previous section offset (${previousOffset.line},${previousOffset.column})`,
          sectionContext,
        );
      }
    }
    if (offset.line <= previousEndLine) {
      throw unprocessable(
        'SECTION_OVERLAP',
        `section starts at generated line ${offset.line} but the previous section covers generated lines up to ${previousEndLine}`,
        sectionContext,
      );
    }

    parsed.push({ offset: { line: offset.line, column: offset.column }, map: child });
    previousOffset = offset;
    previousEndLine = offset.line + Math.max(child.coveredLines, 1) - 1;
    coveredLines = Math.max(coveredLines, previousEndLine + 1);
  }

  return { kind: 'index', sections: parsed, coveredLines };
}

function parseMap(map, context, depth = 1) {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    throw invalidMap('source map must be a JSON object', context);
  }
  if (map.version !== 3) {
    throw invalidMap(
      `unsupported source map version ${JSON.stringify(map.version)} (expected 3)`,
      context,
    );
  }
  // An index map takes precedence when both shapes are present.
  if (Array.isArray(map.sections)) {
    return parseIndexMap(map, context, depth);
  }
  return parsePlainMap(map, context);
}

// ---------------------------------------------------------------------------
// Position resolution
// ---------------------------------------------------------------------------

/** Rightmost segment whose generated column is <= `column`, or null. */
function findSegment(segments, column) {
  let lo = 0;
  let hi = segments.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].generatedColumn <= column) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best === -1 ? null : segments[best];
}

/** Last section whose offset is <= (line, column), or null. */
function findSection(sections, line, column) {
  let lo = 0;
  let hi = sections.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const { offset } = sections[mid];
    if (offset.line < line || (offset.line === line && offset.column <= column)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best === -1 ? null : sections[best];
}

/**
 * Resolve a 0-based generated (line, column) against a parsed map tree.
 * Returns { source, line (1-based), column (0-based), name|undefined } or null.
 */
function resolvePosition(node, line, column) {
  if (node.kind === 'plain') {
    if (line < 0 || line >= node.lines.length) {
      return null;
    }
    const segment = findSegment(node.lines[line], column);
    if (segment === null || segment.source === undefined) {
      return null;
    }
    return {
      source: segment.source,
      line: segment.originalLine + 1,
      column: segment.originalColumn,
      name: segment.name,
    };
  }

  const section = findSection(node.sections, line, column);
  if (section === null) {
    return null;
  }
  const relativeLine = line - section.offset.line;
  const relativeColumn = relativeLine === 0 ? column - section.offset.column : column;
  return resolvePosition(section.map, relativeLine, relativeColumn);
}

// ---------------------------------------------------------------------------
// Request validation + orchestration
// ---------------------------------------------------------------------------

function validateFrames(frames) {
  if (!Array.isArray(frames)) {
    throw badRequest('INVALID_REQUEST', 'request requires a "frames" array', { field: 'frames' });
  }
  if (frames.length < 1 || frames.length > MAX_FRAMES) {
    throw badRequest(
      'INVALID_REQUEST',
      `"frames" must contain between 1 and ${MAX_FRAMES} entries (got ${frames.length})`,
      { field: 'frames', count: frames.length },
    );
  }

  const seen = new Set();
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const context = {
      frameIndex: index,
      id: frame !== null && typeof frame === 'object' ? frame.id : undefined,
    };
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
      throw badRequest('INVALID_REQUEST', `frame at index ${index} must be an object`, context);
    }
    const { id, line, column } = frame;
    if (typeof id !== 'string' && typeof id !== 'number') {
      throw badRequest('INVALID_REQUEST', `frame at index ${index} requires a string or number "id"`, context);
    }
    const key = `${typeof id}:${id}`;
    if (seen.has(key)) {
      throw new ApiError(400, 'DUPLICATE_FRAME_ID', `duplicate frame id ${JSON.stringify(id)}`, context);
    }
    seen.add(key);
    if (!Number.isInteger(line) || line < 1) {
      throw badRequest(
        'INVALID_REQUEST',
        `frame ${JSON.stringify(id)} has invalid line ${JSON.stringify(line)} (must be an integer >= 1)`,
        context,
      );
    }
    if (!Number.isInteger(column) || column < 0) {
      throw badRequest(
        'INVALID_REQUEST',
        `frame ${JSON.stringify(id)} has invalid column ${JSON.stringify(column)} (must be an integer >= 0)`,
        context,
      );
    }
  }
}

/**
 * Validate the request body, parse the whole source map (all sections), then
 * resolve every frame. Any failure rejects the entire request — callers never
 * receive partial results. Frame order is preserved in the returned results.
 */
function resolveRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('INVALID_REQUEST', 'request body must be a JSON object', {});
  }

  const { sourceMap, frames } = body;
  if (sourceMap === null || typeof sourceMap !== 'object' || Array.isArray(sourceMap)) {
    throw badRequest('INVALID_REQUEST', 'request requires a "sourceMap" object', {
      field: 'sourceMap',
    });
  }
  const mapBytes = Buffer.byteLength(JSON.stringify(sourceMap), 'utf8');
  if (mapBytes > MAX_SOURCE_MAP_BYTES) {
    throw new ApiError(
      413,
      'SOURCE_MAP_TOO_LARGE',
      `sourceMap serializes to ${mapBytes} bytes (max ${MAX_SOURCE_MAP_BYTES})`,
      { field: 'sourceMap', bytes: mapBytes, maxBytes: MAX_SOURCE_MAP_BYTES },
    );
  }

  validateFrames(frames);

  // Parse fully before resolving anything: a malformed map anywhere
  // (including unused sections) rejects the whole request.
  const root = parseMap(sourceMap, {});

  const results = frames.map((frame) => {
    const hit = resolvePosition(root, frame.line - 1, frame.column);
    if (hit === null) {
      return {
        id: frame.id,
        status: 'unmapped',
        mapped: false,
        source: null,
        line: null,
        column: null,
        name: null,
      };
    }
    return {
      id: frame.id,
      status: 'mapped',
      mapped: true,
      source: hit.source,
      line: hit.line,
      column: hit.column,
      name: hit.name === undefined ? null : hit.name,
    };
  });

  return { results };
}

module.exports = {
  resolveRequest,
  parseMap,
  resolvePosition,
  MAX_SOURCE_MAP_BYTES,
  MAX_FRAMES,
  MAX_SECTIONS,
};
