import { MapError, ErrorCode } from './errors.js';
import { decodeVlq } from './vlq.js';

export const MAX_SECTIONS = 32;

/**
 * Parse a Source Map v3 JSON value into a normalized consumer.
 *
 * Returns either:
 *   { kind: 'flat', sources, names, lines, height }
 *   { kind: 'indexed', sections: [{ offset: {line, column}, map }] }
 *
 * `lines[generatedLine]` is an array of entries sorted by generated column:
 *   { c, mapped, s?, sl?, sc?, n? }
 *
 * The input is fully validated up front: a malformed map throws a MapError
 * with a stable code and section/line/segment context before any frame is
 * resolved, so requests never produce partial results.
 */
export function parseSourceMap(root) {
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new MapError(
      ErrorCode.SOURCEMAP_INVALID,
      'a Source Map v3 object must be a JSON object'
    );
  }
  if (root.version !== 3) {
    throw new MapError(
      ErrorCode.SOURCEMAP_VERSION_UNSUPPORTED,
      `unsupported source map version ${JSON.stringify(root.version)}; only version 3 is supported`,
      { version: root.version ?? null }
    );
  }

  const hasSections =
    Object.prototype.hasOwnProperty.call(root, 'sections') && root.sections !== undefined;
  const hasMappings =
    Object.prototype.hasOwnProperty.call(root, 'mappings') && root.mappings !== undefined;

  if (hasSections && hasMappings) {
    throw new MapError(
      ErrorCode.SOURCEMAP_INVALID,
      'an indexed source map cannot also contain a top-level "mappings" field',
      { fields: ['sections', 'mappings'] }
    );
  }

  if (hasSections) return parseIndexed(root);

  if (!hasMappings) {
    throw new MapError(
      ErrorCode.SOURCEMAP_INVALID,
      'source map is missing the required "mappings" field'
    );
  }
  return parseFlat(root, null);
}

function asArray(value, field, section) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new MapError(
      ErrorCode.SOURCEMAP_INVALID,
      `"${field}" must be an array`,
      { section, field }
    );
  }
  return value;
}

// Resolve a sources[] entry against the optional sourceRoot following the
// v3/URL resolution rules: an absolute source (scheme, protocol-relative,
// root-relative or data: URL) is returned unchanged; otherwise the root is
// prepended (with an implied trailing slash).
function joinSourceRoot(root, source) {
  if (!root) return source;
  const absolute =
    /^[a-z][a-z0-9+.-]*:/i.test(source) ||
    source.startsWith('/') ||
    source.startsWith('//');
  if (absolute) return source;
  const sep = root.endsWith('/') ? '' : '/';
  return `${root}${sep}${source}`;
}

/**
 * Parse one non-indexed map. `section` is the index of the owning section
 * (null for a top-level map) and is attached to every error context.
 */
