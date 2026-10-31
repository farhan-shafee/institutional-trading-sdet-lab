import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { setTimeout as waitForExpiry } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import {
  errorResponseSchema,
  orderResponseSchema,
  ordersResponseSchema,
  sessionResponseSchema,
} from '../app/domain/schemas.js';

const entry =
  process.argv[2] ?? fileURLToPath(new URL('../dist/app/server/index.js', import.meta.url));
assert(isAbsolute(entry), 'The optional production entry must be an absolute path.');
assert((await stat(entry)).isFile(), 'Build the production server before running this smoke.');
const password = 'Password123!';
const orderInput = { symbol: 'MSFT', side: 'BUY', quantity: 7, type: 'LIMIT', limitPrice: 401.25 };
let drainingRequest: ClientRequest | undefined;
let activeDrainVerified = false;

async function deadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function availablePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  assert(address && typeof address !== 'string', 'A loopback TCP port must be reserved.');
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function startApplication(overrides: NodeJS.ProcessEnv = {}) {
  const baseURL = `http://127.0.0.1:${await availablePort()}`;
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.toUpperCase().startsWith('TRADEFLOW_') &&
        !['NODE_OPTIONS', 'NODE_PATH'].includes(name.toUpperCase()),
    ),
  );
  Object.assign(env, {
    TRADEFLOW_MODE: 'hosted-demo',
    TRADEFLOW_HOST: '127.0.0.1',
    TRADEFLOW_SESSION_TTL_SECONDS: '120',
    TRADEFLOW_MAX_SESSIONS: '2',
    TRADEFLOW_MAX_ORDERS_PER_SESSION: '6',
    ...overrides,
    PORT: new URL(baseURL).port,
  });
  assert.equal(env.TRADEFLOW_HOST, '127.0.0.1', 'The smoke may only bind loopback.');
  const child = spawn(process.execPath, [entry], {
    cwd: tmpdir(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const secrets = new Set([password]);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', () => resolve({ code: null, signal: null }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise<void>((resolve) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes(baseURL)) resolve();
    });
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  const app = { child, baseURL, closed, secrets, output: () => output };
  try {
    await deadline(
      Promise.race([
        ready,
        closed.then(() => {
          throw new Error('The built application exited before announcing loopback readiness.');
        }),
      ]),
      10_000,
      'The built application did not announce loopback readiness within 10 seconds.',
    );
    return app;
  } catch (error) {
    child.kill('SIGKILL');
    await deadline(closed, 2_000, 'Startup cleanup could not stop the owned child.');
    throw error;
  }
}

type Application = Awaited<ReturnType<typeof startApplication>>;

async function stopApplication(app: Application): Promise<void> {
  try {
    assert(
      app.child.exitCode === null && app.child.signalCode === null,
      'The built application must remain running until its owned shutdown.',
    );
    const started = performance.now();
    assert(app.child.kill('SIGTERM'), 'The owned application must receive its shutdown signal.');
    const result = await deadline(
      app.closed,
      8_000,
      'The application exceeded its five-second drain deadline plus shutdown margin.',
    );
    if (process.platform !== 'win32') {
      assert.equal(result.code, 0, 'SIGTERM must produce a clean native Node exit.');
      assert.equal(result.signal, null, 'The application must handle SIGTERM before exiting.');
      if (drainingRequest) {
        assert(
          performance.now() - started >= 4_000,
          'An active body read must receive its drain window.',
        );
        activeDrainVerified = true;
      }
    }
  } finally {
    if (app.child.exitCode === null && app.child.signalCode === null) {
      app.child.kill('SIGKILL');
      await deadline(app.closed, 2_000, 'Cleanup could not stop the owned application.');
    }
    drainingRequest?.destroy();
    drainingRequest = undefined;
    for (const secret of app.secrets) {
      assert(
        !app.output().includes(secret),
        'Application logs must omit passwords and bearer tokens.',
      );
    }
  }
}

function request(app: Application, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${app.baseURL}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
}

function authorization(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function post(app: Application, path: string, body: unknown, token?: string): Promise<Response> {
  return request(app, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? authorization(token) : {}) },
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<unknown> {
  assert(response.headers.get('content-type')?.startsWith('application/json'), 'Expected JSON.');
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error('The application returned malformed JSON.');
  }
}

async function parse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await json(response));
  assert(result.success, 'The HTTP response must match its runtime wire schema.');
  return result.data;
}

async function errorCode(response: Response, code: string): Promise<void> {
  assert.equal((await parse(response, errorResponseSchema)).error.code, code);
}

