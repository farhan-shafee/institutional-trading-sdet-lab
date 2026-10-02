import { test as unauthenticatedTest, type APIRequestContext, type Page } from '@playwright/test';
import {
  orderResponseSchema,
  ordersResponseSchema,
  positionsResponseSchema,
  sessionResponseSchema,
} from '../../app/domain/schemas.js';
import { LoginPage } from '../../pages/LoginPage.js';
import { OrderEntryPage } from '../../pages/OrderEntryPage.js';
import { TradeBlotterPage } from '../../pages/TradeBlotterPage.js';
import { credentials, seedIds } from '../../test-data/fixtures/reference-data.js';
import { test, expect } from '../fixtures/tradeflow.fixture.js';

function responseGate() {
  let release!: () => void;
  let signalStarted!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  return { wait, started, release, signalStarted };
}

async function signIn(page: Page, role: keyof typeof credentials) {
  const received = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/session' && response.request().method() === 'POST',
  );
  await new LoginPage(page).signIn(credentials[role].username, credentials[role].password);
  const response = await received;
  expect(response.status()).toBe(200);
  return sessionResponseSchema.parse(await response.json());
}

async function releaseSessions(request: APIRequestContext, tokens: string[]): Promise<void> {
  for (const token of tokens) {
    const response = await request.delete('/api/session', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([204, 401], 'Each UI-owned session must be released or already signed out').toContain(
      response.status(),
    );
  }
}

test('keyboard navigation between all four views preserves filters and the selected order', async ({
  authenticatedPage: page,
  tradeBlotterPage,
}) => {
  await tradeBlotterPage.filter({ symbol: 'MSFT' });
  await expect(tradeBlotterPage.rows).toHaveCount(1);
  await tradeBlotterPage.viewOrder(seedIds.partialOrder);
  await expect(page.getByTestId('detail-id')).toHaveText(seedIds.partialOrder);
  const orders = page.getByRole('tab', { name: 'Orders', exact: true });
  await expect(orders).toHaveAttribute('aria-selected', 'true');
  await orders.focus();
  await orders.press('ArrowLeft');
  const overview = page.getByRole('tab', { name: 'Overview', exact: true });
  await expect(overview).toBeFocused();
  await expect(overview).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Overview', exact: true })).toBeVisible();
  await overview.press('End');
  const activity = page.getByRole('tab', { name: 'Activity', exact: true });
  await expect(activity).toBeFocused();
  await expect(activity).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Activity', exact: true })).toBeVisible();
  await activity.press('ArrowLeft');
  const positions = page.getByRole('tab', { name: 'Positions', exact: true });
  await expect(positions).toBeFocused();
  await expect(positions).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('table', { name: 'Positions', exact: true })).toBeVisible();
  await positions.press('Home');
  await expect(overview).toHaveAttribute('aria-selected', 'true');
  await overview.press('ArrowRight');
  await expect(orders).toBeFocused();
  await expect(orders).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Filter symbol', { exact: true })).toHaveValue('MSFT');
  await expect(tradeBlotterPage.rows).toHaveCount(1);
  await expect(page.getByTestId('detail-id')).toHaveText(seedIds.partialOrder);
  await expect(page.getByTestId('detail-status')).toHaveText('PARTIALLY_FILLED');
  for (const width of [1440, 1024, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await tradeBlotterPage.viewOrder(seedIds.partialOrder);
    const detailHeading = page.getByRole('heading', { name: 'Order details', exact: true });
    await expect(detailHeading).toBeFocused();
    await expect(detailHeading).toBeInViewport();
    for (const name of ['Overview', 'Orders', 'Positions', 'Activity']) {
      await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Submit order', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel order', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `The ${width}px workstation must not overflow the page horizontally`,
    ).toBe(true);
  }
});

test('overview uses the complete book and reflects observed creation and cancellation honestly', async ({
  authenticatedPage: page,
  tradeBlotterPage,
  apiClient,
}) => {
  await expect(tradeBlotterPage.rows).toHaveCount(5);
  await tradeBlotterPage.filter({ symbol: 'MSFT' });
  await expect(tradeBlotterPage.rows).toHaveCount(1);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page.getByTestId('overview-total')).toHaveText('5');
  await expect(page.getByTestId('overview-working')).toHaveText('2');
  await expect(page.getByTestId('overview-filled')).toHaveText('1');
  await expect(page.getByTestId('overview-closed')).toHaveText('2');
  await expect(page.getByTestId('overview-positions')).toHaveText('4');
  // Independent cost-basis oracle: 250*182.4 + 125*402.1 + 80*138.75 + 300*545.2.
  await expect(page.getByTestId('overview-notional')).toHaveText('$270,522.50');
  await page.getByRole('tab', { name: 'Orders', exact: true }).click();
  await new OrderEntryPage(page).submit({
    symbol: 'SPY',
    side: 'BUY',
    quantity: 43,
    type: 'MARKET',
  });
  await expect(page.getByRole('status')).toHaveText('Order submitted.');
  const id = await page.getByTestId('detail-id').innerText();
  expect(id).not.toBe('');
  await expect(tradeBlotterPage.rows).toHaveCount(6);
  await expect(page.getByTestId('detail-lifecycle')).toContainText('NEW');
  await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
  await expect(page.getByTestId('detail-status')).toHaveText('CANCELED');
  await expect(page.getByTestId('detail-lifecycle')).toContainText('CANCELED');
  const response = await apiClient.get(`/api/orders/${id}`);
  expect(response.status()).toBe(200);
  const persistedOrder = orderResponseSchema.parse(await response.json()).order;
  expect(persistedOrder).toMatchObject({
    id,
    symbol: 'SPY',
    side: 'BUY',
    quantity: 43,
    status: 'CANCELED',
  });
  const lifecycle = page.getByTestId('detail-lifecycle');
  await expect(lifecycle.getByRole('listitem')).toHaveCount(2);
  await expect(lifecycle.getByRole('listitem').nth(0)).toContainText(persistedOrder.createdAt);
  await expect(lifecycle.getByRole('listitem').nth(1)).toContainText('CANCELED');
  await expect(lifecycle).toContainText(/not an event history|no exchange event history/i);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page.getByTestId('overview-total')).toHaveText('6');
  await expect(page.getByTestId('overview-working')).toHaveText('2');
  await expect(page.getByTestId('overview-filled')).toHaveText('1');
  await expect(page.getByTestId('overview-closed')).toHaveText('3');
  await expect(page.getByTestId('overview-notional')).toHaveText('$270,522.50');
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  const activity = page.getByRole('list', { name: 'Session activity', exact: true });
  await expect(
    activity.getByText(`Created order ${id}: SPY BUY 43, NEW.`, { exact: true }),
  ).toBeVisible();
  await expect(activity.getByText(`Canceled order ${id}.`, { exact: true })).toBeVisible();
  await expect(activity).not.toContainText(`Created order ${seedIds.newOrder}`);
  await page.reload();
  await expect(tradeBlotterPage.row(id)).toBeVisible();
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await expect(activity.getByRole('listitem')).toHaveCount(1);
  await expect(activity).toContainText('Session restored: qa.user (trader).');
  await expect(activity).not.toContainText(`Created order ${id}`);
  await expect(activity).not.toContainText(`Canceled order ${id}`);
  await expect(activity).not.toContainText(`Viewed order ${id}`);
  const afterReload = await apiClient.get(`/api/orders/${id}`);
  expect(afterReload.status()).toBe(200);
  expect(orderResponseSchema.parse(await afterReload.json()).order).toEqual(persistedOrder);
});

