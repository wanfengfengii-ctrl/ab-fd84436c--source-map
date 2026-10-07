// Small VLQ/mappings builder used by the smoke script so that expected
// coordinates are declared numerically instead of hand-encoded strings.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeVlq(value) {
  let n = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = n & 31;
    n >>>= 5;
    if (n > 0) digit |= 32;
    out += B64[digit];
  } while (n > 0);
  return out;
}

// lines: array of generated lines; each line is an array of segment field
// arrays ([col] or [col, source, origLine, origCol(, name)]).
export function encodeMappings(lines) {
  return lines
    .map((segments) => segments.map((fields) => fields.map(encodeVlq).join('')).join(','))
    .join(';');
}
