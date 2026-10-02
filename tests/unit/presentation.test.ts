import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrderBook } from '../../app/domain/order-book.js';
import { grossPositionNotional, summarizeOrders } from '../../app/public/presentation.js';

await test('overview counts partition every synthetic lifecycle state and reflect cancellation', () => {
  const book = new OrderBook();
  assert.deepEqual(summarizeOrders(book.list()), { total: 5, working: 2, filled: 1, closed: 2 });
  book.cancel('seed-partial-msft');
  assert.deepEqual(summarizeOrders(book.list()), { total: 5, working: 1, filled: 1, closed: 3 });
  book.create({ symbol: 'SPY', side: 'BUY', quantity: 43, type: 'MARKET' });
  assert.deepEqual(summarizeOrders(book.list()), { total: 6, working: 2, filled: 1, closed: 3 });
});

await test('a validated empty book has zero counts', () => {
  assert.deepEqual(summarizeOrders([]), { total: 0, working: 0, filled: 0, closed: 0 });
});

await test('synthetic gross position notional uses absolute quantity and average cost, not order prices', () => {
  assert.equal(
    grossPositionNotional([
      { symbol: 'AAPL', quantity: 10, averagePrice: 182.4 },
      { symbol: 'MSFT', quantity: -5, averagePrice: 402.1 },
      { symbol: 'SPY', quantity: 0, averagePrice: 545.2 },
    ]),
    3834.5,
  );
  assert.equal(grossPositionNotional([]), 0);
});
