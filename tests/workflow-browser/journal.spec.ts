import { test, expect } from '@playwright/test';
import { boundPage } from './setup.js';

test('permanent database RFQ capacity rejection releases the journal so existing RFQs remain actionable', async ({
  page,
}) => {
  const f = await boundPage(page);
  try {
    await f.seedRfqCapacity();
    await page.getByText('Dealer RFQ workstation', { exact: true }).click();
    await page.getByLabel('Authorized sandbox UUID').fill(f.id);
    await page.getByRole('button', { name: 'Load authorized sandbox' }).click();
    await expect(page.getByTestId('rfq-status')).toHaveText('Authorized sandbox loaded.');
    await page.getByRole('button', { name: 'Send RFQ', exact: true }).click();
    await expect(page.locator('#rfq-error')).toContainText('429');
    await expect(
      page.getByRole('button', { name: 'Request ATLAS quote', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Request ATLAS quote', exact: true }).click();
    await expect(page.getByTestId('rfq-quotes')).toContainText('QUOTED');
    expect(
      await page.evaluate(
        () =>
          Object.keys(sessionStorage).filter((k) => k.startsWith('tradeflow.rfq.command.v1'))
            .length,
      ),
    ).toBe(0);
  } finally {
    await f.close();
  }
});

test('an uncertain command in a subsequently purged sandbox cannot block another authorized sandbox', async ({
  page,
}) => {
  const f = await boundPage(page);
  try {
    await page.getByText('Dealer RFQ workstation', { exact: true }).click();
    await page.getByLabel('Authorized sandbox UUID').fill(f.id);
    await page.getByRole('button', { name: 'Load authorized sandbox' }).click();
    await expect(page.getByTestId('rfq-status')).toHaveText('Authorized sandbox loaded.');
    await page.route('**/rfqs', async (route) => {
      await route.abort('connectionreset');
    });
    await page.getByRole('button', { name: 'Send RFQ', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Retry retained command', exact: true }),
    ).toBeEnabled();
    await page.unroute('**/rfqs');
    const next = await f.bindAnotherSandbox();
    await f.purgeFirstSandbox();
    await page.getByLabel('Authorized sandbox UUID').fill(next);
    await page.getByRole('button', { name: 'Load authorized sandbox' }).click();
    await expect(page.getByTestId('rfq-status')).toHaveText('Authorized sandbox loaded.');
    await expect(page.getByRole('button', { name: 'Send RFQ', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Send RFQ', exact: true }).click();
    await expect(page.getByTestId('rfq-state')).toContainText('OPEN');
    // The unresolved original is retained, not silently discarded or replaced.
    expect(
      await page.evaluate(
        () =>
          Object.keys(sessionStorage).filter((k) => k.startsWith('tradeflow.rfq.command.v1'))
            .length,
      ),
    ).toBe(1);
  } finally {
    await f.close();
  }
});
