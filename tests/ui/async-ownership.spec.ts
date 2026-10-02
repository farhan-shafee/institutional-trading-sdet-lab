import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  errorResponseSchema,
  orderResponseSchema,
  ordersResponseSchema,
  sessionResponseSchema,
} from '../../app/domain/schemas.js';
import { LoginPage } from '../../pages/LoginPage.js';
import { OrderEntryPage } from '../../pages/OrderEntryPage.js';
import { TradeBlotterPage } from '../../pages/TradeBlotterPage.js';
import { credentials, seedIds } from '../../test-data/fixtures/reference-data.js';

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
  return received;
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

for (const status of [201, 500] as const) {
  test(`a stale creation ${status} cannot affect a newer viewer session`, async ({
    page,
    request,
  }) => {
    const tokens: string[] = [];
    const held = responseGate();
    let createdId = '';
    let creationStatus = 0;
    try {
      await page.goto('/');
      const login = await signIn(page, 'trader');
      expect(login.status()).toBe(200);
      const trader = sessionResponseSchema.parse(await login.json());
      tokens.push(trader.token);
      const blotter = new TradeBlotterPage(page);
      await expect(blotter.rows).toHaveCount(5);
      await page.route('**/api/orders', async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        creationStatus = response.status();
        createdId = orderResponseSchema.parse(await response.json()).order.id;
        held.signalStarted();
        await held.wait;
        if (status === 201) {
          await route.fulfill({ response });
        } else {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'INTERNAL_ERROR', message: 'Controlled earlier creation failure.' },
            }),
          });
        }
      });
      await new OrderEntryPage(page).submit({
        symbol: 'SPY',
        side: 'BUY',
        quantity: 43,
        type: 'MARKET',
      });
      await held.started;
      expect(creationStatus).toBe(201);
      expect(createdId).not.toBe('');
      await expect(page.getByRole('button', { name: 'Submit order', exact: true })).toBeDisabled();
      const created = await request.get(`/api/orders/${createdId}`, {
        headers: { Authorization: `Bearer ${trader.token}` },
      });
      expect(created.status()).toBe(200);
      expect(orderResponseSchema.parse(await created.json()).order).toMatchObject({
        id: createdId,
        symbol: 'SPY',
        quantity: 43,
        status: 'NEW',
      });
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      const viewerLogin = await signIn(page, 'viewer');
      expect(viewerLogin.status()).toBe(200);
      const viewer = sessionResponseSchema.parse(await viewerLogin.json());
      tokens.push(viewer.token);
      expect(viewer.token).not.toBe(trader.token);
      await expect(blotter.rows).toHaveCount(5);
      await blotter.filter({ symbol: 'MSFT' });
      await expect(blotter.rows).toHaveCount(1);
      await expect(blotter.row(seedIds.partialOrder)).toBeVisible();
      const earlier = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/orders' &&
          response.request().method() === 'POST',
      );
      held.release();
      const response = await earlier;
      expect(response.status()).toBe(status);
      expect(await response.finished()).toBeNull();
      await expect(
        page.getByRole('button', { name: 'Submit order', exact: true, includeHidden: true }),
      ).toBeEnabled();
      await page.getByText(/SYNTHETIC \/ LOCAL$/).click();
      expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBe(viewer.token);
      await expect(page.getByText('qa.viewer · viewer', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Submit order', exact: true })).toBeHidden();
      await expect(page.getByRole('region', { name: 'Order details', exact: true })).toBeHidden();
      await expect(page.getByRole('status')).toBeHidden();
      await expect(page.getByRole('alert')).toBeHidden();
      await expect(page.getByLabel('Filter symbol', { exact: true })).toHaveValue('MSFT');
      await expect(blotter.rows).toHaveCount(1);
      const book = await request.get('/api/orders', {
        headers: { Authorization: `Bearer ${viewer.token}` },
      });
      expect(book.status()).toBe(200);
      const { orders } = ordersResponseSchema.parse(await book.json());
      expect(orders).toHaveLength(5);
      expect(orders.map((order) => order.id)).not.toContain(createdId);
    } finally {
      held.release();
      await releaseSessions(request, tokens);
    }
  });
}

