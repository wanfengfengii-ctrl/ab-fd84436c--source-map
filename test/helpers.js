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

// Encode one segment from its numeric VLQ fields.
const seg = (...fields) => fields.map(encodeVlq).join('');

// Encode a full mappings string: arrays of field-arrays, one per line.
export const mappings = (lines) =>
  lines.map((segments) => segments.map((s) => seg(...s)).join(',')).join(';');

export const flatMap = ({ sources = ['one.js'], names = [], lines }) => ({
  version: 3,
  sources,
  names,
  mappings: mappings(lines)
});
