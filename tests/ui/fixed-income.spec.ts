import { test as base, expect } from '@playwright/test';
import { test } from '../fixtures/tradeflow.fixture.js';

test('bond analytics shows exact golden values and explicit financial units', async ({
  authenticatedPage: page,
}) => {
  await page.getByText('Fixed-income analytics', { exact: true }).click();
  await page.getByLabel('Clean price per 100 par').fill('99.875');
  await page.getByRole('button', { name: 'Calculate analytics' }).click();
  await expect(page.getByTestId('fi-results')).toContainText(
    'Accrued interest per 100 par: 1.0000000000',
  );
  await expect(page.getByTestId('fi-results')).toContainText('Consideration USD: 1008750.00');
  await expect(page.getByTestId('fi-results')).toContainText('ACT_ACT_ICMA');
  await expect(page.getByTestId('fi-results')).toContainText('ROUND_HALF_EVEN');
  await page.getByLabel('Settlement date').fill('2031-01-15');
  await page.getByRole('button', { name: 'Calculate analytics' }).click();
  await expect(page.getByTestId('fi-error')).toContainText('Invalid fixed-income query');
  await expect(page.getByTestId('fi-results')).toBeEmpty();
});
test('a malformed HTTP200 analytical response is rejected', async ({ authenticatedPage: page }) => {
  await page.route('**/api/fixed-income/v1/analytics?**', (r) =>
    r.fulfill({ status: 200, json: { dirty_price: 100 } }),
  );
  await page.getByText('Fixed-income analytics', { exact: true }).click();
  await page.getByRole('button', { name: 'Calculate analytics' }).click();
  await expect(page.getByTestId('fi-error')).toContainText('expected contract');
  await expect(page.getByTestId('fi-results')).toBeEmpty();
});
base(
  'viewer may calculate and delayed prior-session results cannot populate its workspace',
  async ({ page }) => {
    const login = async (name: string) => {
      await page.getByLabel('Username', { exact: true }).fill(name);
      await page.getByLabel('Password', { exact: true }).fill('Password123!');
      await page.getByRole('button', { name: 'Sign in', exact: false }).click();
      await expect(page.getByRole('heading', { name: 'Order blotter', exact: true })).toBeVisible();
    };
    await page.goto('/');
    await login('qa.user');
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let observed = () => {};
    const arrived = new Promise<void>((r) => {
      observed = r;
    });
    await page.route('**/api/fixed-income/v1/analytics?**', async (route) => {
      const response = await route.fetch();
      observed();
      await gate;
      await route.fulfill({ response });
    });
    try {
      await page.getByText('Fixed-income analytics', { exact: true }).click();
      await page.getByRole('button', { name: 'Calculate analytics' }).click();
      await arrived;
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await login('qa.viewer');
      release();
      await page.unrouteAll({ behavior: 'wait' });
      await expect(page.getByTestId('fi-results')).toBeEmpty();
      await page.getByText('Fixed-income analytics', { exact: true }).click();
      await page.getByLabel('Annual yield (decimal fraction)').fill('-0.01');
      await page.getByLabel('Clean price per 100 par').fill('');
      await page.getByRole('button', { name: 'Calculate analytics' }).click();
      await expect(page.getByTestId('fi-results')).toContainText('Annual yield: -0.010000000000');
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    } finally {
      release();
    }
  },
);
