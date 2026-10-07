'use strict';

const { unprocessable } = require('./errors');

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64_VALUES = new Int16Array(128).fill(-1);
for (let i = 0; i < BASE64_CHARS.length; i += 1) {
  BASE64_VALUES[BASE64_CHARS.charCodeAt(i)] = i;
}

const CONTINUATION_BIT = 32;
const CHUNK_MASK = 31;

/**
 * Decode a single Base64 VLQ field starting at `pos` in `str`.
 * Returns { value, nextPos }. Throws INVALID_VLQ on malformed input:
 * unknown Base64 character, truncated continuation, or value overflow.
 */
function decodeVlqField(str, pos, context) {
  let shift = 0;
  let value = 0;
  let cursor = pos;

  for (;;) {
    if (cursor >= str.length) {
      throw unprocessable('INVALID_VLQ', 'truncated Base64 VLQ sequence', context);
    }
    const charCode = str.charCodeAt(cursor);
    const digit = charCode < 128 ? BASE64_VALUES[charCode] : -1;
    if (digit < 0) {
      throw unprocessable(
        'INVALID_VLQ',
        `invalid Base64 character ${JSON.stringify(str[cursor])} in VLQ sequence`,
        context,
      );
    }
    cursor += 1;
    // Multiply instead of bit-shifting so 32-bit overflow cannot corrupt
    // large (but still safe-integer) values.
    value += (digit & CHUNK_MASK) * 2 ** shift;
    if (!Number.isSafeInteger(value)) {
      throw unprocessable('INVALID_VLQ', 'VLQ value exceeds the safe integer range', context);
    }
    if ((digit & CONTINUATION_BIT) === 0) {
      break;
    }
    shift += 5;
  }

  const negative = value % 2 === 1;
  const magnitude = (value - (negative ? 1 : 0)) / 2;
  return { value: negative ? -magnitude : magnitude, nextPos: cursor };
}

/** Encode a single signed integer as a Base64 VLQ field. */
function encodeVlqField(value) {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`cannot VLQ-encode non-integer or unsafe value: ${value}`);
  }
  // Multiply/divide instead of bit-shifting so values above 2^31 encode
  // correctly (JavaScript bitwise operators truncate to 32 bits).
  let bits = value < 0 ? -value * 2 + 1 : value * 2;
  let out = '';
  do {
    let digit = bits % 32;
    bits = Math.floor(bits / 32);
    if (bits > 0) {
      digit |= CONTINUATION_BIT;
    }
    out += BASE64_CHARS[digit];
  } while (bits > 0);
  return out;
}

module.exports = { decodeVlqField, encodeVlqField };
