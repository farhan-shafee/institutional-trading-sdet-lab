import {
  errorResponseSchema,
  orderResponseSchema,
  ordersResponseSchema,
  positionsResponseSchema,
  sessionResponseSchema,
} from '../../app/domain/schemas.js';
import { credentials, seedIds } from '../../test-data/fixtures/reference-data.js';
import { test, expect } from '../fixtures/tradeflow.fixture.js';

test('authorized order retrieval includes all seeded lifecycle states', async ({ apiClient }) => {
  const response = await apiClient.get('/api/orders');
  expect(response.status()).toBe(200);
  const { orders } = ordersResponseSchema.parse(await response.json());
  expect(orders).toHaveLength(5);
  expect(orders.map((order) => order.status).sort()).toEqual([
    'CANCELED',
    'FILLED',
    'NEW',
    'PARTIALLY_FILLED',
    'REJECTED',
  ]);
});

test('combined filters narrow orders by symbol, side and status', async ({ apiClient }) => {
  const response = await apiClient.get('/api/orders', {
    params: { symbol: 'AAPL', side: 'BUY', status: 'NEW' },
  });
  expect(response.status()).toBe(200);
  const { orders } = ordersResponseSchema.parse(await response.json());
  expect(orders).toHaveLength(1);
  expect(orders[0]).toMatchObject({
    id: seedIds.newOrder,
    symbol: 'AAPL',
    side: 'BUY',
    status: 'NEW',
  });
});

test('order detail returns the requested order', async ({ apiClient }) => {
  const response = await apiClient.get(`/api/orders/${seedIds.partialOrder}`);
  expect(response.status()).toBe(200);
  expect(orderResponseSchema.parse(await response.json()).order).toMatchObject({
    id: seedIds.partialOrder,
    symbol: 'MSFT',
    status: 'PARTIALLY_FILLED',
  });
});

test('submitting a market order persists its values and assigns a unique id', async ({
  apiClient,
  orderFactory,
}) => {
  const order = await orderFactory({ symbol: 'SPY', side: 'SELL', quantity: 27, type: 'MARKET' });
  expect(order).toMatchObject({
    symbol: 'SPY',
    side: 'SELL',
    quantity: 27,
    type: 'MARKET',
    status: 'NEW',
  });
  expect(order).not.toHaveProperty('limitPrice');
  expect(Object.values(seedIds)).not.toContain(order.id);
  const response = await apiClient.get(`/api/orders/${order.id}`);
  expect(response.status()).toBe(200);
  expect(orderResponseSchema.parse(await response.json()).order).toEqual(order);
});

test('a valid limit order retains its positive limit price', async ({ orderFactory }) => {
  const order = await orderFactory({
    symbol: 'NVDA',
    quantity: 1,
    type: 'LIMIT',
    limitPrice: 125.25,
  });
  expect(order).toMatchObject({
    symbol: 'NVDA',
    quantity: 1,
    type: 'LIMIT',
    limitPrice: 125.25,
    status: 'NEW',
  });
});

const invalidOrders = [
  { name: 'invalid symbol', data: { symbol: 'FAKE', side: 'BUY', quantity: 10, type: 'MARKET' } },
  { name: 'zero quantity', data: { symbol: 'AAPL', side: 'BUY', quantity: 0, type: 'MARKET' } },
  {
    name: 'negative quantity',
    data: { symbol: 'AAPL', side: 'BUY', quantity: -1, type: 'MARKET' },
  },
  {
    name: 'fractional quantity',
    data: { symbol: 'AAPL', side: 'BUY', quantity: 1.5, type: 'MARKET' },
  },
  {
    name: 'quantity above maximum',
    data: { symbol: 'AAPL', side: 'BUY', quantity: 1_000_001, type: 'MARKET' },
  },
  { name: 'missing quantity', data: { symbol: 'AAPL', side: 'BUY', type: 'MARKET' } },
  { name: 'invalid order type', data: { symbol: 'AAPL', side: 'BUY', quantity: 10, type: 'STOP' } },
  { name: 'invalid side', data: { symbol: 'AAPL', side: 'HOLD', quantity: 10, type: 'MARKET' } },
  {
    name: 'limit order without price',
    data: { symbol: 'AAPL', side: 'BUY', quantity: 10, type: 'LIMIT' },
  },
  {
    name: 'nonpositive limit price',
    data: { symbol: 'AAPL', side: 'BUY', quantity: 10, type: 'LIMIT', limitPrice: 0 },
  },
  {
    name: 'market order with price',
    data: { symbol: 'AAPL', side: 'BUY', quantity: 10, type: 'MARKET', limitPrice: 100 },
  },
] as const;