async function login(app: Application, username: 'qa.user' | 'qa.viewer') {
  const response = await post(app, '/api/session', { username, password });
  assert.equal(response.status, 200, 'Synthetic fixture login must succeed.');
  const session = await parse(response, sessionResponseSchema);
  app.secrets.add(session.token);
  return session;
}

async function logout(app: Application, token: string): Promise<void> {
  const response = await request(app, '/api/session', {
    method: 'DELETE',
    headers: authorization(token),
  });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  const revoked = await request(app, '/api/orders', { headers: authorization(token) });
  assert.equal(revoked.status, 401);
  await errorCode(revoked, 'UNAUTHORIZED');
}

const main = await startApplication();
try {
  const health = await request(main, '/health');
  assert.equal(health.status, 200);
  const healthBody = await json(health);
  assert(healthBody !== null && typeof healthBody === 'object' && !Array.isArray(healthBody));
  assert.equal(Object.keys(healthBody).sort().join(','), 'service,status,synthetic');
  assert('status' in healthBody && healthBody.status === 'ok');
  assert('service' in healthBody && healthBody.service === 'TradeFlow Lab');
  assert('synthetic' in healthBody && healthBody.synthetic === true);
  for (const [path, contentType] of [
    ['/', 'text/html'],
    ['/style.css', 'text/css'],
    ['/app.js', 'text/javascript'],
    ['/openapi.yaml', 'application/yaml'],
  ] as const) {
    const response = await request(main, path);
    assert.equal(response.status, 200, `Built asset must be served: ${path}`);
    assert(response.headers.get('content-type')?.startsWith(contentType), 'Asset content type.');
    const text = await response.text();
    assert(text.trim().length > 0, 'Built assets must contain content.');
    if (path === '/') {
      assert(text.includes('PUBLIC DEMO'), 'Hosted HTML must identify the public demo.');
      assert(text.includes('Sessions expire'), 'Hosted HTML must disclose session expiry.');
    }
  }

  const trader = await login(main, 'qa.user');
  const viewer = await login(main, 'qa.viewer');
  const financial = await request(
    main,
    '/api/fixed-income/v1/analytics?instrument_id=SYN-UST-2031&settlement_date=2025-07-16&par_amount=46&clean_price=100',
    { headers: authorization(viewer.token) },
  );
  assert.equal(financial.status, 200);
  const financialBody = (await json(financial)) as { consideration_usd: string };
  assert.equal(
    financialBody.consideration_usd,
    '46.00',
    'Native production artifact retains exact half-even financial cash.',
  );

  assert.deepEqual(trader.user, { username: 'qa.user', role: 'trader' });
  assert.deepEqual(viewer.user, { username: 'qa.viewer', role: 'viewer' });
  const seeded = await request(main, '/api/orders', { headers: authorization(trader.token) });
  assert.equal(seeded.status, 200);
  assert.equal((await parse(seeded, ordersResponseSchema)).orders.length, 5);
  const created = await post(main, '/api/orders', orderInput, trader.token);
  assert.equal(created.status, 201);
  const owned = (await parse(created, orderResponseSchema)).order;
  assert.match(owned.id, /^order-[0-9a-f-]{36}$/);
  assert.deepEqual(owned, {
    ...orderInput,
    id: owned.id,
    status: 'NEW',
    createdAt: owned.createdAt,
  });
  const orderPath = `/api/orders/${owned.id}`;
  assert.equal(created.headers.get('location'), orderPath);
  const detail = await request(main, orderPath, { headers: authorization(trader.token) });
  assert.equal(detail.status, 200);
  assert.deepEqual((await parse(detail, orderResponseSchema)).order, owned);
  const isolated = await request(main, orderPath, { headers: authorization(viewer.token) });
  assert.equal(isolated.status, 404);
  await errorCode(isolated, 'ORDER_NOT_FOUND');
  const canceled = await post(main, `${orderPath}/cancel`, {}, trader.token);
  assert.equal(canceled.status, 200);
  assert.deepEqual((await parse(canceled, orderResponseSchema)).order, {
    ...owned,
    status: 'CANCELED',
  });
  const filled = await post(main, '/api/orders/seed-filled-nvda/cancel', {}, trader.token);
  assert.equal(filled.status, 409);
  await errorCode(filled, 'ORDER_NOT_CANCELABLE');
  const capacity = await post(main, '/api/orders', orderInput, trader.token);
  assert.equal(capacity.status, 409);
  await errorCode(capacity, 'ORDER_CAPACITY_REACHED');
  const deniedCreate = await post(main, '/api/orders', orderInput, viewer.token);
  assert.equal(deniedCreate.status, 403);
  await errorCode(deniedCreate, 'FORBIDDEN');
  const deniedCancel = await post(main, '/api/orders/seed-new-aapl/cancel', {}, viewer.token);
  assert.equal(deniedCancel.status, 403);
  await errorCode(deniedCancel, 'FORBIDDEN');
  const missing = await request(main, '/api/orders');
  assert.equal(missing.status, 401);
  await errorCode(missing, 'UNAUTHORIZED');
  await logout(main, trader.token);
  await logout(main, viewer.token);
  if (process.platform !== 'win32') {
    const session = await login(main, 'qa.user');
    // 100 Continue confirms that the native server received complete headers and entered its body read.
    const pending = httpRequest(`${main.baseURL}/api/orders`, {
      method: 'POST',
      headers: {
        ...authorization(session.token),
        'Content-Type': 'application/json',
        Expect: '100-continue',
      },
    });
    drainingRequest = pending;
    pending.on('error', () => undefined); // Forced connection closure is the expected drain outcome.
    const accepted = new Promise<void>((resolve) => pending.once('continue', resolve));
    pending.flushHeaders();
    await deadline(accepted, 10_000, 'The native server did not accept the drain probe headers.');
    // Deliberately leave this body unfinished; SIGTERM must wait, then force-close it after five seconds.
  }
} finally {
  await stopApplication(main);
}

