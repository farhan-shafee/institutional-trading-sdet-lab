import { orderResponseSchema, ordersResponseSchema } from '../../app/domain/schemas.js';
import { OrderEntryPage } from '../../pages/OrderEntryPage.js';
import { test, expect } from '../fixtures/tradeflow.fixture.js';

test('an API-created order is visible and cancelable through the UI', async ({
  apiClient,
  orderFactory,
  tradeBlotterPage,
  authenticatedPage,
}) => {
  const order = await orderFactory({ symbol: 'MSFT', side: 'SELL', quantity: 29 });
  await tradeBlotterPage.goto();
  await expect(tradeBlotterPage.row(order.id)).toBeVisible();
  await expect(
    tradeBlotterPage.row(order.id).getByRole('cell', { name: '29', exact: true }),
  ).toBeVisible();
  await tradeBlotterPage.viewOrder(order.id);
  await authenticatedPage.getByRole('button', { name: 'Cancel order', exact: true }).click();
  await expect(authenticatedPage.getByTestId('detail-status')).toHaveText('CANCELED');
  const response = await apiClient.get(`/api/orders/${order.id}`);
  expect(response.status()).toBe(200);
  expect(orderResponseSchema.parse(await response.json()).order.status).toBe('CANCELED');
});

test('a UI-created order is independently readable through the API', async ({
  authenticatedPage,
  apiClient,
}) => {
  const entry = new OrderEntryPage(authenticatedPage);
  await entry.submit({
    symbol: 'SPY',
    side: 'BUY',
    quantity: 43,
    type: 'LIMIT',
    limitPrice: 450.5,
  });
  await expect(authenticatedPage.getByRole('status')).toContainText('Order submitted.');
  const id = await authenticatedPage.getByTestId('detail-id').innerText();
  expect(id).not.toBe('');
  const response = await apiClient.get(`/api/orders/${id}`);
  expect(response.status()).toBe(200);
  expect(orderResponseSchema.parse(await response.json()).order).toMatchObject({
    id,
    symbol: 'SPY',
    side: 'BUY',
    quantity: 43,
    type: 'LIMIT',
    limitPrice: 450.5,
    status: 'NEW',
  });
  const all = await apiClient.get('/api/orders');
  expect(all.status()).toBe(200);
  expect(ordersResponseSchema.parse(await all.json()).orders).toHaveLength(6);
});
