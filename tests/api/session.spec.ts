import {
  sessionResponseSchema,
  errorResponseSchema,
  ordersResponseSchema,
  orderResponseSchema,
} from '../../app/domain/schemas.js';
import { credentials } from '../../test-data/fixtures/reference-data.js';
import { test, expect } from '../fixtures/tradeflow.fixture.js';

test('successful authentication creates a synthetic trader session', async ({ request }) => {
  const response = await request.post('/api/session', { data: credentials.trader });
  expect(response.status()).toBe(200);
  const session = sessionResponseSchema.parse(await response.json());
  try {
    expect(session.token).not.toBe('');
    expect(session.user).toEqual({ username: 'qa.user', role: 'trader' });
    const orders = await request.get('/api/orders', {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    expect(orders.status()).toBe(200);
  } finally {
    const cleanup = await request.delete('/api/session', {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    expect(cleanup.status()).toBe(204);
  }
});

test('authentication rejects an incorrect password', async ({ request }) => {
  const response = await request.post('/api/session', {
    data: { username: 'qa.user', password: 'wrong-password' },
  });
  expect(response.status()).toBe(401);
  const body = errorResponseSchema.parse(await response.json());
  expect(body.error.code).toBe('INVALID_CREDENTIALS');
  expect(body.error.message).not.toBe('');
});

test('authentication validates missing credentials', async ({ request }) => {
  const response = await request.post('/api/session', { data: { username: 'qa.user' } });
  expect(response.status()).toBe(400);
  expect(errorResponseSchema.parse(await response.json()).error.code).toBe('VALIDATION_ERROR');
});

for (const token of [undefined, 'invalid-synthetic-token']) {
  test(`protected endpoints reject ${token === undefined ? 'missing' : 'invalid'} bearer token`, async ({
    request,
  }) => {
    const headers = token === undefined ? {} : { Authorization: `Bearer ${token}` };
    const routes = [
      { method: 'get', path: '/api/orders' },
      { method: 'get', path: '/api/orders/seed-new-aapl' },
      { method: 'get', path: '/api/positions' },
      { method: 'get', path: '/api/session' },
      { method: 'post', path: '/api/orders' },
      { method: 'post', path: '/api/orders/seed-new-aapl/cancel' },
      { method: 'delete', path: '/api/session' },
    ] as const;
    for (const route of routes) {
      const response = await request[route.method](route.path, {
        headers,
        ...(route.method === 'post' && route.path === '/api/orders'
          ? { data: { symbol: 'AAPL', side: 'BUY', quantity: 10, type: 'MARKET' } }
          : {}),
      });
      expect(response.status(), `${route.method.toUpperCase()} ${route.path}`).toBe(401);
      expect(errorResponseSchema.parse(await response.json()).error.code).toBe('UNAUTHORIZED');
    }
  });
}

test('sign out revokes the token and denies subsequent access', async ({ request }) => {
  const login = await request.post('/api/session', { data: credentials.trader });
  expect(login.status()).toBe(200);
  const { token } = sessionResponseSchema.parse(await login.json());
  const headers = { Authorization: `Bearer ${token}` };
  try {
    expect((await request.delete('/api/session', { headers })).status()).toBe(204);
    const response = await request.get('/api/orders', { headers });
    expect(response.status()).toBe(401);
    expect(errorResponseSchema.parse(await response.json()).error.code).toBe('UNAUTHORIZED');
  } finally {
    // A revoked token is already released; repeated deletion must reject it.
    expect((await request.delete('/api/session', { headers })).status()).toBe(401);
  }
});

test('a viewer can read orders but cannot submit or cancel', async ({ request }) => {
  const login = await request.post('/api/session', { data: credentials.viewer });
  expect(login.status()).toBe(200);
  const session = sessionResponseSchema.parse(await login.json());
  const headers = { Authorization: `Bearer ${session.token}` };
  try {
    expect(session.user.role).toBe('viewer');
    expect((await request.get('/api/orders', { headers })).status()).toBe(200);
    for (const endpoint of ['/api/orders', '/api/orders/seed-new-aapl/cancel']) {
      const response = await request.post(endpoint, {
        headers,
        data: { symbol: 'AAPL', side: 'BUY', quantity: 10, type: 'MARKET' },
      });
      expect(response.status()).toBe(403);
      expect(errorResponseSchema.parse(await response.json()).error.code).toBe('FORBIDDEN');
    }
    const book = await request.get('/api/orders', { headers });
    expect(book.status()).toBe(200);
    expect(ordersResponseSchema.parse(await book.json()).orders).toHaveLength(5);
    const unchanged = await request.get('/api/orders/seed-new-aapl', { headers });
    expect(unchanged.status()).toBe(200);
    expect(orderResponseSchema.parse(await unchanged.json()).order.status).toBe('NEW');
  } finally {
    expect((await request.delete('/api/session', { headers })).status()).toBe(204);
  }
});
