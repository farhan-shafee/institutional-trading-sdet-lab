import { ordersResponseSchema } from '../../app/domain/schemas.js';
import { test, expect } from '../fixtures/tradeflow.fixture.js';
import { OpenApiContracts } from '../contract/openapi-validator.js';

test('intentional contract failure records a malformed HTTP 200 response', async ({
  authenticatedPage,
  apiClient,
}) => {
  test.info().annotations.push({
    type: 'intentional-failure',
    description: 'HTTP success with malformed JSON demonstrates contract evidence.',
  });
  const contracts = await OpenApiContracts.load(apiClient);
  const validate = contracts.response('get', '/api/orders', 200);
  await authenticatedPage.route('**/api/orders', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        orders: [
          {
            id: 'broken-wire-order',
            symbol: 'AAPL',
            side: 'BUY',
            quantity: 'many',
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
  const body: unknown = await response.json();
  await expect(authenticatedPage.getByRole('alert')).toHaveText(
    'Server response did not match the expected contract.',
  );
  expect(ordersResponseSchema.safeParse(body).success).toBe(false);
  // Deliberately false, including AJV details in the report while preserving network trace.
  const valid = validate(body);
  expect(valid, `HTTP 200 contract violation: ${JSON.stringify(validate.errors)}`).toBe(true);
});
