import type { Page } from '@playwright/test';
import { orderResponseSchema, ordersResponseSchema } from '../../app/domain/schemas.js';
import { LoginPage } from '../../pages/LoginPage.js';
import { OrderEntryPage } from '../../pages/OrderEntryPage.js';
import { credentials, seedIds } from '../../test-data/fixtures/reference-data.js';
import { test, expect } from '../fixtures/tradeflow.fixture.js';

async function holdResponse(page: Page, path: string) {
  let release!: () => void;
  let signalStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  await page.route(`**${path}`, async (route) => {
    const response = await route.fetch();
    signalStarted();
    await gate;
    await route.fulfill({ response });
  });
  return { started, release };
}

test('a delayed earlier detail cannot replace the order the user selects and cancels', async ({
  authenticatedPage: page,
  tradeBlotterPage,
  apiClient,
}) => {
  const path = `/api/orders/${seedIds.newOrder}`;
  const held = await holdResponse(page, path);
  try {
    await tradeBlotterPage.viewOrder(seedIds.newOrder);
    await held.started;
    await tradeBlotterPage.viewOrder(seedIds.partialOrder);
    await expect(page.getByTestId('detail-id')).toHaveText(seedIds.partialOrder);
    const earlierResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === path,
    );
    held.release();
    expect(await (await earlierResponse).finished()).toBeNull();

    await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
    await expect(page.getByTestId('detail-id')).toHaveText(seedIds.partialOrder);
    await expect(page.getByTestId('detail-status')).toHaveText('CANCELED');
    const earlier = await apiClient.get(`/api/orders/${seedIds.newOrder}`);
    const selected = await apiClient.get(`/api/orders/${seedIds.partialOrder}`);
    expect(earlier.status()).toBe(200);
    expect(selected.status()).toBe(200);
    expect(orderResponseSchema.parse(await earlier.json()).order.status).toBe('NEW');
    expect(orderResponseSchema.parse(await selected.json()).order.status).toBe('CANCELED');
  } finally {
    held.release();
  }
});

test('closing details invalidates an earlier pending detail request', async ({
  authenticatedPage: page,
  tradeBlotterPage,
}) => {
  await tradeBlotterPage.viewOrder(seedIds.partialOrder);
  await expect(page.getByTestId('detail-id')).toHaveText(seedIds.partialOrder);
  const path = `/api/orders/${seedIds.newOrder}`;
  const held = await holdResponse(page, path);
  try {
    await tradeBlotterPage.viewOrder(seedIds.newOrder);
    await held.started;
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    const earlierResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === path,
    );
    held.release();
    expect(await (await earlierResponse).finished()).toBeNull();
    const filteredResponse = page.waitForResponse(
      (response) => new URL(response.url()).search === '?symbol=MSFT',
    );
    await tradeBlotterPage.filter({ symbol: 'MSFT' });
    expect(await (await filteredResponse).finished()).toBeNull();
    await expect(tradeBlotterPage.row(seedIds.partialOrder)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Order details', exact: true })).toBeHidden();
  } finally {
    held.release();
  }
});

test('a delayed cancellation updates its target without replacing a later selection', async ({
  authenticatedPage: page,
  tradeBlotterPage,
  apiClient,
}) => {
  await tradeBlotterPage.viewOrder(seedIds.newOrder);
  await expect(page.getByTestId('detail-id')).toHaveText(seedIds.newOrder);
  const path = `/api/orders/${seedIds.newOrder}/cancel`;
  const held = await holdResponse(page, path);
  try {
    await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
    await held.started;
    await tradeBlotterPage.viewOrder(seedIds.partialOrder);
    await expect(page.getByTestId('detail-id')).toHaveText(seedIds.partialOrder);
    const canceledResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === path,
    );
    const refreshedResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/orders',
    );
    held.release();
    expect(await (await canceledResponse).finished()).toBeNull();
    expect(await (await refreshedResponse).finished()).toBeNull();
    await expect(
      tradeBlotterPage.row(seedIds.newOrder).getByRole('cell', { name: 'CANCELED', exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('detail-id')).toHaveText(seedIds.partialOrder);
    await expect(page.getByTestId('detail-status')).toHaveText('PARTIALLY_FILLED');
    await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
    await expect(page.getByTestId('detail-id')).toHaveText(seedIds.partialOrder);
    await expect(page.getByTestId('detail-status')).toHaveText('CANCELED');
    for (const id of [seedIds.newOrder, seedIds.partialOrder]) {
      const response = await apiClient.get(`/api/orders/${id}`);
      expect(response.status()).toBe(200);
      expect(orderResponseSchema.parse(await response.json()).order).toMatchObject({
        id,
        status: 'CANCELED',
      });
    }
  } finally {
    held.release();
  }
});