test('market snapshot exposes fixed synthetic quotes without inventing live prices or activity', async ({
  authenticatedPage: page,
}) => {
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  const snapshot = page.getByRole('table', { name: 'Synthetic market snapshot', exact: true });
  await expect(snapshot).toBeVisible();
  await expect(snapshot.getByRole('columnheader')).toHaveText(['Symbol', 'Bid', 'Ask', 'Last']);
  const expectedQuotes = [
    ['AAPL', '$185.20', '$185.30', '$185.25'],
    ['MSFT', '$410.40', '$410.60', '$410.50'],
    ['NVDA', '$138.70', '$138.80', '$138.75'],
    ['SPY', '$550.00', '$550.10', '$550.05'],
  ] as const;
  for (const [symbol, ...prices] of expectedQuotes) {
    const row = snapshot.getByRole('row').filter({
      has: page.getByRole('cell', { name: symbol, exact: true }),
    });
    await expect(row.getByRole('cell')).toHaveText([symbol, ...prices]);
  }
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  const activity = page.getByRole('list', { name: 'Session activity', exact: true });
  await expect(activity.getByRole('listitem')).toHaveCount(1);
  await expect(activity).toContainText('Session restored: qa.user (trader).');
  await expect(activity).not.toContainText('Created order');
  await expect(
    page.getByText('No actions observed in this browser session.', { exact: true }),
  ).toBeHidden();
});