test('a delayed logout 204 cannot clear a login after the revoked token receives 401', async ({
  page,
  request,
}) => {
  const tokens: string[] = [];
  const held = responseGate();
  let logoutStatus = 0;
  try {
    await page.goto('/');
    const login = await signIn(page, 'trader');
    expect(login.status()).toBe(200);
    const trader = sessionResponseSchema.parse(await login.json());
    tokens.push(trader.token);
    const blotter = new TradeBlotterPage(page);
    await expect(blotter.rows).toHaveCount(5);
    await page.route('**/api/session', async (route) => {
      if (route.request().method() !== 'DELETE') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      logoutStatus = response.status();
      held.signalStarted();
      await held.wait;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await held.started;
    expect(logoutStatus).toBe(204);
    const unauthorized = page.waitForResponse(
      (response) => new URL(response.url()).search === '?symbol=MSFT',
    );
    await blotter.filter({ symbol: 'MSFT' });
    const rejected = await unauthorized;
    expect(rejected.status()).toBe(401);
    expect(errorResponseSchema.parse(await rejected.json()).error.code).toBe('UNAUTHORIZED');
    expect(await rejected.finished()).toBeNull();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    const viewerLogin = await signIn(page, 'viewer');
    expect(viewerLogin.status()).toBe(200);
    const viewer = sessionResponseSchema.parse(await viewerLogin.json());
    tokens.push(viewer.token);
    expect(viewer.token).not.toBe(trader.token);
    await expect(blotter.rows).toHaveCount(1);
    const earlier = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/session' &&
        response.request().method() === 'DELETE',
    );
    held.release();
    const response = await earlier;
    expect(response.status()).toBe(204);
    // Sign out consumes response headers. These routed DELETE responses did
    // not report Chromium request completion during reproduction; the UI
    // action lets the browser process headers before the session assertion.
    await page.getByText(/SYNTHETIC \/ LOCAL$/).click();
    expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBe(viewer.token);
    await expect(page.getByText('qa.viewer · viewer', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit order', exact: true })).toBeHidden();
    await expect(page.getByRole('alert')).toBeHidden();
    const headers = { Authorization: `Bearer ${viewer.token}` };
    const session = await request.get('/api/session', { headers });
    expect(session.status()).toBe(200);
    const sessionBody: unknown = await session.json();
    expect(sessionBody).toEqual({ user: { username: 'qa.viewer', role: 'viewer' } });
    const book = await request.get('/api/orders', { headers });
    expect(book.status()).toBe(200);
    expect(ordersResponseSchema.parse(await book.json()).orders).toHaveLength(5);
  } finally {
    held.release();
    await releaseSessions(request, tokens);
  }
});

test('a delayed second logout 401 cannot clear a newer viewer login', async ({ page, request }) => {
  const tokens: string[] = [];
  const first = responseGate();
  const second = responseGate();
  const gates = [first, second];
  const statuses: number[] = [];
  let secondErrorCode = '';
  let calls = 0;
  try {
    await page.goto('/');
    const login = await signIn(page, 'trader');
    expect(login.status()).toBe(200);
    const trader = sessionResponseSchema.parse(await login.json());
    tokens.push(trader.token);
    const blotter = new TradeBlotterPage(page);
    await expect(blotter.rows).toHaveCount(5);
    await page.route('**/api/session', async (route) => {
      if (route.request().method() !== 'DELETE') {
        await route.continue();
        return;
      }
      const gate = gates[calls++];
      if (!gate) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      statuses.push(response.status());
      if (response.status() === 401)
        secondErrorCode = errorResponseSchema.parse(await response.json()).error.code;
      gate.signalStarted();
      await gate.wait;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await first.started;
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await second.started;
    expect(statuses).toEqual([204, 401]);
    const firstResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/session' &&
        response.request().method() === 'DELETE',
    );
    first.release();
    expect((await firstResponse).status()).toBe(204);
    // The login control is the observable completion of this empty 204.
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    const viewerLogin = await signIn(page, 'viewer');
    expect(viewerLogin.status()).toBe(200);
    const viewer = sessionResponseSchema.parse(await viewerLogin.json());
    tokens.push(viewer.token);
    expect(viewer.token).not.toBe(trader.token);
    await expect(blotter.rows).toHaveCount(5);
    const earlier = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/session' &&
        response.request().method() === 'DELETE',
    );
    second.release();
    const response = await earlier;
    expect(response.status()).toBe(401);
    expect(secondErrorCode).toBe('UNAUTHORIZED');
    // Sign out consumes only headers. Validate the real 401 body above from
    // route.fetch(), then inspect the browser's status and session state.
    await page.getByText(/SYNTHETIC \/ LOCAL$/).click();
    expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBe(viewer.token);
    await expect(page.getByText('qa.viewer · viewer', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit order', exact: true })).toBeHidden();
    await expect(page.getByRole('alert')).toBeHidden();
    const headers = { Authorization: `Bearer ${viewer.token}` };
    const session = await request.get('/api/session', { headers });
    expect(session.status()).toBe(200);
    const sessionBody: unknown = await session.json();
    expect(sessionBody).toEqual({ user: { username: 'qa.viewer', role: 'viewer' } });
    const book = await request.get('/api/orders', { headers });
    expect(book.status()).toBe(200);
    expect(ordersResponseSchema.parse(await book.json()).orders).toHaveLength(5);
  } finally {
    first.release();
    second.release();
    await releaseSessions(request, tokens);
  }
});

test('a superseded filter failure cannot obscure newer matching orders', async ({
  page,
  request,
}) => {
  const tokens: string[] = [];
  const held = responseGate();
  let earlierStatus = 0;
  try {
    await page.goto('/');
    const login = await signIn(page, 'trader');
    expect(login.status()).toBe(200);
    const trader = sessionResponseSchema.parse(await login.json());
    tokens.push(trader.token);
    const blotter = new TradeBlotterPage(page);
    await expect(blotter.rows).toHaveCount(5);
    await page.route('**/api/orders?symbol=AAPL', async (route) => {
      const response = await route.fetch();
      earlierStatus = response.status();
      ordersResponseSchema.parse(await response.json());
      held.signalStarted();
      await held.wait;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: 'Controlled earlier filter failure.' },
        }),
      });
    });
    await blotter.filter({ symbol: 'AAPL' });
    await held.started;
    expect(earlierStatus).toBe(200);
    const current = page.waitForResponse(
      (response) => new URL(response.url()).search === '?symbol=MSFT',
    );
    await blotter.filter({ symbol: 'MSFT' });
    const currentResponse = await current;
    expect(currentResponse.status()).toBe(200);
    expect(await currentResponse.finished()).toBeNull();
    await expect(blotter.rows).toHaveCount(1);
    await expect(blotter.row(seedIds.partialOrder)).toBeVisible();
    const earlier = page.waitForResponse(
      (response) => new URL(response.url()).search === '?symbol=AAPL',
    );
    held.release();
    const response = await earlier;
    expect(response.status()).toBe(500);
    expect(await response.finished()).toBeNull();
    await page.getByText(/SYNTHETIC \/ LOCAL$/).click();
    await expect(page.getByRole('alert')).toBeHidden();
    await expect(page.getByLabel('Filter symbol', { exact: true })).toHaveValue('MSFT');
    await expect(blotter.rows).toHaveCount(1);
    await expect(blotter.row(seedIds.partialOrder)).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBe(trader.token);
    const book = await request.get('/api/orders', {
      headers: { Authorization: `Bearer ${trader.token}` },
    });
    expect(book.status()).toBe(200);
    expect(ordersResponseSchema.parse(await book.json()).orders).toHaveLength(5);
  } finally {
    held.release();
    await releaseSessions(request, tokens);
  }
});

