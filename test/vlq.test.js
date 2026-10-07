'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decodeVlqField, encodeVlqField } = require('../src/vlq');
const { ApiError } = require('../src/errors');

test('decodes single-digit values', () => {
  assert.equal(decodeVlqField('A', 0, {}).value, 0);
  assert.equal(decodeVlqField('C', 0, {}).value, 1);
  assert.equal(decodeVlqField('D', 0, {}).value, -1);
  assert.equal(decodeVlqField('I', 0, {}).value, 4);
  assert.equal(decodeVlqField('J', 0, {}).value, -4);
});

test('decodes multi-digit (continuation) values', () => {
  // Hand-computed vectors: chunks are 5-bit, LSB of the assembled value is the sign.
  assert.equal(decodeVlqField('Q', 0, {}).value, 8); // 16 >> 1
  assert.equal(decodeVlqField('oG', 0, {}).value, 100); // 8 | 6<<5 = 200 -> 100
  assert.equal(decodeVlqField('pG', 0, {}).value, -100); // 201 -> -100
  assert.equal(decodeVlqField('wC', 0, {}).value, 40); // 16|32 cont, then 2 -> 80 -> 40
});

test('round-trips a wide range of integers', () => {
  const values = [0, 1, -1, 2, -2, 15, -16, 31, -31, 32, -32, 1000, -999, 2 ** 40, -(2 ** 40)];
  for (const value of values) {
    const encoded = encodeVlqField(value);
    const decoded = decodeVlqField(encoded, 0, {});
    assert.equal(decoded.value, value, `round-trip of ${value}`);
    assert.equal(decoded.nextPos, encoded.length);
  }
});

test('stops at the end of one field and reports nextPos', () => {
  const decoded = decodeVlqField('CA', 0, {});
  assert.equal(decoded.value, 1);
  assert.equal(decoded.nextPos, 1);
});

test('rejects invalid Base64 characters with INVALID_VLQ', () => {
  assert.throws(() => decodeVlqField('!', 0, { generatedLine: 3 }), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'INVALID_VLQ');
    assert.equal(error.context.generatedLine, 3);
    return true;
  });
  assert.throws(() => decodeVlqField('Aé', 1, {}), /invalid Base64 character/);
});

test('rejects truncated continuation with INVALID_VLQ', () => {
  // 'g' is index 32: continuation bit set, then the string ends.
  assert.throws(() => decodeVlqField('g', 0, {}), /truncated Base64 VLQ/);
});

test('rejects values beyond the safe integer range', () => {
  const huge = '7'.repeat(20) + 'B'; // many continuation chunks
  assert.throws(() => decodeVlqField(huge, 0, {}), (error) => {
    assert.equal(error.code, 'INVALID_VLQ');
    return true;
  });
});
