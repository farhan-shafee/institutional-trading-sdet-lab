import { ordersResponseSchema } from '../../app/domain/schemas.js';
import { test, expect } from '../fixtures/tradeflow.fixture.js';
import { OpenApiContracts } from '../contract/openapi-validator.js';

test('the UI rejects a malformed order response even when HTTP status is 200', async ({
  authenticatedPage,
  apiClient,
}) => {
  const contracts = await OpenApiContracts.load(apiClient);
  const validate = contracts.response('get', '/api/orders', 200);
  // The fault is isolated to this browser context; the server and other tests stay healthy.
  await authenticatedPage.route('**/api/orders', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        orders: [
          {
            id: 'synthetic-contract-fault',
            symbol: 'AAPL',
            side: 'BUY',
            quantity: 'ten',
            type: 'MARKET',
            status: 'NEW',
            createdAt: '2026-01-01T12:00:00.000Z',
          },
        ],
      }),
    });
  });
  const received = authenticatedPage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/orders',
  );
  await authenticatedPage.reload();
  const response = await received;
  expect(response.status()).toBe(200);
  const wireBody: unknown = await response.json();
  expect(validate(wireBody)).toBe(false);
  expect(validate.errors?.length).toBeGreaterThan(0);
  expect(ordersResponseSchema.safeParse(wireBody).success).toBe(false);
  await expect(authenticatedPage.getByRole('alert')).toHaveText(
    'Server response did not match the expected contract.',
  );
});