export function parseFlat(map, section) {
  const ctx = { section };

  if (typeof map.mappings !== 'string') {
    throw new MapError(
      ErrorCode.SOURCEMAP_INVALID,
      '"mappings" must be a string',
      { ...ctx, field: 'mappings' }
    );
  }

  const sourceRoot =
    map.sourceRoot === undefined || map.sourceRoot === null ? '' : String(map.sourceRoot);
  const sources = (asArray(map.sources, 'sources', section) ?? []).map((source, i) => {
    if (source === null) return null; // anonymous source is legal in v3
    if (typeof source !== 'string') {
      throw new MapError(
        ErrorCode.SOURCEMAP_INVALID,
        `sources[${i}] must be a string or null`,
        { ...ctx, field: 'sources', index: i }
      );
    }
    return joinSourceRoot(sourceRoot, source);
  });
  const names = (asArray(map.names, 'names', section) ?? []).map((name, i) => {
    if (typeof name !== 'string') {
      throw new MapError(
        ErrorCode.SOURCEMAP_INVALID,
        `names[${i}] must be a string`,
        { ...ctx, field: 'names', index: i }
      );
    }
    return name;
  });

  const lines = [];
  const textLines = map.mappings.split(';');

  for (let generatedLine = 0; generatedLine < textLines.length; generatedLine++) {
    const text = textLines[generatedLine];
    // A completely empty line (";;") is the legal "no mappings on this
    // generated line" notation. A comma-adjacent empty field inside a line
    // is malformed and rejected below.
    const segments = text.length === 0 ? [] : text.split(',');
    const entries = [];

    // Per-line running state. The VLQ deltas for source/original/name reset
    // at the start of every generated line; the generated column resets too.
    let generatedColumn = 0;
    let sourceIndex = 0;
    let originalLine = 0;
    let originalColumn = 0;
    let nameIndex = 0;

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      const segment = segments[segmentIndex];
      if (segment === '') {
        // Zero-field segments (doubled/trailing commas) carry no coordinates;
        // skip them like the reference implementation. segmentIndex still
        // points at the comma position, so later error context stays
        // locatable.
        continue;
      }

      const segCtx = { ...ctx, generatedLine, segmentIndex };

      // Decode every VLQ field first. Illegal characters or dangling
      // continuations surface as VLQ_INVALID before any delta is applied.
      const fields = [];
      let pos = 0;
      while (pos < segment.length) {
        const r = decodeVlq(segment, pos, segCtx);
        fields.push(r.value);
        pos = r.next;
      }

      if (fields.length !== 1 && fields.length !== 4 && fields.length !== 5) {
        throw new MapError(
          ErrorCode.SEGMENT_INVALID_LENGTH,
          `mapping segment has ${fields.length} fields; allowed lengths are 1, 4 or 5`,
          { ...segCtx, fieldCount: fields.length, segment }
        );
      }

      generatedColumn += fields[0];
      if (fields[0] < 0) {
        throw new MapError(
          ErrorCode.GENERATED_COLUMN_REGRESSED,
          'generated column delta is negative',
          { ...segCtx, generatedColumn, columnDelta: fields[0] }
        );
      }
      if (entries.length > 0 && generatedColumn <= entries[entries.length - 1].c) {
        throw new MapError(
          ErrorCode.GENERATED_COLUMN_REGRESSED,
          'generated columns within a line must be strictly increasing',
          {
            ...segCtx,
            generatedColumn,
            previousGeneratedColumn: entries[entries.length - 1].c
          }
        );
      }

      const entry = { c: generatedColumn, mapped: false };

      if (fields.length >= 4) {
        sourceIndex += fields[1];
        originalLine += fields[2];
        originalColumn += fields[3];

        if (sourceIndex < 0 || sourceIndex >= sources.length) {
          throw new MapError(
            ErrorCode.INDEX_OUT_OF_BOUNDS,
            `source index ${sourceIndex} is out of bounds (sources length ${sources.length})`,
            { ...segCtx, index: sourceIndex, bound: sources.length, indexKind: 'source' }
          );
        }
        if (originalLine < 0 || originalColumn < 0) {
          throw new MapError(
            ErrorCode.ORIGINAL_COORDINATE_INVALID,
            `original coordinates must be non-negative, got line ${originalLine}, column ${originalColumn}`,
            { ...segCtx, originalLine, originalColumn }
          );
        }

        entry.s = sourceIndex;
        entry.sl = originalLine;
        entry.sc = originalColumn;
        entry.mapped = true;

        if (fields.length === 5) {
          nameIndex += fields[4];
          if (nameIndex < 0 || nameIndex >= names.length) {
            throw new MapError(
              ErrorCode.INDEX_OUT_OF_BOUNDS,
              `name index ${nameIndex} is out of bounds (names length ${names.length})`,
              { ...segCtx, index: nameIndex, bound: names.length, indexKind: 'name' }
            );
          }
          entry.n = nameIndex;
        }
      }

      entries.push(entry);
    }

    lines.push(entries);
  }

  return {
    kind: 'flat',
    sources,
    names,
    lines,
    height: lines.length
  };
}