test('a newly submitted order invalidates an earlier pending detail request', async ({
  authenticatedPage: page,
  tradeBlotterPage,
}) => {
  const path = `/api/orders/${seedIds.newOrder}`;
  const held = await holdResponse(page, path);
  try {
    await tradeBlotterPage.viewOrder(seedIds.newOrder);
    await held.started;
    await new OrderEntryPage(page).submit({
      symbol: 'SPY',
      side: 'BUY',
      quantity: 43,
      type: 'MARKET',
    });
    await expect(page.getByRole('status')).toHaveText('Order submitted.');
    const submittedId = await page.getByTestId('detail-id').innerText();
    expect(submittedId).not.toBe(seedIds.newOrder);
    const earlierResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === path,
    );
    held.release();
    expect(await (await earlierResponse).finished()).toBeNull();
    await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
    await expect(page.getByTestId('detail-id')).toHaveText(submittedId);
    await expect(page.getByTestId('detail-status')).toHaveText('CANCELED');
  } finally {
    held.release();
  }
});

test('an error from a superseded detail request does not obscure the selected order', async ({
  authenticatedPage: page,
  tradeBlotterPage,
}) => {
  let release!: () => void;
  let signalStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const path = `/api/orders/${seedIds.newOrder}`;
  await page.route(`**${path}`, async (route) => {
    signalStarted();
    await gate;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'INTERNAL_ERROR', message: 'Controlled detail failure.' },
      }),
    });
  });
  try {
    await tradeBlotterPage.viewOrder(seedIds.newOrder);
    await started;
    await tradeBlotterPage.viewOrder(seedIds.partialOrder);
    await expect(page.getByTestId('detail-id')).toHaveText(seedIds.partialOrder);
    const failedResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === path,
    );
    release();
    expect(await (await failedResponse).finished()).toBeNull();
    await page.getByLabel('Quantity', { exact: true }).fill('101');
    await expect(page.getByTestId('detail-id')).toHaveText(seedIds.partialOrder);
    await expect(page.getByRole('alert')).toBeHidden();
  } finally {
    release();
  }
});

for (const failure of ['server', 'network', 'contract'] as const) {
  test(`a ${failure} failure while restoring retains the token and owned order book for reload`, async ({
    authenticatedPage: page,
    authSession,
    orderFactory,
    tradeBlotterPage,
    apiClient,
  }) => {
    const order = await orderFactory({ symbol: 'SPY', quantity: 37 });
    const path = failure === 'network' ? '/api/session' : '/api/orders';
    await page.route(`**${path}`, async (route) => {
      if (failure === 'network') {
        await route.abort('failed');
      } else {
        await route.fulfill({
          status: failure === 'server' ? 500 : 200,
          contentType: 'application/json',
          body: JSON.stringify(
            failure === 'server'
              ? { error: { code: 'INTERNAL_ERROR', message: 'Controlled read failure.' } }
              : { orders: [{ id: order.id }] },
          ),
        });
      }
    });
    const completed =
      failure === 'network'
        ? page
            .waitForEvent('requestfailed', (request) => new URL(request.url()).pathname === path)
            .then(() => undefined)
        : page
            .waitForResponse((response) => new URL(response.url()).pathname === path)
            .then(async (response) => {
              expect(await response.finished()).toBeNull();
            });
    await page.reload();
    await completed;
    await expect(page.getByRole('alert')).toHaveText(
      failure === 'network'
        ? 'The local server could not be reached.'
        : failure === 'server'
          ? 'Controlled read failure.'
          : 'Server response did not match the expected contract.',
    );
    expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBe(
      authSession.token,
    );
    await page.unroute(`**${path}`);
    await page.reload();
    await expect(tradeBlotterPage.row(order.id)).toBeVisible();
    await tradeBlotterPage.viewOrder(order.id);
    await expect(page.getByTestId('detail-id')).toHaveText(order.id);
    const response = await apiClient.get(`/api/orders/${order.id}`);
    expect(response.status()).toBe(200);
    expect(orderResponseSchema.parse(await response.json()).order).toMatchObject({
      id: order.id,
      symbol: 'SPY',
      quantity: 37,
      status: 'NEW',
    });
  });
}