unauthenticatedTest(
  'viewer controls remain visible and disabled while order inspection remains available',
  async ({ page, request }) => {
    const tokens: string[] = [];
    try {
      await page.goto('/');
      const viewer = await signIn(page, 'viewer');
      tokens.push(viewer.token);
      const blotter = new TradeBlotterPage(page);
      await expect(blotter.rows).toHaveCount(5);
      await expect(page.getByText('qa.viewer · viewer', { exact: true })).toBeVisible();
      const submit = page.getByRole('button', { name: 'Submit order', exact: true });
      await expect(submit).toBeVisible();
      await expect(submit).toBeDisabled();
      for (const label of ['Symbol', 'Side', 'Quantity', 'Order type']) {
        await expect(page.getByLabel(label, { exact: true })).toBeVisible();
        await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
      }
      await expect(
        page.getByText(
          'Viewer sessions can inspect orders. Sign in as qa.user to submit or cancel.',
          { exact: true },
        ),
      ).toBeVisible();
      await blotter.viewOrder(seedIds.newOrder);
      await expect(page.getByTestId('detail-id')).toHaveText(seedIds.newOrder);
      const cancel = page.getByRole('button', { name: 'Cancel order', exact: true });
      await expect(cancel).toBeVisible();
      await expect(cancel).toBeDisabled();
      await page.getByRole('tab', { name: 'Activity', exact: true }).click();
      await expect(page.getByRole('list', { name: 'Session activity', exact: true })).toContainText(
        `Viewed order ${seedIds.newOrder}.`,
      );
    } finally {
      await releaseSessions(request, tokens);
    }
  },
);

test('a delayed full-book response cannot erase a newer committed creation or overview state', async ({
  authenticatedPage: page,
  tradeBlotterPage,
}) => {
  await expect(tradeBlotterPage.rows).toHaveCount(5);
  await tradeBlotterPage.filter({ symbol: 'AAPL' });
  await expect(tradeBlotterPage.rows).toHaveCount(2);
  const held = responseGate();
  let reads = 0;
  await page.route('**/api/orders', async (route) => {
    if (route.request().method() !== 'GET' || reads++ !== 0) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    expect(ordersResponseSchema.parse(await response.json()).orders).toHaveLength(5);
    held.signalStarted();
    await held.wait;
    await route.fulfill({ response });
  });
  try {
    await tradeBlotterPage.filter({ symbol: '' });
    await held.started;
    await new OrderEntryPage(page).submit({
      symbol: 'SPY',
      side: 'BUY',
      quantity: 43,
      type: 'MARKET',
    });
    await expect(page.getByRole('status')).toHaveText('Order submitted.');
    const id = await page.getByTestId('detail-id').innerText();
    await expect(tradeBlotterPage.rows).toHaveCount(6);
    const earlier = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/orders' && response.request().method() === 'GET',
    );
    held.release();
    expect(await (await earlier).finished()).toBeNull();
    await page.getByText(/SYNTHETIC \/ LOCAL$/).click();
    await expect(tradeBlotterPage.rows).toHaveCount(6);
    await expect(tradeBlotterPage.row(id)).toBeVisible();
    await expect(page.getByTestId('detail-id')).toHaveText(id);
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await expect(page.getByTestId('overview-total')).toHaveText('6');
    await expect(page.getByTestId('overview-working')).toHaveText('3');
  } finally {
    held.release();
  }
});

