import { MapError, ErrorCode } from './errors.js';

// Standard Base64 alphabet used by Source Map v3 VLQ fields.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DECODE_TABLE = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

const VLQ_BASE_SHIFT = 5;
const VLQ_BASE = 1 << VLQ_BASE_SHIFT; // 32
const VLQ_BASE_MASK = VLQ_BASE - 1; // 0x1f
const VLQ_CONTINUATION_BIT = VLQ_BASE; // 0x20

/**
 * Decode one VLQ value starting at `pos` in `str`.
 * Returns { value, next }. A VLQ value is an unsigned quantity whose LSB is
 * the sign bit (zig-zag encoding).
 *
 * Strict on purpose: any character outside the Base64 alphabet, a dangling
 * continuation with no terminating digit, or an excessively long group is
 * rejected with VLQ_INVALID and the section/line/column context.
 */
export function decodeVlq(str, pos, context) {
  const start = pos;
  let result = 0;
  let shift = 0;
  let continuation;

  do {
    if (pos >= str.length) {
      throw new MapError(
        ErrorCode.VLQ_INVALID,
        'VLQ group is missing its terminating digit',
        { ...context, vlq: str.slice(start, pos) || null }
      );
    }
    const ch = str.charCodeAt(pos);
    const digit = ch < 128 ? DECODE_TABLE[ch] : -1;
    if (digit < 0) {
      throw new MapError(
        ErrorCode.VLQ_INVALID,
        `Illegal Base64 VLQ character ${JSON.stringify(str[pos])}`,
        { ...context, character: str[pos], offset: pos }
      );
    }
    pos++;
    continuation = (digit & VLQ_CONTINUATION_BIT) !== 0;
    const part = digit & VLQ_BASE_MASK;

    // 6 groups of 5 bits already cover 30 bits; the 7th group may only
    // contribute its sign-bearing low bit for a 32-bit magnitude. Anything
    // wider is not a valid Source Map VLQ (and risks lossy accumulation).
    if (shift > 30 || (shift === 30 && part > 1)) {
      throw new MapError(
        ErrorCode.VLQ_INVALID,
        'VLQ value exceeds the supported 32-bit range',
        { ...context, offset: pos - 1 }
      );
    }
    result += part << shift;
    shift += VLQ_BASE_SHIFT;
  } while (continuation);

  const negate = (result & 1) === 1;
  let value = result >> 1;
  if (negate) value = -value;
  return { value, next: pos };
}