for (const scenario of invalidOrders) {
  test(`rejects ${scenario.name} without changing the order book`, async ({ apiClient }) => {
    const response = await apiClient.post('/api/orders', { data: scenario.data });
    expect(response.status()).toBe(400);
    const body = errorResponseSchema.parse(await response.json());
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).not.toBe('');
    const orders = await apiClient.get('/api/orders');
    expect(orders.status()).toBe(200);
    expect(ordersResponseSchema.parse(await orders.json()).orders).toHaveLength(5);
  });
}

test('malformed JSON is rejected with a structured error', async ({ apiClient }) => {
  const response = await apiClient.post('/api/orders', {
    headers: { 'Content-Type': 'application/json' },
    // Buffer preserves invalid bytes; Playwright JSON-serializes non-JSON strings.
    data: Buffer.from('{"symbol":'),
  });
  expect(response.status()).toBe(400);
  expect(errorResponseSchema.parse(await response.json()).error.code).toBe('INVALID_JSON');
});

test('invalid, unknown and duplicate filters are rejected', async ({ apiClient }) => {
  for (const query of [
    'symbol=FAKE',
    'side=HOLD',
    'status=DONE',
    'venue=synthetic',
    'symbol=AAPL&symbol=MSFT',
  ]) {
    const response = await apiClient.get(`/api/orders?${query}`);
    expect(response.status(), query).toBe(400);
    expect(errorResponseSchema.parse(await response.json()).error.code).toBe('VALIDATION_ERROR');
  }
});

