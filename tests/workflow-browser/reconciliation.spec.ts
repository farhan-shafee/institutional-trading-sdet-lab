import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { reconciliationHttp } from '../postgres/reconciliation-http-fixture.js';
import { connection } from '../postgres/harness.js';
async function fixture(page: Page, viewer = false) {
  const f = await reconciliationHttp();
  let token = f.token;
  if (viewer) {
    expect(
      (
        await f.lab.request(
          `${f.root}/reconciliation-runs`,
          f.token,
          'POST',
          { run_id: randomUUID() },
          randomUUID(),
        )
      ).status,
    ).toBe(201);
    token = await f.lab.login(true);
    expect(
      (
        await f.lab.request('/api/fixed-income/v1/sandboxes/recover', token, 'POST', {
          sandbox_id: f.keys.sandbox_id,
          capability: f.keys.read_capability,
          scope: 'read',
        })
      ).status,
    ).toBe(200);
  }
  await page.addInitScript((value) => localStorage.setItem('tradeflow.token', value), token);
  await page.goto(f.lab.origin);
  await load(page, f.keys.sandbox_id);
  return f;
}
async function load(page: Page, id: string) {
  await page.getByText('Dealer RFQ workstation', { exact: true }).click();
  await page.getByLabel('Authorized sandbox UUID').fill(id);
  await page.getByRole('button', { name: 'Load authorized sandbox', exact: true }).click();
  await expect(page.getByTestId('rfq-status')).toHaveText('Authorized sandbox loaded.');
}
async function requestRun(page: Page) {
  await page.getByRole('button', { name: 'Request reconciliation', exact: true }).click();
  await expect(page.locator('#recon-summary')).toContainText('Verification complete');
}
test('clean durable assessment exposes historical watermark and immutable source/coverage evidence', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await requestRun(page);
    await expect(page.locator('#recon-summary')).toContainText('COMPLETED_CLEAN');
    await expect(page.locator('#recon-summary')).toContainText('historical/as-of');
    await expect(page.locator('#recon-summary')).toContainText('snapshot watermark 1');
    await expect(page.locator('#recon-provenance')).toContainText('query_hashes');
    await expect(page.locator('#recon-provenance')).toContainText('report_hash');
    await expect(page.locator('#recon-provenance')).toContainText('ACT_ACT_ICMA');
    await expect(page.locator('#recon-provenance')).toContainText('COMPLETE');
  } finally {
    await f.close();
  }
});
test('typed findings filter, page and trace records; a later clean run preserves earlier historical exceptions', async ({
  page,
}) => {
  const f = await fixture(page),
    admin = await connection('admin');
  try {
    await page.getByLabel('RFQ par amount USD').fill('100.00');
    await page.getByLabel('RFQ settlement (unadjusted)').fill('2028-01-15');
    await page.getByRole('button', { name: 'Send RFQ', exact: true }).click();
    await page.getByRole('button', { name: 'Request ATLAS quote', exact: true }).click();
    await page.getByRole('button', { name: 'Accept ATLAS quote', exact: true }).click();
    await page.getByRole('button', { name: 'Simulate order acknowledgment', exact: true }).click();
    await page.getByLabel('Execution par USD', { exact: true }).fill('100.00');
    await page.getByRole('button', { name: 'Simulate execution', exact: true }).click();
    await expect(page.getByTestId('fi-order-lifecycle')).toContainText('FILLED');
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      'UPDATE fi.positions SET signed_cash_cents=signed_cash_cents+1,execution_count=execution_count+1 WHERE sandbox_id=$1',
      [f.keys.sandbox_id],
    );
    await admin.query(
      'UPDATE fi.order_states SET filled_par=99,remaining_par=1 WHERE sandbox_id=$1',
      [f.keys.sandbox_id],
    );
    await admin.query('COMMIT');
    await requestRun(page);
    await expect(page.locator('#recon-summary')).toContainText('COMPLETED_WITH_FINDINGS');
    const old = await page.locator('#recon-selection').inputValue();
    await expect(page.getByRole('button', { name: 'More findings', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'More findings', exact: true }).click();
    await page.getByLabel('Finding category').selectOption('POSITION');
    await expect(page.locator('#recon-findings')).toContainText('POSITION_TOTALS');
    await expect(page.locator('#recon-findings')).toContainText('expected');
    await expect(page.locator('#recon-findings')).toContainText('recorded');
    await page.locator('#recon-findings button').first().click();
    await expect(page.locator('#recon-trace')).toContainText('current_records_observed_separately');
    await expect(page.locator('#recon-trace')).toContainText('audit_first_page');
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      'UPDATE fi.positions SET signed_cash_cents=signed_cash_cents-1,execution_count=execution_count-1 WHERE sandbox_id=$1',
      [f.keys.sandbox_id],
    );
    await admin.query(
      'UPDATE fi.order_states SET filled_par=100,remaining_par=0 WHERE sandbox_id=$1',
      [f.keys.sandbox_id],
    );
    await admin.query('COMMIT');
    await requestRun(page);
    await expect(page.locator('#recon-summary')).toContainText('COMPLETED_CLEAN');
    await page.getByLabel('Reconciliation run', { exact: true }).selectOption(old);
    await expect(page.locator('#recon-summary')).toContainText('COMPLETED_WITH_FINDINGS');
    await expect(page.locator('#recon-summary')).toContainText('prior or non-completed run');
    await expect(page.locator('#recon-findings')).toContainText('POSITION_TOTALS');
  } finally {
    await admin.end();
    await f.close();
  }
});
test('lost committed response preserves original non-secret journal through reload and replays one authoritative run', async ({
  page,
}) => {
  const f = await fixture(page),
    reader = await connection('reconciler');
  try {
    let intercepted = false;
    await page.route('**/reconciliation-runs', async (route) => {
      if (route.request().method() === 'POST' && !intercepted) {
        intercepted = true;
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        await route.abort();
      } else await route.continue();
    });
    await page.getByRole('button', { name: 'Request reconciliation', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Retry retained command', exact: true }),
    ).toBeEnabled();
    const journal = await page.evaluate(() =>
      Object.entries(sessionStorage).filter(([k]) => k.startsWith('tradeflow.rfq.command.v1.')),
    );
    expect(journal).toHaveLength(1);
    expect(journal[0]![1]).not.toContain('capability');
    await page.reload();
    await load(page, f.keys.sandbox_id);
    expect(
      await page.evaluate(() =>
        Object.entries(sessionStorage).filter(([k]) => k.startsWith('tradeflow.rfq.command.v1.')),
      ),
    ).toEqual(journal);
    await page.getByRole('button', { name: 'Retry retained command', exact: true }).click();
    await expect(page.getByTestId('rfq-status')).toHaveText('Original command replayed.');
    await expect(page.locator('#recon-summary')).toContainText('COMPLETED_CLEAN');
    expect(
      (
        await reader.query('SELECT * FROM fi.reconciliation_runs WHERE sandbox_id=$1', [
          f.keys.sandbox_id,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await reader.query('SELECT * FROM fi.reconciliation_commands WHERE sandbox_id=$1', [
          f.keys.sandbox_id,
        ])
      ).rowCount,
    ).toBe(1);
  } finally {
    await reader.end();
    await f.close();
  }
});
test('viewer can inspect prior historical evidence without reconciliation mutation controls', async ({
  page,
}) => {
  const f = await fixture(page, true);
  try {
    await expect(page.locator('#recon-summary')).toContainText('COMPLETED_CLEAN');
    await expect(
      page.getByRole('button', { name: 'Request reconciliation', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Recover interrupted run', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Refresh reconciliation', exact: true }).click();
    await expect(page.locator('#recon-summary')).toContainText('historical/as-of');
  } finally {
    await f.close();
  }
});
