import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { z } from 'zod';
import { DomainError } from '../domain/errors.js';
import { positions } from '../domain/order-book.js';
import {
  errorResponseSchema,
  filtersSchema,
  orderResponseSchema,
  ordersResponseSchema,
  positionsResponseSchema,
  sessionRequestSchema,
  sessionResponseSchema,
} from '../domain/schemas.js';
import { SessionStore } from '../domain/session-store.js';

const BODY_LIMIT_BYTES = 16_384;
const staticFiles = new Map([
  [
    '/',
    { path: new URL('../public/index.html', import.meta.url), type: 'text/html; charset=utf-8' },
  ],
  [
    '/index.html',
    { path: new URL('../public/index.html', import.meta.url), type: 'text/html; charset=utf-8' },
  ],
  [
    '/style.css',
    { path: new URL('../public/style.css', import.meta.url), type: 'text/css; charset=utf-8' },
  ],
  [
    '/app.js',
    { path: new URL('../public/app.js', import.meta.url), type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/openapi.yaml',
    {
      path: new URL('../../contracts/openapi.yaml', import.meta.url),
      type: 'application/yaml; charset=utf-8',
    },
  ],
]);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DomainError(
      400,
      'VALIDATION_ERROR',
      'Request fields do not match the documented schema.',
    );
  }
  return result.data;
}

function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    request.resume();
    return Promise.reject(new DomainError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.'));
  }
  if (Number(request.headers['content-length']) > BODY_LIMIT_BYTES) {
    request.resume();
    return Promise.reject(
      new DomainError(413, 'PAYLOAD_TOO_LARGE', 'JSON bodies are limited to 16 KiB.'),
    );
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        oversized = true;
        chunks.length = 0;
        reject(new DomainError(413, 'PAYLOAD_TOO_LARGE', 'JSON bodies are limited to 16 KiB.'));
      } else if (!oversized) {
        chunks.push(chunk);
      }
    });
    request.once('end', () => {
      if (oversized) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new DomainError(400, 'INVALID_JSON', 'The request body must be valid JSON.'));
      }
    });
    request.once('error', reject);
    request.once('aborted', () =>
      reject(new DomainError(400, 'INVALID_JSON', 'The request was interrupted.')),
    );
  });
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return header?.match(/^Bearer ([^\s]+)$/i)?.[1];
}

function decodeOrderId(encodedId: string): string {
  try {
    return decodeURIComponent(encodedId);
  } catch (error: unknown) {
    if (error instanceof URIError) {
      throw new DomainError(400, 'VALIDATION_ERROR', 'Order IDs must use valid percent encoding.');
    }
    throw error;
  }
}

export function createApplicationServer() {
  const sessions = new SessionStore();

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'",
    );
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      json(response, 200, { status: 'ok', service: 'TradeFlow Lab', synthetic: true });
      return;
    }
    const file = staticFiles.get(url.pathname);
    if (method === 'GET' && file) {
      const contents = await readFile(file.path);
      response.writeHead(200, { 'Content-Type': file.type });
      response.end(contents);
      return;
    }
    if (method === 'POST' && url.pathname === '/api/session') {
      const input = validate(sessionRequestSchema, await readJson(request));
      json(
        response,
        200,
        sessionResponseSchema.parse(sessions.login(input.username, input.password)),
      );
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      throw new DomainError(404, 'ROUTE_NOT_FOUND', 'This local route does not exist.');
    }
    const token = bearerToken(request);
    const session = sessions.authenticate(token);

    if (url.pathname === '/api/session' && method === 'GET') {
      json(response, 200, { user: session.user });
      return;
    }
    if (url.pathname === '/api/session' && method === 'DELETE') {
      if (token) sessions.delete(token);
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === '/api/orders' && method === 'GET') {
      const filters: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        if (key in filters) {
          throw new DomainError(
            400,
            'VALIDATION_ERROR',
            'Filter parameters must appear only once.',
          );
        }
        filters[key] = value;
      }
      json(
        response,
        200,
        ordersResponseSchema.parse({ orders: session.book.list(validate(filtersSchema, filters)) }),
      );
      return;
    }
    if (url.pathname === '/api/positions' && method === 'GET') {
      json(response, 200, positionsResponseSchema.parse({ positions }));
      return;
    }
    const detail = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (detail?.[1] && method === 'GET') {
      json(
        response,
        200,
        orderResponseSchema.parse({ order: session.book.get(decodeOrderId(detail[1])) }),
      );
      return;
    }
    const cancellation = url.pathname.match(/^\/api\/orders\/([^/]+)\/cancel$/);
    const createOrder = url.pathname === '/api/orders' && method === 'POST';
    if (createOrder || (cancellation?.[1] && method === 'POST')) {
      if (session.user.role !== 'trader') {
        throw new DomainError(403, 'FORBIDDEN', 'Viewer sessions cannot change synthetic orders.');
      }
      if (createOrder) {
        const order = session.book.create(await readJson(request));
        response.setHeader('Location', `/api/orders/${order.id}`);
        json(response, 201, orderResponseSchema.parse({ order }));
      } else if (cancellation?.[1]) {
        json(
          response,
          200,
          orderResponseSchema.parse({ order: session.book.cancel(decodeOrderId(cancellation[1])) }),
        );
      }
      return;
    }
    throw new DomainError(404, 'ROUTE_NOT_FOUND', 'This local API route does not exist.');
  }

  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      if (response.headersSent || response.destroyed) return;
      const failure =
        error instanceof DomainError
          ? error
          : new DomainError(500, 'INTERNAL_ERROR', 'An unexpected local server error occurred.');
      if (!(error instanceof DomainError)) console.error('Unexpected application error:', error);
      json(
        response,
        failure.status,
        errorResponseSchema.parse({
          error: { code: failure.code, message: failure.message },
        }),
      );
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const portText = process.env.PORT ?? '3000';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const server = createApplicationServer();
  server.once('error', (error) => {
    console.error('TradeFlow Lab could not start:', error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`TradeFlow Lab synthetic interview lab: http://127.0.0.1:${port}`);
  });
  const shutdown = () => {
    server.close(() => {
      process.exitCode = 0;
    });
    server.closeIdleConnections();
    const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
    deadline.unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
