import { test, expect } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { owner, connection } from '../postgres/harness.js';
import { httpLab } from '../postgres/http.js';
import { readConfiguration } from '../../app/server/configuration.js';

for (const side of ['BUY', 'SELL']) {
  test(`${side} RFQ creates only one exact-price PENDING_ACK order using an existing binding`, async ({
    page,
  }) => {
    const owned = await owner();
    const lab = await httpLab(
      readConfiguration({
        TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
        TRADEFLOW_FIXED_INCOME_DATABASE_URL: owned.appUrl!,
      }),
    );
    const token = await lab.login(),
      id = randomUUID();
    try {
      // Native setup only: capabilities never enter the page, URL, storage or Playwright trace.
      const created = await lab.request(
        '/api/fixed-income/v1/sandboxes',
        token,
        'POST',
        {
          sandbox_id: id,
          read_capability: randomBytes(32).toString('base64url'),
          trade_capability: randomBytes(32).toString('base64url'),
        },
        randomUUID(),
      );
      expect(created.status).toBe(201);
      await page.addInitScript((value) => localStorage.setItem('tradeflow.token', value), token);
      await page.goto(lab.origin);
      await expect(page.getByText('Dealer RFQ workstation', { exact: true })).toBeVisible();
      await page.getByText('Dealer RFQ workstation', { exact: true }).click();
      await page.getByLabel('Authorized sandbox UUID').fill(id);
      await page.getByRole('button', { name: 'Load authorized sandbox' }).click();
      await expect(page.getByTestId('rfq-status')).toHaveText('Authorized sandbox loaded.');
      await page.getByLabel('RFQ side', { exact: true }).selectOption(side);
      await page.getByLabel('RFQ par amount USD').fill('1000000.25');
      await page.getByLabel('RFQ settlement date').fill('2028-02-29');
      await page.getByRole('button', { name: 'Send RFQ' }).click();
      await expect(page.getByTestId('rfq-state')).toContainText('OPEN');
      await page.getByRole('button', { name: 'Request ATLAS quote', exact: true }).click();
      await expect(page.getByTestId('rfq-quotes')).toContainText('100.050000000123');
      await page.getByRole('button', { name: 'Decline BIRCH', exact: true }).click();
      await expect(page.getByTestId('rfq-invitations')).toContainText('BIRCH: DECLINED');
      await page.getByRole('button', { name: 'Request CEDAR quote', exact: true }).click();
      await page.getByRole('button', { name: 'Withdraw CEDAR quote', exact: true }).click();
      await expect(page.getByTestId('rfq-quotes')).toContainText('WITHDRAWN');
      await page.getByRole('button', { name: 'Accept ATLAS quote', exact: true }).click();
      await expect(page.getByTestId('rfq-order')).toContainText('PENDING_ACK');
      await expect(page.getByTestId('rfq-order')).toContainText(
        side === 'BUY' ? '100.050000000123' : '99.950000000123',
      );
      await expect(page.getByTestId('rfq-order')).toContainText('2028-02-29');
      await page.getByRole('button', { name: 'Refresh RFQs', exact: true }).click();
      await expect(page.getByTestId('rfq-state')).toContainText('ACCEPTED');
      await expect(
        page.getByRole('button', { name: 'Accept ATLAS quote', exact: true }),
      ).toBeDisabled();
      const reader = await connection('reconciler');
      try {
        expect(
          (await reader.query('SELECT * FROM fi.orders WHERE sandbox_id=$1', [id])).rowCount,
        ).toBe(1);
      } finally {
        await reader.end();
      }
    } finally {
      await lab.close();
      const admin = await connection('admin'),
        maint = await connection('maintenance');
      try {
        await admin.query(
          "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
          [id],
        );
        await maint.query('SELECT fi_control.purge_expired()');
      } finally {
        await maint.end();
        await admin.end();
      }
    }
  });
}
