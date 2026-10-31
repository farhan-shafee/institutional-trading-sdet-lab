import { test, expect } from '@playwright/test';
import { boundPage } from './setup.js';
import { connection } from '../postgres/harness.js';

test('an accepted response lost to the browser is replayable from retained non-secret inputs after reload', async ({
  page,
}) => {
  const f = await boundPage(page);
  try {
    await page.getByText('Dealer RFQ workstation', { exact: true }).click();
    await page.getByLabel('Authorized sandbox UUID').fill(f.id);
    await page.getByRole('button', { name: 'Load authorized sandbox' }).click();
    await expect(page.getByTestId('rfq-status')).toHaveText('Authorized sandbox loaded.');
    await page.getByRole('button', { name: 'Send RFQ', exact: true }).click();
    await page.getByRole('button', { name: 'Request ATLAS quote', exact: true }).click();
    await expect(page.getByTestId('rfq-quotes')).toContainText('QUOTED');
    await page.route('**/rfqs/*/accept', async (route) => {
      // Server commits, then the browser receives no response. No request headers/body are logged.
      const accepted = await route.fetch();
      expect(accepted.status()).toBe(201);
      await route.abort('connectionreset');
    });
    await page.getByRole('button', { name: 'Accept ATLAS quote', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Retry retained command', exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(() => {
        const raw = Object.keys(sessionStorage)
          .filter((k) => k.startsWith('tradeflow.rfq.command.v1'))
          .map((k) => sessionStorage.getItem(k) ?? '')
          .join('');
        return /capability|Bearer|token|password/i.test(raw);
      }),
    ).toBe(false);
    await page.unroute('**/rfqs/*/accept');
    await page.reload();
    await page.getByText('Dealer RFQ workstation', { exact: true }).click();
    await page.getByLabel('Authorized sandbox UUID').fill(f.id);
    await page.getByRole('button', { name: 'Load authorized sandbox' }).click();
    await expect(page.getByTestId('rfq-order')).toContainText('PENDING_ACK');
    await page.getByRole('button', { name: 'Retry retained command', exact: true }).click();
    await expect(page.getByTestId('rfq-status')).toHaveText('Original command replayed.');
    expect(
      await page.evaluate(
        () =>
          Object.keys(sessionStorage).filter((k) => k.startsWith('tradeflow.rfq.command.v1'))
            .length === 0,
      ),
    ).toBe(true);
    const reader = await connection('reconciler');
    try {
      expect(
        (await reader.query('SELECT * FROM fi.orders WHERE sandbox_id=$1', [f.id])).rowCount,
      ).toBe(1);
      expect(
        (
          await reader.query(
            "SELECT * FROM fi.commands WHERE sandbox_id=$1 AND operation='ACCEPT_QUOTE'",
            [f.id],
          )
        ).rowCount,
      ).toBe(1);
    } finally {
      await reader.end();
    }
  } finally {
    await f.close();
  }
});

for (const viewer of [true, false])
  test(`${viewer ? 'viewer' : 'read-scoped trader'} workstation remains read-only and offers no browser capability bootstrap`, async ({
    page,
  }) => {
    const f = await boundPage(page, viewer, !viewer);
    try {
      await page.getByText('Dealer RFQ workstation', { exact: true }).click();
      await page.getByLabel('Authorized sandbox UUID').fill(f.id);
      await page.getByRole('button', { name: 'Load authorized sandbox' }).click();
      await expect(page.getByTestId('rfq-status')).toHaveText('Authorized sandbox loaded.');
      await expect(page.getByRole('button', { name: 'Send RFQ', exact: true })).toBeDisabled();
      await expect(
        page.getByRole('button', { name: /recover|rotate|create sandbox/i }),
      ).toHaveCount(0);
      await expect(page.locator('#rfq-panel input[type=password]')).toHaveCount(0);
    } finally {
      await f.close();
    }
  });