test('unauthorized order reads and restoration clear authentication and explain the session boundary', async ({
  authenticatedPage: page,
  authSession,
}) => {
  await expect(
    page.getByRole('table', { name: 'Orders', exact: true }).getByRole('button'),
  ).toHaveCount(5);
  await page.route('**/api/orders?symbol=AAPL', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'UNAUTHORIZED', message: 'Session is invalid or expired.' },
      }),
    });
  });
  const expiredRead = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/orders' && response.status() === 401,
  );
  await page.getByLabel('Filter symbol', { exact: true }).selectOption('AAPL');
  expect(await (await expiredRead).finished()).toBeNull();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('Session is invalid or expired.');
  expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBeNull();
  await expect(page.getByRole('table', { name: 'Orders', exact: true })).toBeHidden();
  // Reuse only this test's owned token to exercise the independent restoration boundary.
  await page.evaluate(
    (ownedToken) => localStorage.setItem('tradeflow.token', ownedToken),
    authSession.token,
  );
  await page.route('**/api/session', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'UNAUTHORIZED', message: 'Session is invalid or expired.' },
      }),
    });
  });
  const unauthorizedResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/session',
  );
  await page.reload();
  expect(await (await unauthorizedResponse).finished()).toBeNull();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('Session is invalid or expired.');
  expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBeNull();
  await expect(page.getByRole('table', { name: 'Orders', exact: true })).toBeHidden();
});

test('details preserve an accepted positive LIMIT price below one cent', async ({
  authenticatedPage: page,
  orderFactory,
  tradeBlotterPage,
}) => {
  const order = await orderFactory({ type: 'LIMIT', limitPrice: 0.001 });
  await tradeBlotterPage.goto();
  await expect(tradeBlotterPage.row(order.id)).toBeVisible();
  await tradeBlotterPage.viewOrder(order.id);
  await expect(page.getByTestId('detail-id')).toHaveText(order.id);
  await expect(page.getByTestId('detail-limit-price')).toHaveText('0.001');
});

for (const status of [401, 200] as const) {
  test(`a late ${status} restoration cannot replace a newer viewer login`, async ({
    authenticatedPage: page,
    authSession,
    orderFactory,
    tradeBlotterPage,
    request,
  }) => {
    const earlierOrder = await orderFactory({ symbol: 'SPY', quantity: 37 });
    let release!: () => void;
    let signalStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let viewerToken: string | null = null;
    await page.route('**/api/session', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const earlierResponse = await route.fetch();
      signalStarted();
      await gate;
      if (status === 200) {
        await route.fulfill({ response: earlierResponse });
      } else {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'UNAUTHORIZED', message: 'Earlier session is invalid.' },
          }),
        });
      }
    });
    try {
      await page.reload();
      await started;
      const login = new LoginPage(page);
      await expect(login.signInButton).toBeVisible();
      await login.signIn(credentials.viewer.username, credentials.viewer.password);
      await expect(page.getByText('qa.viewer · viewer', { exact: true })).toBeVisible();
      await expect(
        page.getByText(
          'Viewer sessions can inspect orders. Sign in as qa.user to submit or cancel.',
          { exact: true },
        ),
      ).toBeVisible();
      viewerToken = await page.evaluate(() => localStorage.getItem('tradeflow.token'));
      expect(viewerToken).toBeTruthy();
      expect(viewerToken).not.toBe(authSession.token);
      const earlierResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/session' &&
          response.request().method() === 'GET',
      );
      release();
      const response = await earlierResponse;
      expect(response.status()).toBe(status);
      expect(await response.finished()).toBeNull();
      // This persistent header action lets the browser process the completed request,
      // even if a broken restoration has hidden the workspace.
      await page.getByText(/SYNTHETIC \/ LOCAL$/).click();
      expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBe(viewerToken);
      await expect(page.getByText('qa.viewer · viewer', { exact: true })).toBeVisible();
      await expect(
        page.getByText(
          'Viewer sessions can inspect orders. Sign in as qa.user to submit or cancel.',
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Submit order', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Submit order', exact: true })).toBeDisabled();
      const filteredResponse = page.waitForResponse(
        (response) => new URL(response.url()).search === '?symbol=MSFT',
      );
      await tradeBlotterPage.filter({ symbol: 'MSFT' });
      expect(await (await filteredResponse).finished()).toBeNull();
      await expect(tradeBlotterPage.row(seedIds.partialOrder)).toBeVisible();
      await expect(page.getByRole('alert')).toBeHidden();
      const headers = { Authorization: `Bearer ${viewerToken}` };
      const currentSession = await request.get('/api/session', { headers });
      expect(currentSession.status()).toBe(200);
      const sessionBody: unknown = await currentSession.json();
      expect(sessionBody).toEqual({ user: { username: 'qa.viewer', role: 'viewer' } });
      const currentBook = await request.get('/api/orders', { headers });
      expect(currentBook.status()).toBe(200);
      const { orders } = ordersResponseSchema.parse(await currentBook.json());
      expect(orders).toHaveLength(5);
      expect(orders.map((order) => order.id)).not.toContain(earlierOrder.id);
    } finally {
      release();
      if (viewerToken) {
        const cleanup = await request.delete('/api/session', {
          headers: { Authorization: `Bearer ${viewerToken}` },
        });
        expect(cleanup.status()).toBe(204);
      }
    }
  });
}
