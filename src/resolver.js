/**
 * Resolve generated (line, column) coordinates against a parsed map.
 *
 * Selection rule (Source Map v3 consumer convention): on the target generated
 * line, take the RIGHTMOST mapping segment whose generated column is not
 * greater than the target column. A 1-field segment is an explicit "no
 * mapping" marker, so hitting one (or finding no segment at all) yields an
 * unmapped verdict rather than falling through to an earlier segment.
 */

/**
 * Find the index of the rightmost entry with `c <= column` in a sorted
 * entries array. Returns -1 when every entry starts after `column`.
 */
function findRightmostEntry(entries, column) {
  let lo = 0;
  let hi = entries.length - 1;
  let answer = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].c <= column) {
      answer = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return answer;
}

function resolveInFlat(flat, localLine, localColumn) {
  if (localLine < 0 || localLine >= flat.lines.length) return null;
  const entries = flat.lines[localLine];
  const idx = findRightmostEntry(entries, localColumn);
  if (idx < 0) return null;

  const entry = entries[idx];
  if (!entry.mapped) return null; // explicit unmapped marker segment

  const source = flat.sources[entry.s] ?? null;
  const result = {
    source: source ?? null,
    // Original line is stored zero-based per the spec; report one-based.
    line: entry.sl + 1,
    // Original column stays zero-based.
    column: entry.sc
  };
  if (entry.n !== undefined) {
    result.name = flat.names[entry.n] ?? null;
  }
  return result;
}

/**
 * Pick the rightmost section whose generated offset is not greater than
 * (line, column) in lexicographic order. Returns -1 if the frame lands
 * before the first section.
 */
function findSection(sections, line, column) {
  let lo = 0;
  let hi = sections.length - 1;
  let answer = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const off = sections[mid].offset;
    if (off.line < line || (off.line === line && off.column <= column)) {
      answer = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return answer;
}

/**
 * Resolve one frame. Inputs use the external coordinate convention:
 *   generatedLine   - one-based
 *   generatedColumn - zero-based
 * Returns { status: 'mapped', result, section? } or { status: 'unmapped' }.
 */
export function resolveFrame(parsedMap, generatedLine, generatedColumn) {
  const line0 = generatedLine - 1;

  if (parsedMap.kind === 'flat') {
    const result = resolveInFlat(parsedMap, line0, generatedColumn);
    return result ? { status: 'mapped', result } : { status: 'unmapped' };
  }

  // Indexed map: translate global generated coordinates into section-local
  // coordinates. A section starting at global column C only shifts columns
  // on its first generated line; on later lines the local column restarts
  // at global column 0.
  const sectionIndex = findSection(parsedMap.sections, line0, generatedColumn);
  if (sectionIndex < 0) return { status: 'unmapped' };

  const { offset, map } = parsedMap.sections[sectionIndex];
  const localLine = line0 - offset.line;
  const localColumn = line0 === offset.line ? generatedColumn - offset.column : generatedColumn;

  if (localColumn < 0 || localLine < 0) return { status: 'unmapped' };

  const result = resolveInFlat(map, localLine, localColumn);
  return result
    ? { status: 'mapped', section: sectionIndex, result }
    : { status: 'unmapped', section: sectionIndex };
}

export function resolveAll(parsedMap, frames) {
  // Map the input frames in order; resolution is a pure function of the
  // (map, frame) pair, so repeated calls always return identical output.
  return frames.map((frame) => {
    const verdict = resolveFrame(parsedMap, frame.line, frame.column);
    return { id: frame.id, frame: { line: frame.line, column: frame.column }, ...verdict };
  });
}
