import { test, expect } from '@playwright/test';
import { publicHttp } from '../public-demo/http-fixture.js';
import { connection } from '../public-demo/database.js';

test('public visitor reaches exact bond analytics, dealer execution ledger and clean reconciliation through the UI', async ({
  page,
}) => {
  const f = await publicHttp();
  try {
    await page.goto(f.origin);
    await page.getByLabel('Username', { exact: true }).fill('qa.user');
    await page.getByLabel('Password', { exact: true }).fill('Password123!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByText('Fixed-income analytics', { exact: true }).click();
    await page.getByLabel('Clean price per 100 par').fill('99.875');
    await page.getByRole('button', { name: 'Calculate analytics', exact: true }).click();
    await expect(page.getByTestId('fi-results')).toContainText(
      'Accrued interest per 100 par: 1.0000000000',
    );
    await expect(page.getByTestId('fi-results')).toContainText('Consideration USD: 1008750.00');
    await page.getByText('Dealer RFQ workstation', { exact: true }).click();
    await page.getByRole('button', { name: 'Start private workspace', exact: true }).click();
    await expect(page.getByTestId('rfq-status')).toHaveText('Private demo workspace ready.');
    await expect(page.getByLabel('Authorized sandbox UUID')).toBeHidden();
    await page.getByLabel('RFQ par amount USD').fill('100.00');
    await page.getByLabel('RFQ settlement (unadjusted)').fill('2028-01-15');
    await page.getByRole('button', { name: 'Send RFQ', exact: true }).click();
    await page.getByRole('button', { name: 'Request ATLAS quote', exact: true }).click();
    await page.getByRole('button', { name: 'Accept ATLAS quote', exact: true }).click();
    await expect(page.getByTestId('rfq-order')).toContainText('100.050000000123');
    await page.getByRole('button', { name: 'Simulate order acknowledgment', exact: true }).click();
    await page.getByLabel('Execution par USD', { exact: true }).fill('40.00');
    await page.getByRole('button', { name: 'Simulate execution', exact: true }).click();
    await expect(page.getByTestId('fi-order-lifecycle')).toContainText('PARTIALLY_FILLED');
    await page.getByRole('button', { name: 'Request order cancellation', exact: true }).click();
    await page
      .getByRole('button', { name: 'Simulate cancellation acknowledgment', exact: true })
      .click();
    await expect(page.getByTestId('fi-order-lifecycle')).toContainText('CANCELED');
    await expect(page.getByTestId('fi-order-lifecycle')).toContainText('filled par 40.00');
    await expect(page.getByTestId('fi-order-executions')).toContainText('4002');
    await expect(page.getByTestId('fi-execution-positions')).toContainText(
      'signed execution cash USD cents -4002',
    );
    const reader = await connection('reconciler');
    try {
      expect(
        (await reader.query('SELECT par_amount::text,consideration_cents::text FROM fi.executions'))
          .rows,
      ).toEqual([{ par_amount: '40.00', consideration_cents: '4002' }]);
    } finally {
      await reader.end();
    }
    await page.getByRole('button', { name: 'Request reconciliation', exact: true }).click();
    await expect(page.locator('#recon-summary')).toContainText('COMPLETED_CLEAN');
    await expect(page.getByText('Offline FIX evidence', { exact: true })).toBeVisible();
  } finally {
    await f.close();
  }
});

test('public viewer creates a private read-only workspace without native ownership input', async ({
  page,
}) => {
  const f = await publicHttp();
  try {
    await page.goto(f.origin);
    await page.getByLabel('Username', { exact: true }).fill('qa.viewer');
    await page.getByLabel('Password', { exact: true }).fill('Password123!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByText('Dealer RFQ workstation', { exact: true }).click();
    await page.getByRole('button', { name: 'Start private workspace', exact: true }).click();
    await expect(page.getByTestId('rfq-status')).toHaveText('Private demo workspace ready.');
    await expect(page.getByRole('button', { name: 'Send RFQ', exact: true })).toBeDisabled();
    await expect(page.getByLabel('Authorized sandbox UUID')).toBeHidden();
    await expect(page.locator('#public-workspace-policy')).toContainText('60 minutes');
    await expect(page.locator('#public-workspace-policy')).toContainText('original session');
  } finally {
    await f.close();
  }
});

test('public browser reload reopens its existing workspace without allocating another sandbox', async ({
  page,
}) => {
  const f = await publicHttp();
  try {
    await page.goto(f.origin);
    await page.getByLabel('Username', { exact: true }).fill('qa.user');
    await page.getByLabel('Password', { exact: true }).fill('Password123!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByText('Dealer RFQ workstation', { exact: true }).click();
    await page.getByRole('button', { name: 'Start private workspace', exact: true }).click();
    await expect(page.getByTestId('rfq-status')).toHaveText('Private demo workspace ready.');
    const before = await page.locator('#public-workspace-id').innerText();
    await page.reload();
    await page.getByText('Dealer RFQ workstation', { exact: true }).click();
    await expect(page.locator('#public-workspace-id')).toHaveText(before);
    await expect(page.getByTestId('rfq-status')).toHaveText('Private demo workspace ready.');
    const admin = await connection('admin');
    try {
      expect(
        (await admin.query<{ count: number }>('SELECT count(*)::int AS count FROM fi.sandboxes'))
          .rows[0]!.count,
      ).toBe(1);
    } finally {
      await admin.end();
    }
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('public workspace setup stops before HTTP when its idempotency journal cannot be retained', async ({
  page,
}) => {
  const f = await publicHttp();
  let posted = 0;
  try {
    await page.goto(f.origin);
    await page.getByLabel('Username', { exact: true }).fill('qa.user');
    await page.getByLabel('Password', { exact: true }).fill('Password123!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByText('Dealer RFQ workstation', { exact: true }).click();
    await page.route('**/api/public-demo/workspace', async (route) => {
      if (route.request().method() === 'POST') posted++;
      await route.continue();
    });
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new Error('Synthetic unavailable browser storage');
      };
    });
    await page.getByRole('button', { name: 'Start private workspace', exact: true }).click();
    await expect(page.locator('#rfq-error')).toContainText('could not be retained');
    expect(posted).toBe(0);
    const admin = await connection('admin');
    try {
      expect(
        (await admin.query<{ count: number }>('SELECT count(*)::int AS count FROM fi.sandboxes'))
          .rows[0]!.count,
      ).toBe(0);
    } finally {
      await admin.end();
    }
  } finally {
    await f.close();
  }
});
