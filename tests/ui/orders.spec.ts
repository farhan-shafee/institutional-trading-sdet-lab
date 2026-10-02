import { orderResponseSchema, ordersResponseSchema } from '../../app/domain/schemas.js';
import { OrderEntryPage } from '../../pages/OrderEntryPage.js';
import { seedIds } from '../../test-data/fixtures/reference-data.js';
import { test, expect } from '../fixtures/tradeflow.fixture.js';

test('blotter loads all seed states and the synthetic positions summary', async ({
  tradeBlotterPage,
  authenticatedPage,
}) => {
  await expect(tradeBlotterPage.rows).toHaveCount(5);
  for (const status of ['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED']) {
    await expect(
      tradeBlotterPage.table.getByRole('cell', { name: status, exact: true }),
    ).toBeVisible();
  }
  await expect(
    authenticatedPage.getByRole('table', { name: 'Positions', exact: true }),
  ).toBeVisible();
});

test('symbol filter shows only matching orders and can reset', async ({ tradeBlotterPage }) => {
  await tradeBlotterPage.filter({ symbol: 'AAPL' });
  await expect(tradeBlotterPage.rows).toHaveCount(2);
  await expect(tradeBlotterPage.table.getByRole('cell', { name: 'AAPL', exact: true })).toHaveCount(
    2,
  );
  await expect(tradeBlotterPage.table.getByRole('cell', { name: 'MSFT', exact: true })).toHaveCount(
    0,
  );
  await tradeBlotterPage.filter({ symbol: '' });
  await expect(tradeBlotterPage.rows).toHaveCount(5);
});

test('status filter shows only partially filled orders', async ({ tradeBlotterPage }) => {
  await tradeBlotterPage.filter({ status: 'PARTIALLY_FILLED' });
  await expect(tradeBlotterPage.rows).toHaveCount(1);
  await expect(tradeBlotterPage.row(seedIds.partialOrder)).toBeVisible();
  await expect(tradeBlotterPage.row(seedIds.newOrder)).toHaveCount(0);
});

test('side filter shows only the exact SELL orders', async ({ tradeBlotterPage }) => {
  await tradeBlotterPage.filter({ side: 'SELL' });
  await expect(tradeBlotterPage.rows).toHaveCount(3);
  for (const id of [seedIds.partialOrder, seedIds.canceledOrder, seedIds.rejectedOrder]) {
    await expect(tradeBlotterPage.row(id)).toBeVisible();
  }
  await expect(tradeBlotterPage.table.getByRole('cell', { name: 'SELL', exact: true })).toHaveCount(
    3,
  );
});

test('combined filters have an honest empty state', async ({ tradeBlotterPage }) => {
  await tradeBlotterPage.filter({ symbol: 'SPY', status: 'NEW' });
  await expect(tradeBlotterPage.rows).toHaveCount(0);
  await expect(
    tradeBlotterPage.table.getByText('No orders match these filters.', { exact: true }),
  ).toBeVisible();
});

test('submits a synthetic market order and shows its details', async ({
  authenticatedPage,
  apiClient,
}) => {
  const entry = new OrderEntryPage(authenticatedPage);
  await entry.submit({ symbol: 'SPY', side: 'SELL', quantity: 37, type: 'MARKET' });
  await expect(authenticatedPage.getByRole('status')).toContainText('Order submitted.');
  await expect(
    authenticatedPage.getByRole('region', { name: 'Order details', exact: true }),
  ).toContainText('SPY');
  await expect(authenticatedPage.getByTestId('detail-status')).toHaveText('NEW');
  await expect(authenticatedPage.getByTestId('detail-id')).not.toHaveText('');
  const id = await authenticatedPage.getByTestId('detail-id').innerText();
  const response = await apiClient.get(`/api/orders/${id}`);
  expect(response.status()).toBe(200);
  const { order } = orderResponseSchema.parse(await response.json());
  expect(order).toMatchObject({
    id,
    symbol: 'SPY',
    side: 'SELL',
    quantity: 37,
    type: 'MARKET',
    status: 'NEW',
  });
  expect(order).not.toHaveProperty('limitPrice');
});

