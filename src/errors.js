// Stable error codes returned by the API.
// Every rejection of a resolve request uses one of these codes so that
// clients can branch on the failure category programmatically.
export const ErrorCode = Object.freeze({
  // Transport / envelope
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  REQUEST_INVALID: 'REQUEST_INVALID',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  INTERNAL: 'INTERNAL',

  // Frame validation
  FRAMES_INVALID: 'FRAMES_INVALID',
  FRAME_INVALID: 'FRAME_INVALID',
  FRAME_DUPLICATE_ID: 'FRAME_DUPLICATE_ID',

  // Source map structure
  SOURCEMAP_INVALID: 'SOURCEMAP_INVALID',
  SOURCEMAP_VERSION_UNSUPPORTED: 'SOURCEMAP_VERSION_UNSUPPORTED',

  // Mappings / VLQ
  VLQ_INVALID: 'VLQ_INVALID',
  SEGMENT_INVALID_LENGTH: 'SEGMENT_INVALID_LENGTH',
  INDEX_OUT_OF_BOUNDS: 'INDEX_OUT_OF_BOUNDS',
  GENERATED_COLUMN_REGRESSED: 'GENERATED_COLUMN_REGRESSED',
  ORIGINAL_COORDINATE_INVALID: 'ORIGINAL_COORDINATE_INVALID',

  // Sections
  SECTIONS_LIMIT_EXCEEDED: 'SECTIONS_LIMIT_EXCEEDED',
  SECTIONS_NOT_ORDERED: 'SECTIONS_NOT_ORDERED',
  SECTION_INVALID: 'SECTION_INVALID',
  EXTERNAL_SECTION_UNSUPPORTED: 'EXTERNAL_SECTION_UNSUPPORTED',
  NESTED_SECTIONS_UNSUPPORTED: 'NESTED_SECTIONS_UNSUPPORTED'
});

const HTTP_STATUS = Object.freeze({
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.METHOD_NOT_ALLOWED]: 405,
  [ErrorCode.INTERNAL]: 500
});

export class MapError extends Error {
  constructor(code, message, context) {
    super(message);
    this.name = 'MapError';
    this.code = code;
    if (context !== undefined) this.context = context;
  }
}

export function errorBody(code, message, context) {
  const body = { error: { code, message } };
  if (context !== undefined) body.error.context = context;
  return body;
}

export function httpStatusFor(code) {
  return HTTP_STATUS[code] ?? 400;
}
