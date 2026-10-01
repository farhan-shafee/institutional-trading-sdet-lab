import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOrderSchema, orderSchema } from '../../app/domain/schemas.js';

const market = { symbol: 'AAPL', side: 'BUY', quantity: 10, type: 'MARKET' };

for (const [name, patch] of [
  ['unknown symbol', { symbol: 'FAKE' }],
  ['unknown side', { side: 'HOLD' }],
  ['unknown type', { type: 'STOP' }],
  ['zero quantity', { quantity: 0 }],
  ['negative quantity', { quantity: -2 }],
  ['fractional quantity', { quantity: 0.5 }],
  ['quantity above the cap', { quantity: 1_000_001 }],
  ['string quantity', { quantity: '10' }],
  ['infinite quantity', { quantity: Number.POSITIVE_INFINITY }],
  ['missing quantity', { quantity: undefined }],
  ['unspecified extra field', { productionVenue: 'external' }],
  ['price on a market order', { limitPrice: 10 }],
] as const) {
  await test(`create request rejects ${name}`, () => {
    assert.equal(createOrderSchema.safeParse({ ...market, ...patch }).success, false);
  });
}

await test('market order accepts the inclusive quantity boundaries', () => {
  assert.equal(createOrderSchema.safeParse({ ...market, quantity: 1 }).success, true);
  assert.equal(createOrderSchema.safeParse({ ...market, quantity: 1_000_000 }).success, true);
});

await test('limit order requires a positive finite numeric price', () => {
  const limit = { ...market, type: 'LIMIT' };
  for (const limitPrice of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '4']) {
    assert.equal(createOrderSchema.safeParse({ ...limit, limitPrice }).success, false);
  }
  assert.equal(createOrderSchema.safeParse({ ...limit, limitPrice: 123.45 }).success, true);
});

await test('response validation catches malformed order fields even with plausible HTTP success', () => {
  const order = {
    ...market,
    id: 'synthetic-order',
    status: 'NEW',
    createdAt: '2026-01-05T14:30:00.000Z',
  };
  assert.equal(orderSchema.safeParse(order).success, true);
  for (const patch of [
    { id: '' },
    { status: 'COMPLETED' },
    { createdAt: 'yesterday' },
    { type: 'LIMIT' },
    { quantity: 0 },
  ]) {
    assert.equal(orderSchema.safeParse({ ...order, ...patch }).success, false);
  }
});
