import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from 'node:http';
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  errorResponseSchema,
  orderResponseSchema,
  ordersResponseSchema,
  sessionResponseSchema,
} from '../../app/domain/schemas.js';
import { readConfiguration } from '../../app/server/configuration.js';
import { createApplicationServer } from '../../app/server/index.js';
import { credentials, seedIds } from '../../test-data/fixtures/reference-data.js';
import { OpenApiContracts } from '../contract/openapi-validator.js';

const orderInput = { symbol: 'SPY', side: 'BUY', quantity: 7, type: 'MARKET' } as const;
type RequestFactory = {
  request: { newContext(options: { baseURL: string }): Promise<APIRequestContext> };
};

async function hostedServer(playwright: RequestFactory, settings: Record<string, string> = {}) {
  let fakeMs = 0;
  const server = createApplicationServer({
    configuration: readConfiguration({
      TRADEFLOW_MODE: 'hosted-demo',
      TRADEFLOW_HOST: '127.0.0.1',
      PORT: '3000',
      ...settings,
    }),
    now: () => fakeMs,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const closeServer = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer();
    throw new Error('The owned hosted-demo server must have an ephemeral TCP address.');
  }
  const origin = `http://127.0.0.1:${address.port}`;
  let request: APIRequestContext;
  try {
    request = await playwright.request.newContext({ baseURL: origin });
  } catch (error) {
    await closeServer();
    throw error;
  }
  return {
    server,
    origin,
    request,
    setTime(milliseconds: number) {
      fakeMs = milliseconds;
    },
    async close() {
      try {
        await request.dispose();
      } finally {
        await closeServer();
      }
    },
  };
}

type HostedServer = Awaited<ReturnType<typeof hostedServer>>;
type WireResponse = { status: number; headers: IncomingHttpHeaders; text: string };

/** The later request listener runs after the route reaches its body-read await. */
function pendingBody(lab: HostedServer, headers: Record<string, string> = {}) {
  let outgoing: ClientRequest;
  let markReceived: () => void = () => undefined;
  const received = new Promise<void>((resolve) => {
    markReceived = resolve;
  });
  const onRequest = () => markReceived();
  lab.server.once('request', onRequest);
  const response = new Promise<WireResponse>((resolve, reject) => {
    outgoing = httpRequest(
      new URL('/api/orders', lab.origin),
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.once('error', reject);
        incoming.once('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.once('error', (error) => {
      lab.server.off('request', onRequest);
      reject(error);
    });
    outgoing.flushHeaders();
  });
  return { request: outgoing!, received, response };
}

test('session capacity preserves live books and reclaims absolute expiry and logout', async ({
  playwright,
}) => {
  const lab = await hostedServer(playwright, {
    TRADEFLOW_MAX_SESSIONS: '1',
    TRADEFLOW_SESSION_TTL_SECONDS: '2',
  });
  try {
    const contracts = await OpenApiContracts.load(lab.request);
    const login = await lab.request.post('/api/session', { data: credentials.trader });
    expect(login.status()).toBe(200);
    const first = sessionResponseSchema.parse(await login.json());
    const headers = { Authorization: `Bearer ${first.token}` };
    const created = await lab.request.post('/api/orders', { headers, data: orderInput });
    expect(created.status()).toBe(201);
    const ownedOrder = orderResponseSchema.parse(await created.json()).order;
    const canceled = await lab.request.post(`/api/orders/${seedIds.newOrder}/cancel`, {
      headers,
    });
    expect(canceled.status()).toBe(200);
    expect(orderResponseSchema.parse(await canceled.json()).order.status).toBe('CANCELED');

    const full = await lab.request.post('/api/session', { data: credentials.trader });
    expect(full.status()).toBe(503);
    const fullBody: unknown = await full.json();
    const validateFull = contracts.response('post', '/api/session', 503);
    expect(validateFull(fullBody), JSON.stringify(validateFull.errors)).toBe(true);
    expect(errorResponseSchema.parse(fullBody).error.code).toBe('SESSION_CAPACITY_REACHED');
    expect(full.headers()['retry-after']).toBeUndefined();

    lab.setTime(1_999);
    const stillLive = await lab.request.get(`/api/orders/${ownedOrder.id}`, { headers });
    expect(stillLive.status()).toBe(200);
    expect(orderResponseSchema.parse(await stillLive.json()).order).toEqual(ownedOrder);
    lab.setTime(2_000);
    const expired = await lab.request.get('/api/session', { headers });
    expect(expired.status()).toBe(401);
    const expiredBody: unknown = await expired.json();
    const validateExpired = contracts.response('get', '/api/session', 401);
    expect(validateExpired(expiredBody), JSON.stringify(validateExpired.errors)).toBe(true);
    expect(errorResponseSchema.parse(expiredBody).error.code).toBe('UNAUTHORIZED');

    const replacementLogin = await lab.request.post('/api/session', { data: credentials.trader });
    expect(replacementLogin.status()).toBe(200);
    const replacement = sessionResponseSchema.parse(await replacementLogin.json());
    expect(replacement.token).not.toBe(first.token);
    const replacementHeaders = { Authorization: `Bearer ${replacement.token}` };
    const fresh = await lab.request.get('/api/orders', { headers: replacementHeaders });
    expect(fresh.status()).toBe(200);
    const freshBook = ordersResponseSchema.parse(await fresh.json()).orders;
    expect(freshBook).toHaveLength(5);
    expect(freshBook.find((order) => order.id === seedIds.newOrder)?.status).toBe('NEW');
    expect(freshBook.map((order) => order.id)).not.toContain(ownedOrder.id);
    const foreign = await lab.request.get(`/api/orders/${ownedOrder.id}`, {
      headers: replacementHeaders,
    });
    expect(foreign.status()).toBe(404);
    expect(errorResponseSchema.parse(await foreign.json()).error.code).toBe('ORDER_NOT_FOUND');
    const logout = await lab.request.delete('/api/session', { headers: replacementHeaders });
    expect(logout.status()).toBe(204);
    expect(await logout.text()).toBe('');
    const afterLogout = await lab.request.post('/api/session', { data: credentials.trader });
    expect(afterLogout.status()).toBe(200);
    expect(sessionResponseSchema.parse(await afterLogout.json()).token).not.toBe(replacement.token);
  } finally {
    await lab.close();
  }
});

test('order capacity includes seeds and preserves validation, authorization and cancellation', async ({
  playwright,
}) => {
  const lab = await hostedServer(playwright, { TRADEFLOW_MAX_ORDERS_PER_SESSION: '6' });
  try {
    const contracts = await OpenApiContracts.load(lab.request);
    const login = await lab.request.post('/api/session', { data: credentials.trader });
    expect(login.status()).toBe(200);
    const session = sessionResponseSchema.parse(await login.json());
    const headers = { Authorization: `Bearer ${session.token}` };
    const created = await lab.request.post('/api/orders', { headers, data: orderInput });
    expect(created.status()).toBe(201);
    const ownedOrder = orderResponseSchema.parse(await created.json()).order;
    const before = await lab.request.get('/api/orders', { headers });
    expect(before.status()).toBe(200);
    const fullBook = ordersResponseSchema.parse(await before.json()).orders;
    expect(fullBook).toHaveLength(6);

    const invalid = await lab.request.post('/api/orders', {
      headers,
      data: { ...orderInput, quantity: 0 },
    });
    expect(invalid.status()).toBe(400);
    expect(errorResponseSchema.parse(await invalid.json()).error.code).toBe('VALIDATION_ERROR');
    const full = await lab.request.post('/api/orders', { headers, data: orderInput });
    expect(full.status()).toBe(409);
    const fullBody: unknown = await full.json();
    const validateFull = contracts.response('post', '/api/orders', 409);
    expect(validateFull(fullBody), JSON.stringify(validateFull.errors)).toBe(true);
    expect(errorResponseSchema.parse(fullBody).error.code).toBe('ORDER_CAPACITY_REACHED');
    expect(full.headers()['retry-after']).toBeUndefined();
    const unchanged = await lab.request.get('/api/orders', { headers });
    expect(unchanged.status()).toBe(200);
    expect(ordersResponseSchema.parse(await unchanged.json()).orders).toEqual(fullBook);

    const cancellation = await lab.request.post(`/api/orders/${ownedOrder.id}/cancel`, {
      headers,
    });
    expect(cancellation.status()).toBe(200);
    const canceled = orderResponseSchema.parse(await cancellation.json()).order;
    expect(canceled).toEqual({ ...ownedOrder, status: 'CANCELED' });
    const stillFull = await lab.request.post('/api/orders', { headers, data: orderInput });
    expect(stillFull.status()).toBe(409);
    expect(errorResponseSchema.parse(await stillFull.json()).error.code).toBe(
      'ORDER_CAPACITY_REACHED',
    );
    const retained = await lab.request.get('/api/orders', { headers });
    expect(retained.status()).toBe(200);
    expect(ordersResponseSchema.parse(await retained.json()).orders).toEqual(
      fullBook.map((order) => (order.id === ownedOrder.id ? canceled : order)),
    );

    const viewerLogin = await lab.request.post('/api/session', { data: credentials.viewer });
    expect(viewerLogin.status()).toBe(200);
    const viewer = sessionResponseSchema.parse(await viewerLogin.json());
    const viewerHeaders = { Authorization: `Bearer ${viewer.token}` };
    const forbidden = await lab.request.post('/api/orders', {
      headers: viewerHeaders,
      data: orderInput,
    });
    expect(forbidden.status()).toBe(403);
    expect(errorResponseSchema.parse(await forbidden.json()).error.code).toBe('FORBIDDEN');
    const missing = await lab.request.post('/api/orders', { data: orderInput });
    expect(missing.status()).toBe(401);
    expect(errorResponseSchema.parse(await missing.json()).error.code).toBe('UNAUTHORIZED');
    const viewerBook = await lab.request.get('/api/orders', { headers: viewerHeaders });
    expect(viewerBook.status()).toBe(200);
    const viewerOrders = ordersResponseSchema.parse(await viewerBook.json()).orders;
    expect(viewerOrders).toHaveLength(5);
    expect(viewerOrders.map((order) => order.id)).not.toContain(ownedOrder.id);
    expect(viewerOrders.find((order) => order.id === seedIds.newOrder)?.status).toBe('NEW');
  } finally {
    await lab.close();
  }
});

test('authentication admission counts invalid work before JSON and ignores spoofed forwarding headers', async ({
  playwright,
}) => {
  const lab = await hostedServer(playwright, { TRADEFLOW_AUTH_PER_MINUTE: '3' });
  try {
    const contracts = await OpenApiContracts.load(lab.request);
    const invalid = await lab.request.post('/api/session', {
      data: { username: 'qa.user', password: 'wrong-synthetic-password' },
    });
    expect(invalid.status()).toBe(401);
    expect(errorResponseSchema.parse(await invalid.json()).error.code).toBe('INVALID_CREDENTIALS');
    const malformed = await lab.request.post('/api/session', {
      headers: { 'Content-Type': 'application/json' },
      data: Buffer.from('{"username":'),
    });
    expect(malformed.status()).toBe(400);
    expect(errorResponseSchema.parse(await malformed.json()).error.code).toBe('INVALID_JSON');
    const accepted = await lab.request.post('/api/session', { data: credentials.trader });
    expect(accepted.status()).toBe(200);
    expect(sessionResponseSchema.parse(await accepted.json()).user.role).toBe('trader');

    for (const forwarded of ['203.0.113.10', '198.51.100.20']) {
      const denied = await lab.request.post('/api/session', {
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwarded },
        data: Buffer.from('not JSON'),
      });
      expect(denied.status()).toBe(429);
      const body: unknown = await denied.json();
      const validate = contracts.response('post', '/api/session', 429);
      expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
      expect(errorResponseSchema.parse(body).error.code).toBe('RATE_LIMITED');
      expect(denied.headers()['retry-after']).toMatch(/^[1-9]\d*$/);
      expect(Number(denied.headers()['retry-after'])).toBe(60);
    }
    lab.setTime(59_999);
    const beforeReset = await lab.request.post('/api/session', { data: credentials.trader });
    expect(beforeReset.status()).toBe(429);
    expect(errorResponseSchema.parse(await beforeReset.json()).error.code).toBe('RATE_LIMITED');
    expect(beforeReset.headers()['retry-after']).toBe('1');
    lab.setTime(60_000);
    const recovered = await lab.request.post('/api/session', { data: credentials.trader });
    expect(recovered.status()).toBe(200);
    expect(sessionResponseSchema.parse(await recovered.json()).user.role).toBe('trader');
  } finally {
    await lab.close();
  }
});