test('a committed creation retains its details and success when the list refresh fails', async ({
  page,
  request,
}) => {
  const tokens: string[] = [];
  const held = responseGate();
  let refreshStatus = 0;
  try {
    await page.goto('/');
    const login = await signIn(page, 'trader');
    expect(login.status()).toBe(200);
    const trader = sessionResponseSchema.parse(await login.json());
    tokens.push(trader.token);
    const blotter = new TradeBlotterPage(page);
    await expect(blotter.rows).toHaveCount(5);
    await page.route('**/api/orders', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      refreshStatus = response.status();
      ordersResponseSchema.parse(await response.json());
      held.signalStarted();
      await held.wait;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: 'Controlled order refresh failure.' },
        }),
      });
    });
    const committed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/orders' &&
        response.request().method() === 'POST',
    );
    await new OrderEntryPage(page).submit({
      symbol: 'SPY',
      side: 'BUY',
      quantity: 43,
      type: 'MARKET',
    });
    const created = await committed;
    expect(created.status()).toBe(201);
    const { order } = orderResponseSchema.parse(await created.json());
    await held.started;
    expect(refreshStatus).toBe(200);
    const headers = { Authorization: `Bearer ${trader.token}` };
    const persisted = await request.get(`/api/orders/${order.id}`, { headers });
    expect(persisted.status()).toBe(200);
    expect(orderResponseSchema.parse(await persisted.json()).order).toMatchObject({
      id: order.id,
      symbol: 'SPY',
      side: 'BUY',
      quantity: 43,
      type: 'MARKET',
      status: 'NEW',
    });
    const failedRefresh = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/orders' && response.request().method() === 'GET',
    );
    held.release();
    const response = await failedRefresh;
    expect(response.status()).toBe(500);
    expect(await response.finished()).toBeNull();
    await expect(page.getByRole('alert')).toHaveText('Controlled order refresh failure.');
    await expect(page.getByTestId('detail-id')).toHaveText(order.id);
    await expect(page.getByTestId('detail-status')).toHaveText('NEW');
    await expect(page.getByRole('status')).toHaveText('Order submitted.');
    await expect(page.getByRole('button', { name: 'Submit order', exact: true })).toBeEnabled();
    const book = await request.get('/api/orders', { headers });
    expect(book.status()).toBe(200);
    const { orders } = ordersResponseSchema.parse(await book.json());
    expect(orders).toHaveLength(6);
    expect(orders.filter((candidate) => candidate.id === order.id)).toHaveLength(1);
  } finally {
    held.release();
    await releaseSessions(request, tokens);
  }
});