test('submits a limit order with a positive price', async ({ authenticatedPage }) => {
  const entry = new OrderEntryPage(authenticatedPage);
  await entry.submit({
    symbol: 'NVDA',
    side: 'BUY',
    quantity: 12,
    type: 'LIMIT',
    limitPrice: 125.25,
  });
  await expect(authenticatedPage.getByRole('status')).toContainText('Order submitted.');
  await expect(
    authenticatedPage.getByRole('region', { name: 'Order details', exact: true }),
  ).toContainText('125.25');
});

test('quantity validation blocks order creation', async ({
  authenticatedPage,
  tradeBlotterPage,
  apiClient,
}) => {
  const before = await apiClient.get('/api/orders');
  expect(before.status()).toBe(200);
  const originalBook = ordersResponseSchema.parse(await before.json());
  const entry = new OrderEntryPage(authenticatedPage);
  await entry.quantity.fill('0');
  await entry.submitButton.click();
  await expect(entry.alert).toHaveText('Quantity must be a whole number from 1 to 1,000,000.');
  await expect(tradeBlotterPage.rows).toHaveCount(5);
  const after = await apiClient.get('/api/orders');
  expect(after.status()).toBe(200);
  expect(ordersResponseSchema.parse(await after.json())).toEqual(originalBook);
});

test('limit price validation blocks a nonpositive price', async ({
  authenticatedPage,
  tradeBlotterPage,
  apiClient,
}) => {
  const before = await apiClient.get('/api/orders');
  expect(before.status()).toBe(200);
  const originalBook = ordersResponseSchema.parse(await before.json());
  const entry = new OrderEntryPage(authenticatedPage);
  await entry.submit({ symbol: 'AAPL', side: 'BUY', quantity: 10, type: 'LIMIT', limitPrice: 0 });
  await expect(entry.alert).toHaveText('Limit price must be greater than zero.');
  await expect(tradeBlotterPage.rows).toHaveCount(5);
  const after = await apiClient.get('/api/orders');
  expect(after.status()).toBe(200);
  expect(ordersResponseSchema.parse(await after.json())).toEqual(originalBook);
});

test('viewing order details preserves the selected identity and status', async ({
  tradeBlotterPage,
  authenticatedPage,
}) => {
  await tradeBlotterPage.viewOrder(seedIds.partialOrder);
  await expect(authenticatedPage.getByTestId('detail-id')).toHaveText(seedIds.partialOrder);
  await expect(authenticatedPage.getByTestId('detail-status')).toHaveText('PARTIALLY_FILLED');
  await expect(
    authenticatedPage.getByRole('region', { name: 'Order details', exact: true }),
  ).toContainText('MSFT');
});

test('canceling an eligible order updates the details and blotter', async ({
  tradeBlotterPage,
  authenticatedPage,
}) => {
  await tradeBlotterPage.viewOrder(seedIds.newOrder);
  await authenticatedPage.getByRole('button', { name: 'Cancel order', exact: true }).click();
  await expect(authenticatedPage.getByTestId('detail-status')).toHaveText('CANCELED');
  await expect(
    tradeBlotterPage.row(seedIds.newOrder).getByRole('cell', { name: 'CANCELED', exact: true }),
  ).toBeVisible();
  await expect(
    authenticatedPage.getByRole('button', { name: 'Cancel order', exact: true }),
  ).toHaveCount(0);
});

test('a filled order cannot enter the cancel workflow', async ({
  tradeBlotterPage,
  authenticatedPage,
}) => {
  await tradeBlotterPage.viewOrder(seedIds.filledOrder);
  await expect(authenticatedPage.getByTestId('detail-status')).toHaveText('FILLED');
  await expect(
    authenticatedPage.getByRole('button', { name: 'Cancel order', exact: true }),
  ).toHaveCount(0);
});