test('request media and size boundaries return structured errors', async ({ apiClient }) => {
  const wrongMedia = await apiClient.post('/api/orders', {
    headers: { 'Content-Type': 'text/plain' },
    data: JSON.stringify({ symbol: 'AAPL', side: 'BUY', quantity: 10, type: 'MARKET' }),
  });
  expect(wrongMedia.status()).toBe(415);
  expect(errorResponseSchema.parse(await wrongMedia.json()).error.code).toBe(
    'UNSUPPORTED_MEDIA_TYPE',
  );
  const oversized = await apiClient.post('/api/orders', {
    data: {
      symbol: 'AAPL',
      side: 'BUY',
      quantity: 10,
      type: 'MARKET',
      padding: 'x'.repeat(20_000),
    },
  });
  expect(oversized.status()).toBe(413);
  expect(errorResponseSchema.parse(await oversized.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
  const book = await apiClient.get('/api/orders');
  expect(book.status()).toBe(200);
  expect(ordersResponseSchema.parse(await book.json()).orders).toHaveLength(5);
});

test('quantity upper boundary is accepted', async ({ orderFactory }) => {
  expect((await orderFactory({ quantity: 1_000_000 })).quantity).toBe(1_000_000);
});

for (const id of [seedIds.newOrder, seedIds.partialOrder]) {
  test(`cancels eligible ${id} and persists the transition`, async ({ apiClient }) => {
    const response = await apiClient.post(`/api/orders/${id}/cancel`);
    expect(response.status()).toBe(200);
    expect(orderResponseSchema.parse(await response.json()).order.status).toBe('CANCELED');
    const detail = await apiClient.get(`/api/orders/${id}`);
    expect(detail.status()).toBe(200);
    expect(orderResponseSchema.parse(await detail.json()).order.status).toBe('CANCELED');
  });
}

for (const id of [seedIds.filledOrder, seedIds.canceledOrder, seedIds.rejectedOrder]) {
  test(`rejects cancellation of terminal order ${id}`, async ({ apiClient }) => {
    const before = await apiClient.get(`/api/orders/${id}`);
    expect(before.status()).toBe(200);
    const original = orderResponseSchema.parse(await before.json()).order;
    const response = await apiClient.post(`/api/orders/${id}/cancel`);
    expect(response.status()).toBe(409);
    expect(errorResponseSchema.parse(await response.json()).error.code).toBe(
      'ORDER_NOT_CANCELABLE',
    );
    const after = await apiClient.get(`/api/orders/${id}`);
    expect(after.status()).toBe(200);
    expect(orderResponseSchema.parse(await after.json()).order).toEqual(original);
  });
}

test('canceling twice returns conflict on the second request', async ({
  apiClient,
  orderFactory,
}) => {
  const { id } = await orderFactory();
  expect((await apiClient.post(`/api/orders/${id}/cancel`)).status()).toBe(200);
  const repeated = await apiClient.post(`/api/orders/${id}/cancel`);
  expect(repeated.status()).toBe(409);
  expect(errorResponseSchema.parse(await repeated.json()).error.code).toBe('ORDER_NOT_CANCELABLE');
});

for (const method of ['get', 'post'] as const) {
  test(`${method} of an unknown order returns 404`, async ({ apiClient }) => {
    const endpoint = `/api/orders/unknown-synthetic-id${method === 'post' ? '/cancel' : ''}`;
    const response = await apiClient[method](endpoint);
    expect(response.status()).toBe(404);
    expect(errorResponseSchema.parse(await response.json()).error.code).toBe('ORDER_NOT_FOUND');
  });
}

test('positions expose a typed synthetic read model', async ({ apiClient }) => {
  const response = await apiClient.get('/api/positions');
  expect(response.status()).toBe(200);
  const { positions } = positionsResponseSchema.parse(await response.json());
  expect(positions.length).toBeGreaterThan(0);
  expect(positions.map((position) => position.symbol)).toEqual(
    expect.arrayContaining(['AAPL', 'MSFT']),
  );
});

test('separate sessions cannot see or mutate each other’s generated orders', async ({
  apiClient,
  orderFactory,
  request,
}) => {
  const created = await orderFactory({ symbol: 'SPY', quantity: 321 });
  const login = await request.post('/api/session', { data: credentials.trader });
  expect(login.status()).toBe(200);
  const { token } = sessionResponseSchema.parse(await login.json());
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const foreignRead = await request.get(`/api/orders/${created.id}`, { headers });
    expect(foreignRead.status()).toBe(404);
    expect(errorResponseSchema.parse(await foreignRead.json()).error.code).toBe('ORDER_NOT_FOUND');
    const foreignCancel = await request.post(`/api/orders/${created.id}/cancel`, { headers });
    expect(foreignCancel.status()).toBe(404);
    expect(errorResponseSchema.parse(await foreignCancel.json()).error.code).toBe(
      'ORDER_NOT_FOUND',
    );
    const foreignBook = await request.get('/api/orders', { headers });
    expect(foreignBook.status()).toBe(200);
    expect(ordersResponseSchema.parse(await foreignBook.json()).orders).toHaveLength(5);
    const own = await apiClient.get(`/api/orders/${created.id}`);
    expect(own.status()).toBe(200);
    expect(orderResponseSchema.parse(await own.json()).order.status).toBe('NEW');
  } finally {
    expect((await request.delete('/api/session', { headers })).status()).toBe(204);
  }
});

test('canceling a shared seed identifier changes only the owning session book', async ({
  apiClient,
  request,
}) => {
  const login = await request.post('/api/session', { data: credentials.trader });
  expect(login.status()).toBe(200);
  const { token } = sessionResponseSchema.parse(await login.json());
  const headers = { Authorization: `Bearer ${token}` };
  try {
    expect((await apiClient.post(`/api/orders/${seedIds.newOrder}/cancel`)).status()).toBe(200);
    const own = await apiClient.get(`/api/orders/${seedIds.newOrder}`);
    expect(own.status()).toBe(200);
    expect(orderResponseSchema.parse(await own.json()).order.status).toBe('CANCELED');
    const independent = await request.get(`/api/orders/${seedIds.newOrder}`, { headers });
    expect(independent.status()).toBe(200);
    expect(orderResponseSchema.parse(await independent.json()).order.status).toBe('NEW');
  } finally {
    expect((await request.delete('/api/session', { headers })).status()).toBe(204);
  }
});
