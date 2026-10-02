import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  errorResponseSchema,
  orderResponseSchema,
  ordersResponseSchema,
  positionsResponseSchema,
  sessionResponseSchema,
  type Order,
  type SessionResponse,
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

async function signIn(page: Page) {
  const received = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/session' && response.request().method() === 'POST',
  );
  await new LoginPage(page).signIn(credentials.trader.username, credentials.trader.password);
  return received;
}

async function releaseSessions(request: APIRequestContext, tokens: string[]): Promise<void> {
  for (const token of tokens) {
    const response = await request.delete('/api/session', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([204, 401], 'Every owned session must be released or already signed out').toContain(
      response.status(),
    );
  }
}

test('creation controls belong to the current session and its pending submission', async ({
  page,
  request,
}) => {
  const tokens: string[] = [];
  const earlier = responseGate();
  const current = responseGate();
  const gates = [earlier, current];
  const orders: Order[] = [];
  const statuses: number[] = [];
  let calls = 0;
  try {
    await page.goto('/');
    const login = await signIn(page);
    expect(login.status()).toBe(200);
    const firstSession = sessionResponseSchema.parse(await login.json());
    tokens.push(firstSession.token);
    const blotter = new TradeBlotterPage(page);
    const entry = new OrderEntryPage(page);
    await expect(blotter.rows).toHaveCount(5);
    await page.route('**/api/orders', async (route) => {
      if (route.request().method() !== 'POST') {
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
      orders.push(orderResponseSchema.parse(await response.json()).order);
      gate.signalStarted();
      await gate.wait;
      await route.fulfill({ response });
    });
    await entry.submit({ symbol: 'SPY', side: 'SELL', quantity: 61, type: 'MARKET' });
    await earlier.started;
    expect(statuses).toEqual([201]);
    expect(orders[0]).toMatchObject({ symbol: 'SPY', side: 'SELL', quantity: 61, status: 'NEW' });
    await expect(entry.submitButton).toBeDisabled();
    const logout = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/session' &&
        response.request().method() === 'DELETE',
    );
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    expect((await logout).status()).toBe(204);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    const nextLogin = await signIn(page);
    expect(nextLogin.status()).toBe(200);
    const secondSession = sessionResponseSchema.parse(await nextLogin.json());
    tokens.push(secondSession.token);
    expect(secondSession.token).not.toBe(firstSession.token);
    await expect(blotter.rows).toHaveCount(5);
    await expect(entry.submitButton).toBeEnabled();
    await entry.submit({ symbol: 'MSFT', side: 'BUY', quantity: 43, type: 'MARKET' });
    await current.started;
    expect(statuses).toEqual([201, 201]);
    const firstOrder = orders[0];
    const secondOrder = orders[1];
    expect(firstOrder).toBeDefined();
    expect(secondOrder).toBeDefined();
    if (!firstOrder || !secondOrder) throw new Error('Both sessions must create an owned order.');
    expect(secondOrder).toMatchObject({ symbol: 'MSFT', side: 'BUY', quantity: 43, status: 'NEW' });
    expect(secondOrder.id).not.toBe(firstOrder.id);
    await expect(entry.submitButton).toBeDisabled();
    const staleCreation = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/orders' &&
        response.request().method() === 'POST' &&
        response.request().headers()['authorization'] === `Bearer ${firstSession.token}`,
    );
    earlier.release();
    const staleResponse = await staleCreation;
    expect(staleResponse.status()).toBe(201);
    expect(await staleResponse.finished()).toBeNull();
    await page.getByText(/SYNTHETIC \/ LOCAL$/).click();
    await expect(entry.submitButton).toBeDisabled();
    expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBe(
      secondSession.token,
    );
    await expect(page.getByRole('region', { name: 'Order details', exact: true })).toBeHidden();
    const creation = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/orders' &&
        response.request().method() === 'POST' &&
        response.request().headers()['authorization'] === `Bearer ${secondSession.token}`,
    );
    current.release();
    const response = await creation;
    expect(response.status()).toBe(201);
    expect(await response.finished()).toBeNull();
    await expect(page.getByTestId('detail-id')).toHaveText(secondOrder.id);
    await expect(page.getByRole('status')).toHaveText('Order submitted.');
    await expect(entry.submitButton).toBeEnabled();
    const headers = { Authorization: `Bearer ${secondSession.token}` };
    const persisted = await request.get(`/api/orders/${secondOrder.id}`, { headers });
    expect(persisted.status()).toBe(200);
    expect(orderResponseSchema.parse(await persisted.json()).order).toEqual(secondOrder);
    const book = await request.get('/api/orders', { headers });
    expect(book.status()).toBe(200);
    const secondBook = ordersResponseSchema.parse(await book.json()).orders;
    expect(secondBook).toHaveLength(6);
    expect(secondBook.map((order) => order.id)).not.toContain(firstOrder.id);
    expect(secondBook.filter((order) => order.id === secondOrder.id)).toHaveLength(1);
  } finally {
    earlier.release();
    current.release();
    await releaseSessions(request, tokens);
  }
});

