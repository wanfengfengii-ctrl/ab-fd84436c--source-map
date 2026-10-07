'use strict';

/**
 * Stable API error. `code` is part of the public contract and never changes
 * for a given failure category; `context` carries locatable information
 * (frameIndex/id, sectionPath, generated line, segment index).
 */
class ApiError extends Error {
  constructor(status, code, message, context) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.context = context || {};
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        context: this.context,
      },
    };
  }
}

function badRequest(code, message, context) {
  return new ApiError(400, code, message, context);
}

function unprocessable(code, message, context) {
  return new ApiError(422, code, message, context);
}

module.exports = { ApiError, badRequest, unprocessable };
