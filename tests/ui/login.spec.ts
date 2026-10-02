import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/LoginPage.js';
import { ordersResponseSchema } from '../../app/domain/schemas.js';
import { credentials } from '../../test-data/fixtures/reference-data.js';

// These tests intentionally use built-in page/request/context, with no pre-auth fixture.
test('successful login opens the isolated order blotter', async ({ page, request }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.signIn(credentials.trader.username, credentials.trader.password);
  await expect(page.getByRole('heading', { name: 'Order blotter', exact: true })).toBeVisible();
  const token = await page.evaluate(() => localStorage.getItem('tradeflow.token'));
  expect(token).toBeTruthy();
  try {
    const response = await request.get('/api/orders', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status()).toBe(200);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Order blotter', exact: true })).toBeVisible();
  } finally {
    expect(
      (
        await request.delete('/api/session', {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status(),
    ).toBe(204);
  }
});

test('invalid login shows an error without exposing the blotter', async ({ page, context }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.signIn('qa.user', 'wrong-password');
  await expect(loginPage.alert).toHaveText('Invalid username or password.');
  await expect(page.getByRole('table', { name: 'Orders', exact: true })).toHaveCount(0);
  const state = await context.storageState();
  expect(
    state.origins
      .flatMap((origin) => origin.localStorage)
      .find((entry) => entry.name === 'tradeflow.token'),
  ).toBeUndefined();
});

test('a failed sign-out preserves the session before a successful sign-out revokes it', async ({
  page,
  request,
}) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.signIn(credentials.trader.username, credentials.trader.password);
  await expect(page.getByRole('heading', { name: 'Order blotter', exact: true })).toBeVisible();
  const token = await page.evaluate(() => localStorage.getItem('tradeflow.token'));
  expect(token).toBeTruthy();
  try {
    await page.route('**/api/session', async (route) => {
      if (route.request().method() === 'DELETE') await route.abort('failed');
      else await route.continue();
    });
    const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
    await signOut.click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('#api-state')).toHaveText('API: DELETE /api/session · no response');
    await expect(signOut).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('heading', { name: 'Order blotter', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBe(token);
    const stillOwned = await request.get('/api/orders', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(stillOwned.status()).toBe(200);
    expect(ordersResponseSchema.parse(await stillOwned.json()).orders).toHaveLength(5);
    await page.unroute('**/api/session');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(loginPage.signInButton).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('tradeflow.token'))).toBeNull();
    expect(
      (
        await request.get('/api/orders', {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status(),
    ).toBe(401);
  } finally {
    // Sign out already revokes the token. A failed UI logout is still cleaned up.
    const response = await request.delete('/api/session', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([204, 401]).toContain(response.status());
  }
});
