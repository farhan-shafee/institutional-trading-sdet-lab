import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrderBook } from '../../app/domain/order-book.js';

await test('each book starts with the five deterministic lifecycle examples', () => {
  const book = new OrderBook();
  assert.deepEqual(
    book.list().map((order) => (order as { id: string }).id),
    [
      'seed-new-aapl',
      'seed-partial-msft',
      'seed-filled-nvda',
      'seed-canceled-spy',
      'seed-rejected-aapl',
    ],
  );
});

await test('canceling NEW transitions the order to CANCELED', () => {
  const book = new OrderBook();
  const result = book.cancel('seed-new-aapl') as { status: string };
  assert.equal(result.status, 'CANCELED');
  assert.equal((book.get('seed-new-aapl') as { status: string }).status, 'CANCELED');
});

await test('canceling PARTIALLY_FILLED transitions the order to CANCELED', () => {
  assert.equal(
    (new OrderBook().cancel('seed-partial-msft') as { status: string }).status,
    'CANCELED',
  );
});

for (const id of ['seed-filled-nvda', 'seed-canceled-spy', 'seed-rejected-aapl']) {
  await test(`canceling ${id} is a conflict and does not change its status`, () => {
    const book = new OrderBook();
    const previous = book.get(id);
    assert.throws(() => book.cancel(id), { code: 'ORDER_NOT_CANCELABLE', status: 409 });
    assert.deepEqual(book.get(id), previous);
  });
}

await test('an unknown detail or cancellation returns ORDER_NOT_FOUND', () => {
  const book = new OrderBook();
  assert.throws(() => book.get('missing-order'), { code: 'ORDER_NOT_FOUND', status: 404 });
  assert.throws(() => book.cancel('missing-order'), { code: 'ORDER_NOT_FOUND', status: 404 });
});

await test('new orders receive unique IDs, timestamp, and NEW status', () => {
  const book = new OrderBook();
  const input = { symbol: 'AAPL', side: 'BUY', quantity: 7, type: 'MARKET' };
  const first = book.create(input) as { id: string; status: string; createdAt: string };
  const second = book.create(input) as { id: string };
  assert.notEqual(first.id, second.id);
  assert.equal(first.status, 'NEW');
  assert.ok(Number.isFinite(Date.parse(first.createdAt)));
  assert.equal(book.list().length, 7);
});

await test('filter predicates combine and preserve isolated state', () => {
  const book = new OrderBook();
  assert.equal(book.list({ symbol: 'AAPL' }).length, 2);
  assert.equal(book.list({ symbol: 'AAPL', side: 'BUY', status: 'NEW' }).length, 1);
  assert.equal(book.list({ symbol: 'MSFT', status: 'NEW' }).length, 0);
  assert.equal(book.list().length, 5);
});

await test('mutation in one book cannot change a second book', () => {
  const first = new OrderBook();
  const second = new OrderBook();
  first.cancel('seed-new-aapl');
  first.create({ symbol: 'SPY', side: 'SELL', quantity: 20, type: 'MARKET' });
  assert.equal((second.get('seed-new-aapl') as { status: string }).status, 'NEW');
  assert.equal(second.list().length, 5);
});

await test('returned orders cannot be mutated to bypass the lifecycle', () => {
  const book = new OrderBook();
  const detail = book.get('seed-new-aapl') as { status: string };
  detail.status = 'FILLED';
  const listed = book.list()[0] as { quantity: number };
  listed.quantity = -1;
  assert.equal((book.get('seed-new-aapl') as { status: string }).status, 'NEW');
  assert.equal((book.get('seed-new-aapl') as { quantity: number }).quantity, 100);
});
