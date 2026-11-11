import { expect } from '@playwright/test';
import { test } from '../fixtures/tradeflow.fixture.js';

test('zero analytics is explicitly nontradable and named curves display server-validated marks', async ({
  authenticatedPage: page,
}) => {
  await page.getByText('Fixed-income analytics', { exact: true }).click();
  await page.locator('#fi-form select[name=instrument_id]').selectOption('SYN-ZERO-2031');
  await page.getByLabel('Settlement date', { exact: true }).fill('2030-01-15');
  await page.getByLabel('Par amount USD', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Calculate analytics', exact: true }).click();
  await expect(page.getByTestId('fi-results')).toContainText('Analytics only');
  await expect(page.getByTestId('fi-results')).toContainText('ZERO_SIMPLE_ACT365F_V1');
  await expect(page.getByTestId('fi-results')).toContainText(
    'Accrued interest per 100 par: 0.0000000000',
  );
  await expect(page.locator('#rfq-form option[value="SYN-ZERO-2031"]')).toHaveCount(0);
  await page.getByLabel('Curve fixture', { exact: true }).selectOption('FLAT_V1');
  await page.getByRole('button', { name: 'Calculate curve mark', exact: true }).click();
  await expect(page.getByTestId('curve-results')).toContainText('FLAT_V1');
  await expect(page.getByTestId('curve-results')).toContainText('Economic as-of date: 2030-01-15');
  await expect(page.getByTestId('curve-results')).toContainText(
    'Continuous z-spread: 0.000000000000',
  );
  await expect(page.getByTestId('curve-results')).toContainText('USD mark');
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const instrument = page.locator('#fi-form select[name=instrument_id]');
  await instrument.focus();
  await expect(instrument).toBeFocused();
  await instrument.press('Home');
  await instrument.press('ArrowDown');
  await instrument.press('Enter');
  await expect(instrument).toHaveValue('SYN-CORP-2031');
  // Enter opens the native popup in Chromium; close it before testing Tab traversal.
  await instrument.press('Escape');
  await expect(instrument).toHaveValue('SYN-CORP-2031');
  await instrument.press('Tab');
  await expect(page.getByLabel('Settlement date', { exact: true })).toBeFocused();
});

test('malformed curve HTTP200 is never displayed as a mark', async ({
  authenticatedPage: page,
}) => {
  await page.route('**/api/fixed-income/v3/analytics?**', (route) =>
    route.fulfill({ status: 200, json: { mark_value_usd: '0.00' } }),
  );
  await page.getByText('Fixed-income analytics', { exact: true }).click();
  await page.getByRole('button', { name: 'Calculate curve mark', exact: true }).click();
  await expect(page.getByTestId('curve-error')).toContainText('expected contract');
  await expect(page.getByTestId('curve-results')).toBeEmpty();
});

test('a valid curve response for a different named fixture is rejected', async ({
  authenticatedPage: page,
}) => {
  await page.route('**/api/fixed-income/v3/analytics?**', async (route) => {
    const target = new URL(route.request().url());
    target.searchParams.set('fixture_id', 'FLAT_V1');
    const response = await route.fetch({ url: target.href });
    await route.fulfill({ response });
  });
  await page.getByText('Fixed-income analytics', { exact: true }).click();
  await page.getByRole('button', { name: 'Calculate curve mark', exact: true }).click();
  await expect(page.getByTestId('curve-error')).toContainText('expected contract');
  await expect(page.getByTestId('curve-results')).toBeEmpty();
});

test('a valid coupon response for another instrument is rejected', async ({
  authenticatedPage: page,
}) => {
  await page.route('**/api/fixed-income/v1/analytics?**', async (route) => {
    const target = new URL(route.request().url());
    target.searchParams.set('instrument_id', 'SYN-CORP-2031');
    const response = await route.fetch({ url: target.href });
    await route.fulfill({ response });
  });
  await page.getByText('Fixed-income analytics', { exact: true }).click();
  await page.getByRole('button', { name: 'Calculate analytics', exact: true }).click();
  await expect(page.getByTestId('fi-error')).toContainText('expected contract');
  await expect(page.getByTestId('fi-results')).toBeEmpty();
});
