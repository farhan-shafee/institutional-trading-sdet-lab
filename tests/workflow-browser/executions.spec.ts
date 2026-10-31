import { test, expect, type Page } from '@playwright/test';
import { boundPage } from './setup.js';
async function order(page: Page, id: string) {
  await page.getByText('Dealer RFQ workstation', { exact: true }).click();
  await page.getByLabel('Authorized sandbox UUID').fill(id);
  await page.getByRole('button', { name: 'Load authorized sandbox' }).click();
  await expect(page.getByTestId('rfq-status')).toHaveText('Authorized sandbox loaded.');
  await page.getByLabel('RFQ par amount USD').fill('100.00');
  await page.getByLabel('RFQ settlement (unadjusted)').fill('2028-01-15');
  await page.getByRole('button', { name: 'Send RFQ', exact: true }).click();
  await page.getByRole('button', { name: 'Request ATLAS quote', exact: true }).click();
  await page.getByRole('button', { name: 'Accept ATLAS quote', exact: true }).click();
  await expect(page.getByTestId('fi-order-lifecycle')).toContainText('PENDING_ACK');
}
test('acknowledge, partially fill and cancel remainder while preserving execution-derived position', async ({
  page,
}) => {
  const f = await boundPage(page);
  try {
    await order(page, f.id);
    await expect(page.getByTestId('fi-execution-positions')).toContainText('No executed positions');
    await page.getByRole('button', { name: 'Simulate order acknowledgment', exact: true }).click();
    await expect(page.getByTestId('fi-order-lifecycle')).toContainText('NEW');
    await page.getByLabel('Execution par USD', { exact: true }).fill('40.00');
    await page.getByRole('button', { name: 'Simulate execution', exact: true }).click();
    await expect(page.getByTestId('fi-order-lifecycle')).toContainText('PARTIALLY_FILLED');
    await expect(page.getByTestId('fi-order-lifecycle')).toContainText('remaining par 60.00');
    await expect(page.getByTestId('fi-execution-positions')).toContainText('signed par 40.00');
    await page.getByRole('button', { name: 'Request order cancellation', exact: true }).click();
    await expect(page.getByTestId('fi-order-cancellations')).toContainText('PENDING');
    await page
      .getByRole('button', { name: 'Simulate cancellation acknowledgment', exact: true })
      .click();
    await expect(page.getByTestId('fi-order-lifecycle')).toContainText('CANCELED');
    await expect(page.getByTestId('fi-order-lifecycle')).toContainText('filled par 40.00');
    await expect(page.getByTestId('fi-order-executions')).toContainText('4002');
    await expect(
      page.getByRole('button', { name: 'Simulate execution', exact: true }),
    ).toBeDisabled();
  } finally {
    await f.close();
  }
});
test('per-fill cent rounding and full fill beat pending cancellation without reopening order', async ({
  page,
}) => {
  const f = await boundPage(page);
  try {
    await order(page, f.id);
    await page.getByRole('button', { name: 'Simulate order acknowledgment', exact: true }).click();
    await page.getByLabel('Execution par USD', { exact: true }).fill('50.00');
    await page.getByRole('button', { name: 'Simulate execution', exact: true }).click();
    await page.getByRole('button', { name: 'Request order cancellation', exact: true }).click();
    await page.getByRole('button', { name: 'Simulate execution', exact: true }).click();
    await expect(page.getByTestId('fi-order-lifecycle')).toContainText('FILLED');
    await expect(page.getByTestId('fi-order-lifecycle')).toContainText('executed USD cents 10006');
    await page
      .getByRole('button', { name: 'Simulate cancellation acknowledgment', exact: true })
      .click();
    await expect(page.getByTestId('fi-order-cancellations')).toContainText('REJECTED');
    await expect(page.getByTestId('fi-order-cancellations')).toContainText('TOO_LATE');
    await expect(page.getByTestId('fi-execution-positions')).toContainText(
      'signed execution cash USD cents -10006',
    );
  } finally {
    await f.close();
  }
});
test('lost committed fill response retains original event/key across reload and retries exactly once economically', async ({
  page,
}) => {
  const f = await boundPage(page);
  try {
    await order(page, f.id);
    await page.getByRole('button', { name: 'Simulate order acknowledgment', exact: true }).click();
    let intercepted = false;
    await page.route('**/orders/*/executions', async (route) => {
      if (!intercepted) {
        intercepted = true;
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        await route.abort();
      } else await route.continue();
    });
    await page.getByLabel('Execution par USD', { exact: true }).fill('40.00');
    await page.getByRole('button', { name: 'Simulate execution', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Retry retained command', exact: true }),
    ).toBeEnabled();
    const before = await page.evaluate(() =>
      Object.entries(sessionStorage).filter(([key]) => key.startsWith('tradeflow.rfq.command.v1.')),
    );
    expect(before).toHaveLength(1);
    await page.reload();
    await page.getByText('Dealer RFQ workstation', { exact: true }).click();
    await page.getByLabel('Authorized sandbox UUID').fill(f.id);
    await page.getByRole('button', { name: 'Load authorized sandbox' }).click();
    await expect(
      page.getByRole('button', { name: 'Retry retained command', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Retry retained command', exact: true }).click();
    await expect(page.getByTestId('rfq-status')).toHaveText('Original command replayed.');
    await expect(page.getByTestId('fi-order-lifecycle')).toContainText('execution count 1');
    await expect(page.getByTestId('fi-execution-positions')).toContainText('signed par 40.00');
    expect(
      await page.evaluate(
        () =>
          Object.keys(sessionStorage).filter((key) => key.startsWith('tradeflow.rfq.command.v1.'))
            .length,
      ),
    ).toBe(0);
  } finally {
    await f.close();
  }
});