test('cancellation controls belong to the current session and its pending cancellation', async ({
  page,
  request,
}) => {
  const tokens: string[] = [];
  const earlier = responseGate();
  const current = responseGate();
  const gates = [earlier, current];
  const orders: Order[] = [];
  const statuses: number[] = [];
  let calls = 0;
  try {
    await page.goto('/');
    const login = await signIn(page);
    expect(login.status()).toBe(200);
    const firstSession = sessionResponseSchema.parse(await login.json());
    tokens.push(firstSession.token);
    const blotter = new TradeBlotterPage(page);
    const cancel = page.getByRole('button', { name: 'Cancel order', exact: true });
    await expect(blotter.rows).toHaveCount(5);
    await blotter.viewOrder(seedIds.newOrder);
    await expect(page.getByTestId('detail-id')).toHaveText(seedIds.newOrder);
    await expect(page.getByTestId('detail-status')).toHaveText('NEW');
    await page.route('**/api/orders/*/cancel', async (route) => {
      const gate = gates[calls++];
      if (!gate) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      statuses.push(response.status());
      orders.push(orderResponseSchema.parse(await response.json()).order);
      gate.signalStarted();
      await gate.wait;
      await route.fulfill({ response });
    });
    await cancel.click();
    await earlier.started;
    expect(statuses).toEqual([200]);
    expect(orders[0]).toMatchObject({ id: seedIds.newOrder, status: 'CANCELED' });
    await expect(cancel).toBeDisabled();
    const logout = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/session' &&
        response.request().method() === 'DELETE',
    );
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    expect((await logout).status()).toBe(204);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    const nextLogin = await signIn(page);
    expect(nextLogin.status()).toBe(200);
    const secondSession = sessionResponseSchema.parse(await nextLogin.json());
    tokens.push(secondSession.token);
    expect(secondSession.token).not.toBe(firstSession.token);
    await expect(blotter.rows).toHaveCount(5);
    await blotter.viewOrder(seedIds.partialOrder);
    await expect(page.getByTestId('detail-id')).toHaveText(seedIds.partialOrder);
    await expect(page.getByTestId('detail-status')).toHaveText('PARTIALLY_FILLED');
    await expect(cancel).toBeEnabled();
    await cancel.click();
    await current.started;
    expect(statuses).toEqual([200, 200]);
    expect(orders[1]).toMatchObject({ id: seedIds.partialOrder, status: 'CANCELED' });
    await expect(cancel).toBeDisabled();
    const staleCancellation = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/api/orders/${seedIds.newOrder}/cancel`,
    );
    earlier.release();
    const staleResponse = await staleCancellation;
    expect(staleResponse.status()).toBe(200);
    expect(await staleResponse.finished()).toBeNull();
    await page.getByText(/SYNTHETIC \/ LOCAL$/).click();
    await expect(cancel).toBeDisabled();
    expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBe(
      secondSession.token,
    );
    await expect(page.getByTestId('detail-id')).toHaveText(seedIds.partialOrder);
    await expect(page.getByTestId('detail-status')).toHaveText('PARTIALLY_FILLED');
    const cancellation = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/orders/${seedIds.partialOrder}/cancel`,
    );
    current.release();
    const response = await cancellation;
    expect(response.status()).toBe(200);
    expect(await response.finished()).toBeNull();
    await expect(page.getByTestId('detail-id')).toHaveText(seedIds.partialOrder);
    await expect(page.getByTestId('detail-status')).toHaveText('CANCELED');
    await expect(page.getByRole('status')).toHaveText('Order canceled.');
    await expect(cancel).toBeHidden();
    const headers = { Authorization: `Bearer ${secondSession.token}` };
    const selected = await request.get(`/api/orders/${seedIds.partialOrder}`, { headers });
    expect(selected.status()).toBe(200);
    expect(orderResponseSchema.parse(await selected.json()).order).toMatchObject({
      id: seedIds.partialOrder,
      status: 'CANCELED',
    });
    const independent = await request.get(`/api/orders/${seedIds.newOrder}`, { headers });
    expect(independent.status()).toBe(200);
    expect(orderResponseSchema.parse(await independent.json()).order).toMatchObject({
      id: seedIds.newOrder,
      status: 'NEW',
    });
    const book = await request.get('/api/orders', { headers });
    expect(book.status()).toBe(200);
    expect(ordersResponseSchema.parse(await book.json()).orders).toHaveLength(5);
  } finally {
    earlier.release();
    current.release();
    await releaseSessions(request, tokens);
  }
});