test('mutation admission isolates session budgets, bounds aggregate work and recovers at the minute', async ({
  playwright,
}) => {
  const lab = await hostedServer(playwright, {
    TRADEFLOW_MUTATIONS_PER_MINUTE: '3',
    TRADEFLOW_SESSION_MUTATIONS_PER_MINUTE: '1',
  });
  try {
    const contracts = await OpenApiContracts.load(lab.request);
    const sessions = [];
    for (let index = 0; index < 4; index += 1) {
      const login = await lab.request.post('/api/session', { data: credentials.trader });
      expect(login.status()).toBe(200);
      sessions.push(sessionResponseSchema.parse(await login.json()));
    }
    const [first, second, third, fourth] = sessions;
    if (!first || !second || !third || !fourth)
      throw new Error('Four owned sessions are required.');
    const firstHeaders = { Authorization: `Bearer ${first.token}` };
    const secondHeaders = { Authorization: `Bearer ${second.token}` };
    const fourthHeaders = { Authorization: `Bearer ${fourth.token}` };
    const created = await lab.request.post('/api/orders', {
      headers: firstHeaders,
      data: orderInput,
    });
    expect(created.status()).toBe(201);
    const firstOrder = orderResponseSchema.parse(await created.json()).order;
    const sessionDenied = await lab.request.post('/api/orders', {
      headers: firstHeaders,
      data: orderInput,
    });
    expect(sessionDenied.status()).toBe(429);
    const sessionDeniedBody: unknown = await sessionDenied.json();
    const validateRate = contracts.response('post', '/api/orders', 429);
    expect(validateRate(sessionDeniedBody), JSON.stringify(validateRate.errors)).toBe(true);
    expect(errorResponseSchema.parse(sessionDeniedBody).error.code).toBe('RATE_LIMITED');
    expect(sessionDenied.headers()['retry-after']).toBe('60');
    const independent = await lab.request.post('/api/orders', {
      headers: secondHeaders,
      data: orderInput,
    });
    expect(independent.status()).toBe(201);
    const secondOrder = orderResponseSchema.parse(await independent.json()).order;
    expect(secondOrder.id).not.toBe(firstOrder.id);
    const firstBook = await lab.request.get('/api/orders', { headers: firstHeaders });
    expect(firstBook.status()).toBe(200);
    const firstOrders = ordersResponseSchema.parse(await firstBook.json()).orders;
    expect(firstOrders).toHaveLength(6);
    expect(firstOrders.map((order) => order.id)).toContain(firstOrder.id);
    expect(firstOrders.map((order) => order.id)).not.toContain(secondOrder.id);

    lab.setTime(60_000);
    for (const session of [first, second, third]) {
      const recovered = await lab.request.post('/api/orders', {
        headers: { Authorization: `Bearer ${session.token}` },
        data: orderInput,
      });
      expect(recovered.status()).toBe(201);
      expect(orderResponseSchema.parse(await recovered.json()).order.status).toBe('NEW');
    }
    const aggregateDenied = await lab.request.post('/api/orders', {
      headers: fourthHeaders,
      data: orderInput,
    });
    expect(aggregateDenied.status()).toBe(429);
    const aggregateBody: unknown = await aggregateDenied.json();
    expect(validateRate(aggregateBody), JSON.stringify(validateRate.errors)).toBe(true);
    expect(errorResponseSchema.parse(aggregateBody).error.code).toBe('RATE_LIMITED');
    expect(aggregateDenied.headers()['retry-after']).toMatch(/^[1-9]\d*$/);
    const untouched = await lab.request.get('/api/orders', { headers: fourthHeaders });
    expect(untouched.status()).toBe(200);
    expect(ordersResponseSchema.parse(await untouched.json()).orders).toHaveLength(5);
    const logout = await lab.request.delete('/api/session', { headers: firstHeaders });
    expect(logout.status()).toBe(204);
    expect(await logout.text()).toBe('');
    lab.setTime(119_999);
    const beforeReset = await lab.request.post('/api/orders', {
      headers: fourthHeaders,
      data: orderInput,
    });
    expect(beforeReset.status()).toBe(429);
    expect(errorResponseSchema.parse(await beforeReset.json()).error.code).toBe('RATE_LIMITED');
    expect(beforeReset.headers()['retry-after']).toBe('1');
    lab.setTime(120_000);
    const recovered = await lab.request.post('/api/orders', {
      headers: fourthHeaders,
      data: orderInput,
    });
    expect(recovered.status()).toBe(201);
    expect(orderResponseSchema.parse(await recovered.json()).order.status).toBe('NEW');
  } finally {
    await lab.close();
  }
});

