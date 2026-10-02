import { test, expect } from '@playwright/test';
import {
  errorResponseSchema,
  orderResponseSchema,
  ordersResponseSchema,
  sessionResponseSchema,
} from '../../app/domain/schemas.js';
import { LoginPage } from '../../pages/LoginPage.js';
import { OrderEntryPage } from '../../pages/OrderEntryPage.js';
import { TradeBlotterPage } from '../../pages/TradeBlotterPage.js';
import { credentials } from '../../test-data/fixtures/reference-data.js';

test('a newer session never displays the prior book while its order list is pending or fails', async ({
  page,
  request,
}) => {
  const tokens: string[] = [];
  let release!: () => void;
  let signalStarted!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let viewerListStatus = 0;
  let viewerListBody: unknown;
  let viewerAuthorization: string | undefined;
  try {
    const loginPage = new LoginPage(page);
    const blotter = new TradeBlotterPage(page);
    await loginPage.goto();
    const traderLogin = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/session' &&
        response.request().method() === 'POST',
    );
    await loginPage.signIn(credentials.trader.username, credentials.trader.password);
    const traderResponse = await traderLogin;
    expect(traderResponse.status()).toBe(200);
    const trader = sessionResponseSchema.parse(await traderResponse.json());
    tokens.push(trader.token);
    expect(trader.user).toEqual({ username: 'qa.user', role: 'trader' });
    await expect(blotter.rows).toHaveCount(5);

    const creation = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/orders' &&
        response.request().method() === 'POST',
    );
    await new OrderEntryPage(page).submit({
      symbol: 'SPY',
      side: 'SELL',
      quantity: 61,
      type: 'MARKET',
    });
    const createdResponse = await creation;
    expect(createdResponse.status()).toBe(201);
    const { order } = orderResponseSchema.parse(await createdResponse.json());
    expect(order.id).not.toBe('');
    expect(order).toMatchObject({
      symbol: 'SPY',
      side: 'SELL',
      quantity: 61,
      type: 'MARKET',
      status: 'NEW',
    });
    expect(order).not.toHaveProperty('limitPrice');
    await expect(page.getByRole('status')).toHaveText('Order submitted.');
    await expect(blotter.rows).toHaveCount(6);
    await expect(blotter.row(order.id)).toBeVisible();
    const persisted = await request.get(`/api/orders/${order.id}`, {
      headers: { Authorization: `Bearer ${trader.token}` },
    });
    expect(persisted.status()).toBe(200);
    expect(orderResponseSchema.parse(await persisted.json()).order).toEqual(order);

    const logout = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/session' &&
        response.request().method() === 'DELETE',
    );
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    expect((await logout).status()).toBe(204);
    await expect(loginPage.signInButton).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBeNull();

    await page.route('**/api/orders', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      viewerAuthorization = route.request().headers()['authorization'];
      const actual = await route.fetch();
      viewerListStatus = actual.status();
      viewerListBody = await actual.json();
      signalStarted();
      await held;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: 'Controlled viewer order-list failure.' },
        }),
      });
    });
    const viewerLogin = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/session' &&
        response.request().method() === 'POST',
    );
    await loginPage.signIn(credentials.viewer.username, credentials.viewer.password);
    const viewerResponse = await viewerLogin;
    expect(viewerResponse.status()).toBe(200);
    const viewer = sessionResponseSchema.parse(await viewerResponse.json());
    tokens.push(viewer.token);
    expect(viewer.user).toEqual({ username: 'qa.viewer', role: 'viewer' });
    expect(viewer.token).not.toBe(trader.token);
    await started;
    expect(viewerAuthorization).toBe(`Bearer ${viewer.token}`);
    expect(viewerListStatus).toBe(200);
    const viewerBook = ordersResponseSchema.parse(viewerListBody);
    expect(viewerBook.orders).toHaveLength(5);
    expect(viewerBook.orders.map((candidate) => candidate.id)).not.toContain(order.id);

    await expect(page.getByText('qa.viewer · viewer', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit order', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit order', exact: true })).toBeDisabled();
    await expect(blotter.row(order.id)).toHaveCount(0);
    await expect(blotter.rows).toHaveCount(0);

    const failedList = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/orders' && response.request().method() === 'GET',
    );
    release();
    const failedResponse = await failedList;
    expect(failedResponse.status()).toBe(500);
    expect(errorResponseSchema.parse(await failedResponse.json()).error.code).toBe(
      'INTERNAL_ERROR',
    );
    await expect(page.getByRole('alert')).toHaveText('Controlled viewer order-list failure.');
    expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBe(viewer.token);
    await expect(page.getByText('qa.viewer · viewer', { exact: true })).toBeVisible();
    await expect(blotter.row(order.id)).toHaveCount(0);
    await expect(blotter.rows).toHaveCount(0);

    const headers = { Authorization: `Bearer ${viewer.token}` };
    const currentSession = await request.get('/api/session', { headers });
    expect(currentSession.status()).toBe(200);
    expect(
      sessionResponseSchema
        .pick({ user: true })
        .strict()
        .parse(await currentSession.json()),
    ).toEqual({
      user: { username: 'qa.viewer', role: 'viewer' },
    });
    const currentBook = await request.get('/api/orders', { headers });
    expect(currentBook.status()).toBe(200);
    expect(ordersResponseSchema.parse(await currentBook.json())).toEqual(viewerBook);
  } finally {
    release();
    for (const ownedToken of tokens) {
      const cleanup = await request.delete('/api/session', {
        headers: { Authorization: `Bearer ${ownedToken}` },
      });
      expect([204, 401], 'An owned session must be released or already signed out').toContain(
        cleanup.status(),
      );
    }
  }
});
