import { test, expect, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { reconciliationHttp } from '../postgres/reconciliation-http-fixture.js';
import { connection } from '../postgres/harness.js';
import { OrderEntryPage } from '../../pages/OrderEntryPage.js';
import { decodeFix44, Fix44Error } from '../../app/protocol/fix44/index.js';
import { orderResponseSchema } from '../../app/domain/schemas.js';

async function checkpoint(page: Page, label: string) {
  console.log(`INTERVIEW CHECKPOINT: ${label}`);
  // PWDEBUG is an explicit local exploration mode, never the bounded acceptance gate.
  if (process.env.TF_INTERVIEW_MANUAL === '1' && !process.env.CI) await page.pause();
}

test('owned institutional rehearsal preserves an exact equity record, bond valuation, execution ledger and clean reconciliation', async ({
  page,
}) => {
  const f = await reconciliationHttp();
  try {
    await page.addInitScript((token) => localStorage.setItem('tradeflow.token', token), f.token);
    await page.goto(f.lab.origin);
    await new OrderEntryPage(page).submit({
      symbol: 'SPY',
      side: 'BUY',
      quantity: 43,
      type: 'LIMIT',
      limitPrice: 450.5,
    });
    await expect(page.getByRole('status')).toContainText('Order submitted.');
    const equityId = await page.getByTestId('detail-id').innerText();
    expect(equityId).not.toBe('');
    await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
    await expect(page.getByTestId('detail-status')).toHaveText('CANCELED');
    const equity = await f.lab.request(`/api/orders/${equityId}`, f.token);
    expect(equity.status).toBe(200);
    expect(orderResponseSchema.parse(await equity.json()).order).toMatchObject({
      id: equityId,
      symbol: 'SPY',
      quantity: 43,
      status: 'CANCELED',
    });

    await page.getByText('Fixed-income analytics', { exact: true }).click();
    await page.getByLabel('Clean price per 100 par').fill('99.875');
    await page.getByRole('button', { name: 'Calculate analytics', exact: true }).click();
    await expect(page.getByTestId('fi-results')).toContainText(
      'Accrued interest per 100 par: 1.0000000000',
    );
    await expect(page.getByTestId('fi-results')).toContainText('Consideration USD: 1008750.00');
    await checkpoint(
      page,
      '1 Analytics: dirty = 99.875 + 1.0 = 100.875; at USD 1m par, consideration = 1008750.00. Read yield/duration/convexity/DV01 with their displayed units.',
    );

    await page.getByText('Dealer RFQ workstation', { exact: true }).click();
    await page.getByLabel('Authorized sandbox UUID').fill(f.keys.sandbox_id);
    await page.getByRole('button', { name: 'Load authorized sandbox', exact: true }).click();
    await expect(page.getByTestId('rfq-status')).toHaveText('Authorized sandbox loaded.');
    await page.getByLabel('RFQ par amount USD').fill('100.00');
    await page.getByLabel('RFQ settlement (unadjusted)').fill('2028-01-15');
    await page.getByRole('button', { name: 'Send RFQ', exact: true }).click();
    await page.getByRole('button', { name: 'Request ATLAS quote', exact: true }).click();
    await page.getByRole('button', { name: 'Accept ATLAS quote', exact: true }).click();
    await expect(page.getByTestId('rfq-order')).toContainText('100.050000000123');
    await expect(page.getByTestId('fi-order-lifecycle')).toContainText('PENDING_ACK');
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
    const db = await connection('reconciler');
    try {
      const ledger = await db.query(
        'SELECT par_amount::text, consideration_cents::text FROM fi.executions WHERE sandbox_id=$1',
        [f.keys.sandbox_id],
      );
      expect(ledger.rows).toEqual([{ par_amount: '40.00', consideration_cents: '4002' }]);
    } finally {
      await db.end();
    }
    await page.getByRole('button', { name: 'Request reconciliation', exact: true }).click();
    await expect(page.locator('#recon-summary')).toContainText('Verification complete');
    await expect(page.locator('#recon-summary')).toContainText('COMPLETED_CLEAN');
    await checkpoint(
      page,
      '2 RFQ/execution: BUY accepts dealer ASK. USD 100 par; fill 40; cancel remaining 60. Immutable execution 4002 cents, signed execution cash -4002; historical reconciliation CLEAN. No settlement/P&L claim.',
    );

    const frame = await readFile('test-data/fix44/new-buy-ust.fix');
    const message = decodeFix44(frame);
    expect(message.type).toBe('D');
    expect(message.fields['38']).toBe('100000.00');
    const damaged = Buffer.from(frame);
    damaged[damaged.length - 2] = damaged[damaged.length - 2] === 48 ? 49 : 48;
    assert.throws(
      () => decodeFix44(damaged),
      (e: unknown) => e instanceof Fix44Error && e.code === 'CHECKSUM',
    );
    const session = execFileSync(
      process.env.PYTHON ?? 'python3',
      ['verification/python/fix_session_reference.py'],
      { encoding: 'utf8', timeout: 20_000 },
    );
    expect(session).toContain('59 reviewed cases matched');
    console.log(session.trim());
    await checkpoint(
      page,
      '3 FIX: real SOH application frame accepted, checksum corruption rejected; 59 selected offline session expectations match. No live session engine, socket, resend/recovery or peer interoperability.',
    );
    await checkpoint(
      page,
      '4 Architecture / 5 CI: inspect fixtures, independent contracts/oracles, original failing evidence and exact CI links in docs/INTERVIEW_DEMO.md. Resume to finish and destroy only this owned rehearsal database.',
    );
  } finally {
    await f.close();
  }
});
