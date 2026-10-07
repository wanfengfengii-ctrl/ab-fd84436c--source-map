import { MapError, ErrorCode, errorBody, httpStatusFor } from './errors.js';
import { parseSourceMap } from './parser.js';
import { resolveAll } from './resolver.js';

export const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB
export const MIN_FRAMES = 1;
export const MAX_FRAMES = 500;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  });
  res.end(payload);
}

function sendError(res, code, message, context) {
  sendJson(res, httpStatusFor(code), errorBody(code, message, context));
}

function isSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Validate the request envelope and the frame list. Frame coordinates use
 * the external convention (line one-based, column zero-based) and ids must
 * be unique within the request.
 */
function validateRequest(root) {
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new MapError(
      ErrorCode.REQUEST_INVALID,
      'request body must be a JSON object containing "sourceMap" and "frames"'
    );
  }

  if (!('sourceMap' in root) || root.sourceMap === undefined) {
    throw new MapError(
      ErrorCode.REQUEST_INVALID,
      'request is missing the "sourceMap" field',
      { field: 'sourceMap' }
    );
  }

  const frames = root.frames;
  if (!Array.isArray(frames)) {
    throw new MapError(
      ErrorCode.FRAMES_INVALID,
      '"frames" must be an array of stack frames',
      { field: 'frames' }
    );
  }
  if (frames.length < MIN_FRAMES || frames.length > MAX_FRAMES) {
    throw new MapError(
      ErrorCode.FRAMES_INVALID,
      `"frames" must contain between ${MIN_FRAMES} and ${MAX_FRAMES} entries, got ${frames.length}`,
      { frameCount: frames.length, min: MIN_FRAMES, max: MAX_FRAMES }
    );
  }

  const seenIds = new Set();
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const ctx = { frameIndex: i };

    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
      throw new MapError(
        ErrorCode.FRAME_INVALID,
        'each frame must be an object',
        ctx
      );
    }

    const id = frame.id;
    const idType = ['string', 'number'].includes(typeof id) && !Number.isNaN(id);
    if (!idType || id === null) {
      throw new MapError(
        ErrorCode.FRAME_INVALID,
        'frame "id" is required and must be a string or number',
        ctx
      );
    }
    if (seenIds.has(id)) {
      throw new MapError(
        ErrorCode.FRAME_DUPLICATE_ID,
        `duplicate frame id ${JSON.stringify(id)}`,
        { ...ctx, id }
      );
    }
    seenIds.add(id);

    if (!isSafeInteger(frame.line) || frame.line < 1) {
      throw new MapError(
        ErrorCode.FRAME_INVALID,
        'frame "line" is required and must be an integer >= 1 (one-based)',
        { ...ctx, id, field: 'line', value: frame.line ?? null }
      );
    }
    if (!isSafeInteger(frame.column) || frame.column < 0) {
      throw new MapError(
        ErrorCode.FRAME_INVALID,
        'frame "column" is required and must be an integer >= 0 (zero-based)',
        { ...ctx, id, field: 'column', value: frame.column ?? null }
      );
    }
  }

  return { sourceMap: root.sourceMap, frames };
}

function handleResolve(req, res) {
  const chunks = [];
  let received = 0;
  let tooLarge = false;

  req.on('data', (chunk) => {
    if (tooLarge) return; // keep draining the finite request body
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      tooLarge = true;
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (tooLarge) {
      sendError(
        res,
        ErrorCode.PAYLOAD_TOO_LARGE,
        `request body exceeds the ${MAX_BODY_BYTES} byte limit`,
        { limitBytes: MAX_BODY_BYTES }
      );
      return;
    }
    const raw = Buffer.concat(chunks).toString('utf8');

    let root;
    try {
      root = JSON.parse(raw);
    } catch (err) {
      sendError(
        res,
        ErrorCode.REQUEST_INVALID,
        `request body is not valid JSON: ${err.message}`,
        { syntaxError: err.message }
      );
      return;
    }

    let parsed;
    try {
      const { sourceMap, frames } = validateRequest(root);
      // Parse fully before resolving any frame so that an invalid map rejects
      // the entire request rather than returning partial results.
      parsed = { map: parseSourceMap(sourceMap), frames };
    } catch (err) {
      if (err instanceof MapError) {
        sendError(res, err.code, err.message, err.context);
      } else {
        sendError(res, ErrorCode.INTERNAL, err.message);
      }
      return;
    }

    try {
      const results = resolveAll(
        parsed.map,
        parsed.frames.map((f) => ({ id: f.id, line: f.line, column: f.column }))
      );
      sendJson(res, 200, { results });
    } catch (err) {
      if (err instanceof MapError) {
        sendError(res, err.code, err.message, err.context);
      } else {
        sendError(res, ErrorCode.INTERNAL, err.message);
      }
    }
  });

  req.on('error', () => {
    // Socket errors (including the intentional destroy above) need no
    // response if headers were already sent.
    if (!res.headersSent) sendError(res, ErrorCode.REQUEST_INVALID, 'request read failed');
  });
}

export function createHandler() {
  return function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (url.pathname === '/api/sourcemaps/resolve') {
      if (req.method !== 'POST') {
        sendError(
          res,
          ErrorCode.METHOD_NOT_ALLOWED,
          `method ${req.method} is not allowed; use POST`,
          { allowed: ['POST'] }
        );
        return;
      }
      handleResolve(req, res);
      return;
    }

    sendError(res, ErrorCode.NOT_FOUND, `no route for ${req.method} ${url.pathname}`);
  };
}
