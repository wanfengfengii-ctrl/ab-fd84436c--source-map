'use strict';

const http = require('http');
const { ApiError } = require('./errors');
const { resolveRequest } = require('./sourcemap');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Hard cap on the raw request body. The sourceMap itself is limited to 2 MiB
// separately; the headroom covers frames and envelope overhead.
const MAX_BODY_BYTES = 3 * 1024 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Keep draining so the socket stays usable, but stop buffering.
        tooLarge = true;
        return;
      }
      if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(
          new ApiError(413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`, {
            maxBytes: MAX_BODY_BYTES,
          }),
        );
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      reject(new ApiError(400, 'INVALID_REQUEST', 'failed to read request body', {}));
    });
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/health') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new ApiError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed on ${path}`, {});
    }
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (path === '/api/sourcemaps/resolve') {
    if (req.method !== 'POST') {
      throw new ApiError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed on ${path}; use POST`, {
        method: req.method,
      });
    }
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ApiError(400, 'INVALID_JSON', 'request body is not valid JSON', {});
    }
    sendJson(res, 200, resolveRequest(body));
    return;
  }

  throw new ApiError(404, 'NOT_FOUND', `unknown route ${req.method} ${path}`, {
    method: req.method,
    path,
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    if (error instanceof ApiError) {
      sendJson(res, error.status, error.toJSON());
      return;
    }
    // eslint-disable-next-line no-console
    console.error('unexpected error:', error);
    sendJson(res, 500, {
      error: { code: 'INTERNAL_ERROR', message: 'unexpected server error', context: {} },
    });
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`sourcemap-resolve listening on http://${HOST}:${PORT}`);
  });
}

module.exports = { server };
