import { test as baseTest } from '@playwright/test';
import {
  errorResponseSchema,
  orderResponseSchema,
  ordersResponseSchema,
  positionsResponseSchema,
  sessionResponseSchema,
} from '../../app/domain/schemas.js';
import { credentials, seedIds } from '../../test-data/fixtures/reference-data.js';
import { test, expect } from '../fixtures/tradeflow.fixture.js';
import { OpenApiContracts } from './openapi-validator.js';

baseTest('health publishes the expected synthetic environment contract', async ({ request }) => {
  const contracts = await OpenApiContracts.load(request);
  const response = await request.get('/health');
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  const validate = contracts.response('get', '/health', 200);
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(body).toEqual({ status: 'ok', service: 'TradeFlow Lab', synthetic: true });
});

test('session restore returns its user without replacing the order book', async ({
  apiClient,
  orderFactory,
}) => {
  const contracts = await OpenApiContracts.load(apiClient);
  const order = await orderFactory();
  const response = await apiClient.get('/api/session');
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  const validate = contracts.response('get', '/api/session', 200);
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(sessionResponseSchema.pick({ user: true }).strict().parse(body)).toEqual({
    user: { username: 'qa.user', role: 'trader' },
  });
  const retained = await apiClient.get(`/api/orders/${order.id}`);
  expect(retained.status()).toBe(200);
  expect(orderResponseSchema.parse(await retained.json()).order.id).toBe(order.id);
});

baseTest('session deletion satisfies its documented empty 204 response', async ({ request }) => {
  const contracts = await OpenApiContracts.load(request);
  expect(contracts.noContentResponse('delete', '/api/session', 204)).toBe(true);
  const login = await request.post('/api/session', { data: credentials.trader });
  expect(login.status()).toBe(200);
  const { token } = sessionResponseSchema.parse(await login.json());
  const headers = { Authorization: `Bearer ${token}` };
  let released = false;
  try {
    const response = await request.delete('/api/session', { headers });
    released = response.status() === 204;
    expect(response.status()).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers()['content-type']).toBeUndefined();
  } finally {
    if (!released) expect((await request.delete('/api/session', { headers })).status()).toBe(204);
  }
});

test('the live order list satisfies OpenAPI and runtime schemas', async ({ apiClient }) => {
  const contracts = await OpenApiContracts.load(apiClient);
  const response = await apiClient.get('/api/orders');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  const body: unknown = await response.json();
  const validate = contracts.response('get', '/api/orders', 200);
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(ordersResponseSchema.safeParse(body).success).toBe(true);
});

test('order creation, detail and cancellation satisfy their published contracts', async ({
  apiClient,
}) => {
  const contracts = await OpenApiContracts.load(apiClient);
  const created = await apiClient.post('/api/orders', {
    data: { symbol: 'NVDA', side: 'BUY', quantity: 7, type: 'LIMIT', limitPrice: 120.5 },
  });
  expect(created.status()).toBe(201);
  const createdBody: unknown = await created.json();
  const validateCreated = contracts.response('post', '/api/orders', 201);
  expect(validateCreated(createdBody), JSON.stringify(validateCreated.errors)).toBe(true);
  const { order } = orderResponseSchema.parse(createdBody);
  const detail = await apiClient.get(`/api/orders/${order.id}`);
  expect(detail.status()).toBe(200);
  const detailBody: unknown = await detail.json();
  const validateDetail = contracts.response('get', '/api/orders/{id}', 200);
  expect(validateDetail(detailBody), JSON.stringify(validateDetail.errors)).toBe(true);
  expect(orderResponseSchema.parse(detailBody).order.id).toBe(order.id);
  const canceled = await apiClient.post(`/api/orders/${order.id}/cancel`);
  expect(canceled.status()).toBe(200);
  const cancelBody: unknown = await canceled.json();
  const validateCancel = contracts.response('post', '/api/orders/{id}/cancel', 200);
  expect(validateCancel(cancelBody), JSON.stringify(validateCancel.errors)).toBe(true);
  expect(orderResponseSchema.parse(cancelBody).order.status).toBe('CANCELED');
});

