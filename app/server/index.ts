import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { z } from 'zod';
import { DomainError } from '../domain/errors.js';
import { AdmissionWindow } from '../domain/admission.js';
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
import {
  ConfigurationError,
  readConfiguration,
  type ApplicationConfiguration,
} from './configuration.js';

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
    '/favicon.svg',
    { path: new URL('../public/favicon.svg', import.meta.url), type: 'image/svg+xml' },
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
      if (oversized) return;
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

export function createApplicationServer(
  options: {
    configuration?: ApplicationConfiguration;
    now?: () => number;
  } = {},
) {
  const configuration = options.configuration ?? readConfiguration({});
  const now = options.now ?? (() => performance.now());
  const hosted = configuration.mode === 'hosted-demo';
  const sessions = new SessionStore({
    ...(hosted ? { limits: configuration.limits } : {}),
    now,
  });
  const requests = hosted
    ? new AdmissionWindow(configuration.admission.requestsPerMinute, 60_000, now)
    : undefined;
  const authentication = hosted
    ? new AdmissionWindow(configuration.admission.authPerMinute, 60_000, now)
    : undefined;
  const mutations = hosted
    ? new AdmissionWindow(configuration.admission.mutationsPerMinute, 60_000, now)
    : undefined;

  function publicDemoHtml(contents: Buffer): string {
    if (!hosted) return contents.toString('utf8');
    return contents
      .toString('utf8')
      .replace('data-demo-mode="local"', 'data-demo-mode="hosted-demo"')
      .replace('a local synthetic trading environment', 'a synthetic public demo')
      .replace('SYNTHETIC / LOCAL', 'SYNTHETIC / PUBLIC DEMO')
      .replace(
        'Environment: Synthetic · local only',
        'Environment: Synthetic · public demo · ephemeral',
      )
      .replace('Local synthetic orders only.', 'Ephemeral synthetic orders only.')
      .replace(
        'Every login starts with a fresh synthetic book.',
        `Public synthetic demo. Sessions expire after ${configuration.limits.ttlMs / 1000} seconds. Logout or restart discards your book. Resource limits may reject requests. No production identity system.`,
      );
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'",
    );
    const method = request.method ?? 'GET';
    const target = request.url ?? '/';
    const path = target.split('?')[0];
    if (
      !(method === 'GET' && path === '/health') &&
      !(method === 'DELETE' && path === '/api/session')
    )
      requests?.take();
    let url: URL;
    try {
      if (!target.startsWith('/') || target.startsWith('//')) throw new Error('Invalid target');
      url = new URL(target, 'http://127.0.0.1');
      if (url.origin !== 'http://127.0.0.1') throw new Error('Invalid origin');
    } catch {
      throw new DomainError(400, 'VALIDATION_ERROR', 'The request target must be a local path.');
    }

    if (method === 'GET' && url.pathname === '/health') {
      json(response, 200, { status: 'ok', service: 'TradeFlow Lab', synthetic: true });
      return;
    }
    const file = staticFiles.get(url.pathname);
    if (method === 'GET' && file) {
      const contents = await readFile(file.path);
      response.writeHead(200, { 'Content-Type': file.type });
      response.end(file.type.startsWith('text/html') ? publicDemoHtml(contents) : contents);
      return;
    }
    if (method === 'POST' && url.pathname === '/api/session') {
      authentication?.take();
      const input = validate(sessionRequestSchema, await readJson(request));
      json(
        response,
        200,
        sessionResponseSchema.parse(sessions.login(input.username, input.password)),
      );
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      throw new DomainError(404, 'ROUTE_NOT_FOUND', 'This route does not exist.');
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
      mutations?.take();
      sessions.admitMutation(token);
      if (createOrder) {
        const input = await readJson(request);
        // A body can arrive after logout/expiry; never mutate the earlier held session.
        const current = sessions.authenticate(token);
        const order = current.book.create(input);
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
    throw new DomainError(404, 'ROUTE_NOT_FOUND', 'This API route does not exist.');
  }

  const server = createServer(
    {
      ...(hosted ? { maxHeaderSize: 8192, connectionsCheckingInterval: 1000 } : {}),
    },
    (request, response) => {
      if (request.headers['transfer-encoding'] || Number(request.headers['content-length']) > 0) {
        response.setHeader('Connection', 'close');
      }
      response.once('finish', () => {
        if (!request.complete) request.destroy();
      });
      void route(request, response).catch((error: unknown) => {
        if (response.headersSent || response.destroyed) return;
        const failure =
          error instanceof DomainError
            ? error
            : new DomainError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred.');
        if (!(error instanceof DomainError)) console.error('TradeFlow INTERNAL_ERROR');
        if (failure.retryAfterSeconds !== undefined) {
          response.setHeader('Retry-After', String(failure.retryAfterSeconds));
        }
        json(
          response,
          failure.status,
          errorResponseSchema.parse({
            error: { code: failure.code, message: failure.message },
          }),
        );
      });
    },
  );
  server.requestTimeout = 10_000;
  server.headersTimeout = hosted ? 5_000 : 10_000;
  if (hosted) {
    server.maxConnections = 128;
    server.maxHeadersCount = 64;
    server.maxRequestsPerSocket = 100;
    server.keepAliveTimeout = 5_000;
    server.setTimeout(10_000, (socket) => socket.destroy());
  }
  const expirySweep = hosted ? setInterval(() => sessions.pruneExpired(), 30_000) : undefined;
  expirySweep?.unref();
  server.once('close', () => {
    clearInterval(expirySweep);
    sessions.clear();
  });
  return server;
}

async function start(): Promise<void> {
  const configuration = readConfiguration();
  // Verify the complete runtime artifact before reporting readiness or opening a listener.
  await Promise.all(
    [...staticFiles.values()].map(async (file) => {
      const bytes = await readFile(file.path);
      if (bytes.length === 0) throw new Error('Empty runtime asset');
    }),
  );
  const server = createApplicationServer({ configuration });
  server.once('error', () => {
    console.error('TradeFlow could not listen on the configured host and PORT.');
    process.exitCode = 1;
  });
  server.listen(configuration.port, configuration.host, () => {
    console.log(
      `TradeFlow Lab synthetic ${configuration.mode}: http://${configuration.host}:${configuration.port}`,
    );
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
    deadline.unref();
    server.close(() => {
      clearTimeout(deadline);
      process.exitCode = 0;
    });
    server.closeIdleConnections();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void start().catch((error: unknown) => {
    console.error(
      error instanceof ConfigurationError
        ? `TradeFlow configuration error: ${error.message}`
        : 'TradeFlow runtime assets are missing or unreadable. Run a successful build before starting.',
    );
    process.exitCode = 1;
  });
}
