import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/LoginPage.js';
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

test('signing out removes browser auth state and returns to login', async ({ page, request }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.signIn(credentials.trader.username, credentials.trader.password);
  await expect(page.getByRole('heading', { name: 'Order blotter', exact: true })).toBeVisible();
  const token = await page.evaluate(() => localStorage.getItem('tradeflow.token'));
  expect(token).toBeTruthy();
  try {
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