unauthenticatedTest(
  'prior-session book and positions responses cannot overwrite a newer viewer summary or activity',
  async ({ page, request }) => {
    const tokens: string[] = [];
    const held = responseGate();
    const earlierBook = responseGate();
    let reads = 0;
    await page.route('**/api/positions', async (route) => {
      if (reads++ !== 0) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      positionsResponseSchema.parse(await response.json());
      held.signalStarted();
      await held.wait;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ positions: [{ symbol: 'AAPL', quantity: 1, averagePrice: 1 }] }),
      });
    });
    try {
      await page.goto('/');
      const trader = await signIn(page, 'trader');
      tokens.push(trader.token);
      await held.started;
      const blotter = new TradeBlotterPage(page);
      await expect(blotter.rows).toHaveCount(5);
      const created = await request.post('/api/orders', {
        headers: { Authorization: `Bearer ${trader.token}` },
        data: { symbol: 'SPY', side: 'BUY', quantity: 43, type: 'MARKET' },
      });
      expect(created.status()).toBe(201);
      const { order } = orderResponseSchema.parse(await created.json());
      await blotter.filter({ symbol: 'AAPL' });
      await expect(blotter.rows).toHaveCount(2);
      let bookReads = 0;
      await page.route('**/api/orders', async (route) => {
        if (route.request().method() !== 'GET' || bookReads++ !== 0) {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const { orders } = ordersResponseSchema.parse(await response.json());
        expect(orders).toHaveLength(6);
        expect(orders.map((candidate) => candidate.id)).toContain(order.id);
        earlierBook.signalStarted();
        await earlierBook.wait;
        await route.fulfill({ response });
      });
      await blotter.filter({ symbol: '' });
      await earlierBook.started;
      await page.getByLabel('Symbol', { exact: true }).selectOption('SPY');
      await page.getByLabel('Side', { exact: true }).selectOption('SELL');
      await page.getByLabel('Quantity', { exact: true }).fill('777');
      await page.getByLabel('Order type', { exact: true }).selectOption('LIMIT');
      await page.getByLabel('Limit price', { exact: true }).fill('0.001');
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      const viewer = await signIn(page, 'viewer');
      tokens.push(viewer.token);
      expect(viewer.token).not.toBe(trader.token);
      await expect(blotter.rows).toHaveCount(5);
      await expect(page.getByLabel('Symbol', { exact: true })).toHaveValue('AAPL');
      await expect(page.getByLabel('Side', { exact: true })).toHaveValue('BUY');
      await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('100');
      await expect(page.getByLabel('Order type', { exact: true })).toHaveValue('MARKET');
      await expect(page.getByLabel('Limit price', { exact: true })).toBeHidden();
      const overview = page.getByRole('tab', { name: 'Overview', exact: true });
      await expect(overview).toBeVisible();
      await overview.click();
      await expect(page.getByTestId('overview-total')).toHaveText('5');
      await expect(page.getByTestId('overview-working')).toHaveText('2');
      await expect(page.getByTestId('overview-positions')).toHaveText('4');
      await expect(page.getByTestId('overview-notional')).toHaveText('$270,522.50');
      const earlier = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/positions',
      );
      const staleBook = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/orders' &&
          response.request().method() === 'GET',
      );
      held.release();
      earlierBook.release();
      expect(await (await earlier).finished()).toBeNull();
      expect(await (await staleBook).finished()).toBeNull();
      await page.getByText(/SYNTHETIC \/ LOCAL$/).click();
      await expect(page.getByTestId('overview-total')).toHaveText('5');
      await expect(page.getByTestId('overview-working')).toHaveText('2');
      await expect(page.getByTestId('overview-positions')).toHaveText('4');
      await expect(page.getByTestId('overview-notional')).toHaveText('$270,522.50');
      await page.getByRole('tab', { name: 'Positions', exact: true }).click();
      const positions = page.getByRole('table', { name: 'Positions', exact: true });
      await expect(positions.getByRole('row')).toHaveCount(5);
      await expect(
        positions
          .getByRole('row')
          .filter({
            has: page.getByRole('cell', { name: 'AAPL', exact: true }),
          })
          .getByRole('cell'),
      ).toHaveText(['AAPL', '250', '$182.40']);
      await page.getByRole('tab', { name: 'Activity', exact: true }).click();
      const activity = page.getByRole('list', { name: 'Session activity', exact: true });
      await expect(activity.getByRole('listitem')).toHaveCount(1);
      await expect(activity).toContainText('Session opened: qa.viewer (viewer).');
      await expect(activity).not.toContainText('qa.user');
      await expect(activity).not.toContainText(order.id);
      await page.getByRole('tab', { name: 'Orders', exact: true }).click();
      await expect(blotter.rows).toHaveCount(5);
      await expect(blotter.row(order.id)).toHaveCount(0);
      expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBe(viewer.token);
    } finally {
      held.release();
      earlierBook.release();
      await releaseSessions(request, tokens);
    }
  },
);

test('a pending or failed first book read displays unavailable metrics rather than false zeroes', async ({
  authenticatedPage: page,
  tradeBlotterPage,
}) => {
  await expect(tradeBlotterPage.rows).toHaveCount(5);
  const held = responseGate();
  await page.route('**/api/orders', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const actual = await route.fetch();
    expect(actual.status()).toBe(200);
    expect(ordersResponseSchema.parse(await actual.json()).orders).toHaveLength(5);
    held.signalStarted();
    await held.wait;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'INTERNAL_ERROR', message: 'Controlled initial book failure.' },
      }),
    });
  });
  try {
    await page.reload();
    await held.started;
    await expect(page.locator('#orders-loading')).toBeVisible();
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    for (const id of ['overview-total', 'overview-working', 'overview-filled', 'overview-closed']) {
      await expect(page.getByTestId(id)).toHaveText('—');
    }
    await expect(page.getByTestId('overview-positions')).toHaveText('4');
    const failed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/orders',
    );
    held.release();
    expect((await failed).status()).toBe(500);
    await expect(page.getByRole('alert')).toHaveText('Controlled initial book failure.');
    for (const id of ['overview-total', 'overview-working', 'overview-filled', 'overview-closed']) {
      await expect(page.getByTestId(id)).toHaveText('—');
    }
  } finally {
    held.release();
  }
});
