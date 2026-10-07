import { createServer } from 'node:http';
import { createHandler } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid PORT environment variable: ${process.env.PORT}`);
  process.exit(1);
}

const server = createServer(createHandler());

server.listen(port, '0.0.0.0', () => {
  console.log(`sourcemap-resolve listening on port ${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  // Do not wait for keep-alive sockets indefinitely.
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