const expiry = await startApplication({
  TRADEFLOW_SESSION_TTL_SECONDS: '1',
  TRADEFLOW_MAX_SESSIONS: '1',
});
try {
  const original = await login(expiry, 'qa.user');
  const created = await post(expiry, '/api/orders', orderInput, original.token);
  assert.equal(created.status, 201);
  const originalOrder = (await parse(created, orderResponseSchema)).order;
  const full = await post(expiry, '/api/session', { username: 'qa.viewer', password });
  assert.equal(full.status, 503);
  await errorCode(full, 'SESSION_CAPACITY_REACHED');
  // Exercise real elapsed expiry of the native process, not startup synchronization or a retry.
  await waitForExpiry(1_100);
  const expired = await request(expiry, '/api/orders', { headers: authorization(original.token) });
  assert.equal(expired.status, 401);
  await errorCode(expired, 'UNAUTHORIZED');
  const replacement = await login(expiry, 'qa.user');
  assert(replacement.token !== original.token, 'Replacement sessions must issue distinct tokens.');
  const fresh = await request(expiry, '/api/orders', { headers: authorization(replacement.token) });
  assert.equal(fresh.status, 200);
  const freshOrders = (await parse(fresh, ordersResponseSchema)).orders;
  assert.equal(freshOrders.length, 5);
  assert(
    !freshOrders.some((order) => order.id === originalOrder.id),
    'Expired books must be released.',
  );
  await logout(expiry, replacement.token);
} finally {
  await stopApplication(expiry);
}

const limited = await startApplication({ TRADEFLOW_AUTH_PER_MINUTE: '2' });
try {
  const invalid = await post(limited, '/api/session', { username: 'qa.user', password: 'invalid' });
  assert.equal(invalid.status, 401);
  await errorCode(invalid, 'INVALID_CREDENTIALS');
  const malformed = await request(limited, '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.1' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  await errorCode(malformed, 'INVALID_JSON');
  for (const forwardedAddress of ['198.51.100.1', '203.0.113.1']) {
    const blocked = await request(limited, '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedAddress },
      body: JSON.stringify({ username: 'qa.user', password }),
    });
    assert.equal(blocked.status, 429, 'Forwarded headers must not bypass the global auth budget.');
    await errorCode(blocked, 'RATE_LIMITED');
    assert(
      /^[1-9]\d*$/.test(blocked.headers.get('retry-after') ?? ''),
      'Retry-After must be positive.',
    );
  }
} finally {
  await stopApplication(limited);
}

console.log(
  'Native production smoke passed: assets, wire behavior, limits, expiry, and log hygiene.',
);
if (process.platform === 'win32') {
  console.log(
    'Windows child termination is forced; graceful SIGTERM handling requires Linux verification.',
  );
} else {
  assert(activeDrainVerified, 'Linux must exercise shutdown with an unfinished request body.');
  console.log(
    'Native children handled SIGTERM and exited cleanly within the bounded shutdown window.',
  );
}