test('login controls belong to authentication rather than an earlier workspace read', async ({
  page,
  request,
}) => {
  const tokens: string[] = [];
  const earlierRead = responseGate();
  const currentLogin = responseGate();
  let positionReads = 0;
  let logins = 0;
  let earlierStatus = 0;
  let currentStatus = 0;
  let secondSession!: SessionResponse;
  try {
    await page.goto('/');
    await page.route('**/api/positions', async (route) => {
      if (route.request().method() !== 'GET' || positionReads++ !== 0) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      earlierStatus = response.status();
      positionsResponseSchema.parse(await response.json());
      earlierRead.signalStarted();
      await earlierRead.wait;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: 'Controlled earlier workspace failure.' },
        }),
      });
    });
    await page.route('**/api/session', async (route) => {
      if (route.request().method() !== 'POST' || logins++ !== 1) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      currentStatus = response.status();
      secondSession = sessionResponseSchema.parse(await response.json());
      tokens.push(secondSession.token);
      currentLogin.signalStarted();
      await currentLogin.wait;
      await route.fulfill({ response });
    });
    const login = await signIn(page);
    expect(login.status()).toBe(200);
    const firstSession = sessionResponseSchema.parse(await login.json());
    tokens.push(firstSession.token);
    await earlierRead.started;
    expect(earlierStatus).toBe(200);
    await expect(page.getByRole('heading', { name: 'Order blotter', exact: true })).toBeVisible();
    const logout = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/session' &&
        response.request().method() === 'DELETE',
    );
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    expect((await logout).status()).toBe(204);
    const loginButton = page.getByRole('button', { name: 'Sign in', exact: true });
    await expect(loginButton).toBeVisible();
    await expect(loginButton).toBeEnabled();
    const nextLogin = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/session' &&
        response.request().method() === 'POST',
    );
    await new LoginPage(page).signIn(credentials.trader.username, credentials.trader.password);
    await currentLogin.started;
    expect(currentStatus).toBe(200);
    expect(secondSession.user).toEqual({ username: 'qa.user', role: 'trader' });
    expect(secondSession.token).not.toBe(firstSession.token);
    await expect(loginButton).toBeDisabled();
    const earlier = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/positions' &&
        response.request().method() === 'GET',
    );
    earlierRead.release();
    const response = await earlier;
    expect(response.status()).toBe(500);
    expect(errorResponseSchema.parse(await response.json()).error.code).toBe('INTERNAL_ERROR');
    expect(await response.finished()).toBeNull();
    await page.getByText(/SYNTHETIC \/ LOCAL$/).click();
    await expect(loginButton).toBeDisabled();
    await expect(page.getByRole('alert')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBeNull();
    currentLogin.release();
    const currentResponse = await nextLogin;
    expect(currentResponse.status()).toBe(200);
    expect(sessionResponseSchema.parse(await currentResponse.json())).toEqual(secondSession);
    expect(await currentResponse.finished()).toBeNull();
    const blotter = new TradeBlotterPage(page);
    await expect(blotter.rows).toHaveCount(5);
    expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBe(
      secondSession.token,
    );
    await expect(page.getByText('qa.user · trader', { exact: true })).toBeVisible();
    await expect(
      page.locator('#login-form').getByRole('button', { includeHidden: true }),
    ).toBeEnabled();
    await expect(page.getByRole('alert')).toBeHidden();
    const headers = { Authorization: `Bearer ${secondSession.token}` };
    const session = await request.get('/api/session', { headers });
    expect(session.status()).toBe(200);
    const sessionBody: unknown = await session.json();
    expect(sessionBody).toEqual({ user: { username: 'qa.user', role: 'trader' } });
    const book = await request.get('/api/orders', { headers });
    expect(book.status()).toBe(200);
    expect(ordersResponseSchema.parse(await book.json()).orders).toHaveLength(5);
  } finally {
    earlierRead.release();
    currentLogin.release();
    await releaseSessions(request, tokens);
  }
});