function parseIndexed(root) {
  const sections = root.sections;
  if (!Array.isArray(sections)) {
    throw new MapError(
      ErrorCode.SOURCEMAP_INVALID,
      '"sections" must be an array',
      { field: 'sections' }
    );
  }
  if (sections.length === 0) {
    throw new MapError(
      ErrorCode.SECTION_INVALID,
      '"sections" must contain at least one section'
    );
  }
  if (sections.length > MAX_SECTIONS) {
    throw new MapError(
      ErrorCode.SECTIONS_LIMIT_EXCEEDED,
      `a map may contain at most ${MAX_SECTIONS} sections, got ${sections.length}`,
      { sectionCount: sections.length, limit: MAX_SECTIONS }
    );
  }

  const parsed = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const ctx = { section: i };

    if (section === null || typeof section !== 'object' || Array.isArray(section)) {
      throw new MapError(
        ErrorCode.SECTION_INVALID,
        'section must be an object',
        ctx
      );
    }

    const offset = section.offset;
    if (offset === null || typeof offset !== 'object' || Array.isArray(offset)) {
      throw new MapError(
        ErrorCode.SECTION_INVALID,
        'section is missing an "offset" object',
        { ...ctx, field: 'offset' }
      );
    }
    for (const field of ['line', 'column']) {
      const value = offset[field];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new MapError(
          ErrorCode.SECTION_INVALID,
          `section offset.${field} must be a non-negative integer`,
          { ...ctx, field, value: value ?? null }
        );
      }
    }

    if (section.url !== undefined) {
      throw new MapError(
        ErrorCode.EXTERNAL_SECTION_UNSUPPORTED,
        'sections referenced by external "url" are not supported; embed the map inline',
        { ...ctx, url: String(section.url) }
      );
    }
    if (section.map === undefined || section.map === null) {
      throw new MapError(
        ErrorCode.SECTION_INVALID,
        'section must contain an embedded "map" object',
        ctx
      );
    }
    if (section.map === null || typeof section.map !== 'object' || Array.isArray(section.map)) {
      throw new MapError(
        ErrorCode.SECTION_INVALID,
        'section "map" must be an object',
        ctx
      );
    }
    if (section.map.sections !== undefined) {
      throw new MapError(
        ErrorCode.NESTED_SECTIONS_UNSUPPORTED,
        'nested indexed maps (sections inside a section map) are not supported',
        ctx
      );
    }

    const flat = parseFlat(section.map, i);
    parsed.push({
      offset: { line: offset.line, column: offset.column },
      map: flat
    });
  }

  // Sections must be strictly ordered lexicographically by (line, column).
  // Once ordered, overlap can only occur between adjacent sections.
  for (let i = 1; i < parsed.length; i++) {
    const prev = parsed[i - 1];
    const cur = parsed[i];

    const ordered =
      cur.offset.line > prev.offset.line ||
      (cur.offset.line === prev.offset.line && cur.offset.column > prev.offset.column);

    if (!ordered) {
      throw new MapError(
        ErrorCode.SECTIONS_NOT_ORDERED,
        'sections must be strictly ordered by offset (line, then column)',
        { section: i, previousOffset: prev.offset, offset: cur.offset }
      );
    }

    // Definite-overlap detection using the generated extent of the previous
    // section's mappings.
    if (cur.offset.line === prev.offset.line) {
      const firstLine = prev.map.lines[0];
      const prevMaxColumn =
        firstLine && firstLine.length > 0 ? firstLine[firstLine.length - 1].c : -1;
      if (cur.offset.column <= prev.offset.column + prevMaxColumn) {
        throw new MapError(
          ErrorCode.SECTIONS_NOT_ORDERED,
          'overlapping sections on the same generated line',
          {
            section: i,
            previousOffset: prev.offset,
            offset: cur.offset,
            previousEndColumn: prev.offset.column + prevMaxColumn
          }
        );
      }
    } else {
      // Previous section spans global lines [prevLine, prevLine + height - 1].
      // Beyond its first line, its generated columns restart at global 0.
      const prevLastLine = prev.offset.line + prev.map.height - 1;
      if (cur.offset.line < prevLastLine) {
        throw new MapError(
          ErrorCode.SECTIONS_NOT_ORDERED,
          'section starts on a generated line already covered by the previous section',
          {
            section: i,
            previousOffset: prev.offset,
            offset: cur.offset,
            previousEndLine: prevLastLine
          }
        );
      }
      if (cur.offset.line === prevLastLine) {
        const lastLine = prev.map.lines[prev.map.height - 1];
        const prevMaxColumn =
          lastLine && lastLine.length > 0 ? lastLine[lastLine.length - 1].c : -1;
        if (cur.offset.column <= prevMaxColumn) {
          throw new MapError(
            ErrorCode.SECTIONS_NOT_ORDERED,
            'overlapping sections on the previous section\'s last generated line',
            {
              section: i,
              previousOffset: prev.offset,
              offset: cur.offset,
              previousEndColumn: prevMaxColumn
            }
          );
        }
      }
    }
  }

  return { kind: 'indexed', sections: parsed };
}
