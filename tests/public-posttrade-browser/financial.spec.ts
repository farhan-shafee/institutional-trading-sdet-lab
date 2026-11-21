import { test, expect, type Page } from '@playwright/test';
import { publicPostTradeBrowser } from '../public-posttrade/http-fixture.js';
import { connection } from '../public-demo/database.js';

async function login(page: Page, origin: string, viewer = false) {
  await page.goto(origin);
  await page.getByLabel('Username', { exact: true }).fill(viewer ? 'qa.viewer' : 'qa.user');
  await page.getByLabel('Password', { exact: true }).fill('Password123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByText('Dealer RFQ workstation', { exact: true }).click();
  await page.getByRole('button', { name: 'Start private workspace', exact: true }).click();
  await expect(page.getByTestId('rfq-status')).toHaveText('Private demo workspace ready.');
  await expect(
    page.getByRole('heading', { name: 'Paper funding and post-trade', exact: true }),
  ).toBeVisible();
}

async function execution(page: Page, side: 'BUY' | 'SELL', par: string) {
  await page.getByLabel('RFQ side', { exact: true }).selectOption(side);
  await page.getByLabel('RFQ par amount USD', { exact: true }).fill(par);
  await page.getByLabel('RFQ settlement (unadjusted)', { exact: true }).fill('2030-01-15');
  await page.getByRole('button', { name: 'Send RFQ', exact: true }).click();
  await page.getByRole('button', { name: 'Request ATLAS quote', exact: true }).click();
  await page.getByRole('button', { name: 'Accept ATLAS quote', exact: true }).click();
  await page.getByRole('button', { name: 'Simulate order acknowledgment', exact: true }).click();
  await page.getByLabel('Execution par USD', { exact: true }).fill(par);
  await page.getByRole('button', { name: 'Simulate execution', exact: true }).click();
  await expect(page.getByTestId('fi-order-lifecycle')).toContainText('FILLED');
  const option = page
    .locator('#posttrade-execution option')
    .filter({ hasText: side + ' SYN-UST-2031' });
  await expect(option).toHaveCount(1);
  const id = await option.getAttribute('value');
  if (!id) throw new Error('Missing source execution.');
  return id;
}

test('public trader follows failed SELL, settled BUY/SELL, exact P&L and conserved reversals through the workstation', async ({
  page,
}) => {
  const f = await publicPostTradeBrowser();
  try {
    await login(page, f.origin);
    await expect(page.getByTestId('posttrade-balances')).toContainText('Uninitialized');
    await page
      .getByRole('button', { name: 'Initialize USD100,000,000 paper funding', exact: true })
      .click();
    await expect(page.getByTestId('posttrade-balances')).toContainText('100000000.00');
    const buy = await execution(page, 'BUY', '100.00'),
      sell = await execution(page, 'SELL', '40.00');
    for (const [id, clean] of [
      [buy, '100.880000000000'],
      [sell, '109.500000000000'],
    ]) {
      await page.locator('#posttrade-execution').selectOption(id!);
      await page.getByRole('button', { name: 'Register selected execution', exact: true }).click();
      await page.getByLabel('Correction clean quote per 100 par', { exact: true }).fill(clean!);
      await page.getByRole('button', { name: 'Apply price correction', exact: true }).click();
      await expect(page.locator('#posttrade-revision')).toHaveText('1');
    }
    await page
      .getByRole('button', { name: 'Attempt settlement with new key', exact: true })
      .click();
    await expect(page.getByTestId('posttrade-command-result')).toContainText('FAILED');
    await expect(page.getByTestId('posttrade-command-result')).toContainText('retained receipt');
    for (const id of [buy, sell]) {
      await page.locator('#posttrade-execution').selectOption(id);
      await page
        .getByRole('button', { name: 'Attempt settlement with new key', exact: true })
        .click();
      await expect(page.getByTestId('posttrade-command-result')).toContainText('SETTLED');
    }
    await expect(page.getByTestId('posttrade-balances')).toContainText(
      'SYN-UST-2031: available par 60.00',
    );
    await expect(page.getByTestId('posttrade-pnl')).toContainText('Total P&L USD: 3.49');
    await expect(page.getByTestId('posttrade-pnl')).toContainText('Equity USD: 100000003.49');
    await expect(page.getByTestId('posttrade-pnl')).toContainText('rounding delta');
    await expect(page.getByTestId('posttrade-risk')).toContainText('Parallel DV01 USD');
    for (const id of [sell, buy]) {
      await page.locator('#posttrade-execution').selectOption(id);
      await page.getByRole('button', { name: 'Reverse selected settlement', exact: true }).click();
      await expect(page.getByTestId('posttrade-command-result')).toContainText('REVERSED');
    }
    await expect(page.getByTestId('posttrade-balances')).toContainText('100000000.00');
    await expect(page.getByTestId('posttrade-pnl')).toContainText('Total P&L USD: 3.49');
    for (const instrument of ['SYN-UST-2031', 'SYN-CORP-2031'])
      await expect(page.getByTestId('posttrade-balances')).toContainText(
        instrument + ': available par 0.00',
      );
    await page
      .getByRole('button', { name: 'Load selected execution history', exact: true })
      .click();
    await expect(page.getByTestId('posttrade-history')).toContainText('original_execution');
    for (const id of [buy, sell]) {
      await page.locator('#posttrade-execution').selectOption(id);
      await page.getByRole('button', { name: 'Bust selected execution', exact: true }).click();
      await expect(page.locator('#posttrade-root-state')).toContainText('terminal bust');
      await expect(
        page.getByRole('button', { name: 'Apply price correction', exact: true }),
      ).toBeDisabled();
    }
    await expect(page.getByTestId('posttrade-pnl')).toContainText('Total P&L USD: 0.00');
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});

test('public viewer sees uninitialized financial state and cannot initialize paper funding', async ({
  page,
}) => {
  const f = await publicPostTradeBrowser();
  try {
    await login(page, f.origin, true);
    await expect(page.getByTestId('posttrade-balances')).toContainText('Uninitialized');
    await expect(
      page.getByRole('button', { name: 'Initialize USD100,000,000 paper funding', exact: true }),
    ).toBeDisabled();
    await expect(page.getByTestId('posttrade-pnl')).toContainText('UNAVAILABLE');
    await expect(page.getByTestId('posttrade-pnl')).not.toContainText('Equity USD: 0.00');
  } finally {
    await f.close();
  }
});

test('a genuinely lost committed funding response retains the original request across reload and replays once', async ({
  page,
}) => {
  const f = await publicPostTradeBrowser();
  const keys: string[] = [];
  let first = true;
  try {
    await login(page, f.origin);
    await page.route('**/posttrade/initialize', async (route) => {
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      if (!first) {
        await route.continue();
        return;
      }
      first = false;
      const committed = await route.fetch();
      expect(committed.status()).toBe(201);
      await route.abort('failed');
    });
    await page
      .getByRole('button', { name: 'Initialize USD100,000,000 paper funding', exact: true })
      .click();
    await expect(page.getByTestId('posttrade-error')).toContainText('original request retained');
    await expect(page.getByRole('button', { name: 'Send RFQ', exact: true })).toBeDisabled();
    await page.reload();
    await page.getByText('Dealer RFQ workstation', { exact: true }).click();
    await page
      .getByRole('button', { name: 'Recover original financial request', exact: true })
      .click();
    await expect(page.getByTestId('posttrade-command-result')).toContainText(
      'Original command replayed',
    );
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const admin = await connection('admin');
    try {
      expect(
        (
          await admin.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM fi.posttrade_commands',
          )
        ).rows[0]!.count,
      ).toBe(1);
      expect(
        (
          await admin.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM fi.posttrade_events WHERE event_type='FUNDING'",
          )
        ).rows[0]!.count,
      ).toBe(1);
    } finally {
      await admin.end();
    }
  } finally {
    await f.close();
  }
});