test('global request admission protects static routes while health and logout remain available', async ({
  playwright,
}) => {
  const lab = await hostedServer(playwright, {
    TRADEFLOW_REQUESTS_PER_MINUTE: '6',
    TRADEFLOW_MAX_SESSIONS: '1',
  });
  try {
    const malformed = await new Promise<WireResponse>((resolve, reject) => {
      const outgoing = httpRequest(`${lab.origin}/`, { path: '//', method: 'GET' }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.once('error', reject);
        incoming.once('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
      outgoing.once('error', reject);
      outgoing.end();
    });
    expect(malformed.status).toBe(400);
    expect(errorResponseSchema.parse(JSON.parse(malformed.text) as unknown).error.code).toBe(
      'VALIDATION_ERROR',
    );
    // Malformed targets and specification retrieval consume the first two global request slots.
    const contracts = await OpenApiContracts.load(lab.request);
    const html = await lab.request.get('/');
    expect(html.status()).toBe(200);
    expect(html.headers()['content-type']).toContain('text/html');
    const disclosure = await html.text();
    expect(disclosure).toMatch(/hosted.demo/i);
    expect(disclosure).toMatch(/synthetic/i);
    expect(disclosure).toMatch(/expir/i);
    expect(disclosure).toMatch(/restart/i);
    expect(disclosure).toMatch(/limit/i);
    expect(disclosure).not.toMatch(/SYNTHETIC \/ LOCAL|local only/i);
    const login = await lab.request.post('/api/session', { data: credentials.trader });
    expect(login.status()).toBe(200);
    const session = sessionResponseSchema.parse(await login.json());
    const headers = { Authorization: `Bearer ${session.token}` };
    const capacity = await lab.request.post('/api/session', { data: credentials.trader });
    expect(capacity.status()).toBe(503);
    expect(errorResponseSchema.parse(await capacity.json()).error.code).toBe(
      'SESSION_CAPACITY_REACHED',
    );
    expect(capacity.headers()['retry-after']).toBeUndefined();
    const book = await lab.request.get('/api/orders', { headers });
    expect(book.status()).toBe(200);
    expect(ordersResponseSchema.parse(await book.json()).orders).toHaveLength(5);

    const denied = await lab.request.get('/openapi.yaml?probe=untrusted-request-marker');
    expect(denied.status()).toBe(429);
    expect(denied.headers()['content-type']).toContain('application/json');
    const deniedBody: unknown = await denied.json();
    const validateRate = contracts.response('get', '/openapi.yaml', 429);
    expect(validateRate(deniedBody), JSON.stringify(validateRate.errors)).toBe(true);
    const safeError = errorResponseSchema.parse(deniedBody);
    expect(safeError.error.code).toBe('RATE_LIMITED');
    expect(JSON.stringify(safeError)).not.toContain('untrusted-request-marker');
    expect(JSON.stringify(safeError)).not.toContain(session.token);
    expect(denied.headers()['retry-after']).toMatch(/^[1-9]\d*$/);
    const otherDenied = await lab.request.get('/api/orders?probe=another-untrusted-marker', {
      headers,
    });
    expect(otherDenied.status()).toBe(429);
    expect(errorResponseSchema.parse(await otherDenied.json())).toEqual(safeError);
    const health = await lab.request.get('/health');
    expect(health.status()).toBe(200);
    const healthBody: unknown = await health.json();
    const validateHealth = contracts.response('get', '/health', 200);
    expect(validateHealth(healthBody), JSON.stringify(validateHealth.errors)).toBe(true);
    expect(healthBody).toEqual({ status: 'ok', service: 'TradeFlow Lab', synthetic: true });
    const logout = await lab.request.delete('/api/session', { headers });
    expect(logout.status()).toBe(204);
    expect(await logout.text()).toBe('');
    expect(logout.headers()['retry-after']).toBeUndefined();
    const revoked = await lab.request.delete('/api/session', { headers });
    expect(revoked.status()).toBe(401);
    expect(errorResponseSchema.parse(await revoked.json()).error.code).toBe('UNAUTHORIZED');
    lab.setTime(60_000);
    const recovered = await lab.request.get('/openapi.yaml');
    expect(recovered.status()).toBe(200);
    expect(recovered.headers()['content-type']).toContain('application/yaml');
  } finally {
    await lab.close();
  }
});

test('streamed bodies close on early rejection and cannot mutate after expiry or revocation', async ({
  playwright,
}) => {
  const lab = await hostedServer(playwright, { TRADEFLOW_SESSION_TTL_SECONDS: '1' });
  const rawRequests: ClientRequest[] = [];
  try {
    const contracts = await OpenApiContracts.load(lab.request);
    const login = await lab.request.post('/api/session', { data: credentials.trader });
    expect(login.status()).toBe(200);
    const session = sessionResponseSchema.parse(await login.json());
    const headers = { Authorization: `Bearer ${session.token}` };
    const oversized = pendingBody(lab, headers);
    rawRequests.push(oversized.request);
    await oversized.received;
    // No Content-Length and no end(): the server must reject a chunked overflow itself.
    oversized.request.write(Buffer.from('x'.repeat(16_385)));
    const tooLarge = await oversized.response;
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers.connection).toBe('close');
    const tooLargeBody: unknown = JSON.parse(tooLarge.text);
    const validateSize = contracts.response('post', '/api/orders', 413);
    expect(validateSize(tooLargeBody), JSON.stringify(validateSize.errors)).toBe(true);
    expect(errorResponseSchema.parse(tooLargeBody).error.code).toBe('PAYLOAD_TOO_LARGE');

    const unread = pendingBody(lab);
    rawRequests.push(unread.request);
    await unread.received;
    // Do not send or finish the unauthorized body; denial must not await or drain it.
    const unauthorized = await unread.response;
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.connection).toBe('close');
    const unauthorizedBody: unknown = JSON.parse(unauthorized.text);
    const validateUnauthorized = contracts.response('post', '/api/orders', 401);
    expect(
      validateUnauthorized(unauthorizedBody),
      JSON.stringify(validateUnauthorized.errors),
    ).toBe(true);
    expect(errorResponseSchema.parse(unauthorizedBody).error.code).toBe('UNAUTHORIZED');

    const expiring = pendingBody(lab, headers);
    rawRequests.push(expiring.request);
    await expiring.received;
    lab.setTime(1_000);
    expiring.request.end(JSON.stringify(orderInput));
    const expired = await expiring.response;
    expect(expired.status).toBe(401);
    const expiredBody: unknown = JSON.parse(expired.text);
    expect(validateUnauthorized(expiredBody), JSON.stringify(validateUnauthorized.errors)).toBe(
      true,
    );
    expect(errorResponseSchema.parse(expiredBody).error.code).toBe('UNAUTHORIZED');

    const replacementLogin = await lab.request.post('/api/session', { data: credentials.trader });
    expect(replacementLogin.status()).toBe(200);
    const replacement = sessionResponseSchema.parse(await replacementLogin.json());
    const replacementHeaders = { Authorization: `Bearer ${replacement.token}` };
    const revoking = pendingBody(lab, replacementHeaders);
    rawRequests.push(revoking.request);
    await revoking.received;
    const logout = await lab.request.delete('/api/session', { headers: replacementHeaders });
    expect(logout.status()).toBe(204);
    revoking.request.end(JSON.stringify(orderInput));
    const revoked = await revoking.response;
    expect(revoked.status).toBe(401);
    const revokedBody: unknown = JSON.parse(revoked.text);
    expect(validateUnauthorized(revokedBody), JSON.stringify(validateUnauthorized.errors)).toBe(
      true,
    );
    expect(errorResponseSchema.parse(revokedBody).error.code).toBe('UNAUTHORIZED');
  } finally {
    for (const raw of rawRequests) raw.destroy();
    await lab.close();
  }
});