test('positions satisfy the live OpenAPI contract and runtime schema', async ({ apiClient }) => {
  const contracts = await OpenApiContracts.load(apiClient);
  const response = await apiClient.get('/api/positions');
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  const validate = contracts.response('get', '/api/positions', 200);
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(positionsResponseSchema.safeParse(body).success).toBe(true);
});

baseTest('session success and auth errors satisfy their published contracts', async ({ request }) => {
  const contracts = await OpenApiContracts.load(request);
  const login = await request.post('/api/session', { data: credentials.trader });
  expect(login.status()).toBe(200);
  const body: unknown = await login.json();
  const session = sessionResponseSchema.parse(body);
  try {
    const validateSession = contracts.response('post', '/api/session', 200);
    expect(validateSession(body), JSON.stringify(validateSession.errors)).toBe(true);
    const denied = await request.get('/api/orders');
    expect(denied.status()).toBe(401);
    const errorBody: unknown = await denied.json();
    const validateError = contracts.response('get', '/api/orders', 401);
    expect(validateError(errorBody), JSON.stringify(validateError.errors)).toBe(true);
    expect(errorResponseSchema.parse(errorBody).error.code).toBe('UNAUTHORIZED');
  } finally {
    expect(
      (
        await request.delete('/api/session', {
          headers: { Authorization: `Bearer ${session.token}` },
        })
      ).status(),
    ).toBe(204);
  }
});

test('conflict errors are structured and satisfy the OpenAPI contract', async ({ apiClient }) => {
  const contracts = await OpenApiContracts.load(apiClient);
  const response = await apiClient.post(`/api/orders/${seedIds.filledOrder}/cancel`);
  expect(response.status()).toBe(409);
  const body: unknown = await response.json();
  const validate = contracts.response('post', '/api/orders/{id}/cancel', 409);
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(errorResponseSchema.parse(body).error.code).toBe('ORDER_NOT_CANCELABLE');
});

// Literal wire faults catch removed required fields, enum drift and weakened numeric constraints.
const malformedFields = [
  { name: 'missing order id', fault: { id: undefined } },
  { name: 'unknown symbol', fault: { symbol: 'FAKE' } },
  { name: 'unknown side', fault: { side: 'HOLD' } },
  { name: 'string quantity', fault: { quantity: '10' } },
  { name: 'zero quantity', fault: { quantity: 0 } },
  { name: 'fractional quantity', fault: { quantity: 1.5 } },
  { name: 'quantity above maximum', fault: { quantity: 1_000_001 } },
  { name: 'unknown order type', fault: { type: 'STOP' } },
  { name: 'LIMIT order without price', fault: { type: 'LIMIT', limitPrice: undefined } },
  { name: 'MARKET order with price', fault: { type: 'MARKET', limitPrice: 100 } },
  { name: 'zero LIMIT price', fault: { type: 'LIMIT', limitPrice: 0 } },
  { name: 'unspecified response field', fault: { unexpectedField: true } },
  { name: 'unknown status', fault: { status: 'DONE' } },
  { name: 'invalid timestamp', fault: { createdAt: 'yesterday' } },
] as const;

for (const scenario of malformedFields) {
  test(`HTTP 200 cannot hide ${scenario.name}`, async ({ apiClient }) => {
    const contracts = await OpenApiContracts.load(apiClient);
    const response = await apiClient.get('/api/orders');
    expect(response.status()).toBe(200);
    const { orders } = ordersResponseSchema.parse(await response.json());
    const baseline = orders[0];
    expect(baseline).toBeDefined();
    // Simulate bytes from a faulty upstream response; undefined is omitted on the wire.
    const malformed: unknown = JSON.parse(
      JSON.stringify({ orders: [{ ...baseline, ...scenario.fault }] }),
    );
    const validate = contracts.response('get', '/api/orders', 200);
    expect(validate(malformed)).toBe(false);
    expect(validate.errors?.length).toBeGreaterThan(0);
    expect(ordersResponseSchema.safeParse(malformed).success).toBe(false);
  });
}
