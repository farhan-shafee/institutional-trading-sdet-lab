import { test, expect, type Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { reconciliationHttp } from '../postgres/reconciliation-http-fixture.js';
import { capabilityDigest } from '../../app/server/fixed-income-workflow/service.js';
import { rfqInput, digest } from '../postgres/rfq-fixture.js';
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
// Model a response that wins the race with cancellation: the identity fence must still reject it.
async function allowLateResponse(page: Page, fragment: string) {
  await page.evaluate((match) => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes(match) && init?.method !== 'POST') {
        const options = { ...init };
        delete options.signal;
        return original(input, options);
      }
      return original(input, init);
    };
  }, fragment);
}
async function createExecutionAndFindings(
  page: Page,
  sandbox: string,
  admin: Awaited<ReturnType<typeof connection>>,
) {
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
    [sandbox],
  );
  await admin.query(
    'UPDATE fi.order_states SET filled_par=99,remaining_par=1 WHERE sandbox_id=$1',
    [sandbox],
  );
  await admin.query('COMMIT');
  await requestRun(page);
}
test('a delayed historical run cannot replace the newer selected run', async ({ page }) => {
  const f = await fixture(page);
  let release = () => {};
  try {
    await requestRun(page);
    await requestRun(page);
    const selection = page.getByLabel('Reconciliation run', { exact: true });
    await expect(selection.locator('option')).toHaveCount(2);
    const ids = await selection
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    const old = ids[0]!,
      current = ids[1]!;
    await expect(page.locator('#recon-provenance')).toContainText(current);
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let currentSeen = false;
    await allowLateResponse(page, `/reconciliation-runs/${old}`);
    await page.route(`**/reconciliation-runs/${current}`, async (route) => {
      const response = await route.fetch();
      currentSeen = true;
      await route.fulfill({ response });
    });
    await page.route(`**/reconciliation-runs/${old}`, async (route) => {
      const response = await route.fetch();
      reached();
      await blocked;
      await route.fulfill({ response });
    });
    await selection.selectOption(old);
    await arrived;
    await selection.selectOption(current);
    await expect.poll(() => currentSeen).toBe(true);
    await expect(page.locator('#recon-provenance')).toContainText(current);
    const delayed = page.waitForResponse((response) =>
      response.url().endsWith(`/reconciliation-runs/${old}`),
    );
    release();
    await delayed;
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#recon-provenance')).toContainText(current);
    await expect(page.locator('#recon-provenance')).not.toContainText(old);
  } finally {
    release();
    await f.close();
  }
});
test('a newer finding trace remains visible when an earlier trace completes late', async ({
  page,
}) => {
  const f = await fixture(page),
    admin = await connection('admin');
  let release = () => {};
  try {
    await createExecutionAndFindings(page, f.keys.sandbox_id, admin);
    const buttons = page.locator('#recon-findings button');
    await expect.poll(() => buttons.count()).toBeGreaterThanOrEqual(2);
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    await allowLateResponse(page, `/sandboxes/${f.keys.sandbox_id}/positions`);
    await page.route(`**/sandboxes/${f.keys.sandbox_id}/positions`, async (route) => {
      if (!first) return route.continue();
      first = false;
      const response = await route.fetch();
      reached();
      await blocked;
      await route.fulfill({ response });
    });
    await buttons.nth(0).click();
    await arrived;
    await buttons.nth(1).click();
    await expect(page.locator('#recon-trace')).toContainText('"ordinal": 2');
    const delayed = page.waitForResponse((response) =>
      response.url().endsWith(`/sandboxes/${f.keys.sandbox_id}/positions`),
    );
    release();
    await delayed;
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#recon-trace')).toContainText('"ordinal": 2');
    await expect(page.locator('#recon-trace')).not.toContainText('"ordinal": 1');
  } finally {
    release();
    await admin.end();
    await f.close();
  }
});
test('a delayed findings page cannot contaminate a newly selected clean run', async ({ page }) => {
  const f = await fixture(page),
    admin = await connection('admin');
  let release = () => {};
  try {
    await createExecutionAndFindings(page, f.keys.sandbox_id, admin);
    const selection = page.getByLabel('Reconciliation run', { exact: true });
    const old = await selection.inputValue();
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
    await expect(selection.locator('option')).toHaveCount(2);
    await expect.poll(() => selection.inputValue()).not.toBe(old);
    const current = await selection.inputValue();
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await allowLateResponse(page, `/reconciliation-runs/${old}/findings`);
    await page.route(
      (url) => url.pathname.endsWith(`/reconciliation-runs/${old}/findings`),
      async (route) => {
        const response = await route.fetch();
        if (new URL(route.request().url()).searchParams.get('after') === '0') {
          const data = (await response.json()) as {
            findings: { ordinal: number }[];
            next_after: number | null;
          };
          expect(data.findings.length).toBeGreaterThan(1);
          await route.fulfill({
            response,
            json: {
              ...data,
              findings: data.findings.slice(0, 1),
              next_after: data.findings[0]!.ordinal,
            },
          });
        } else {
          reached();
          await blocked;
          await route.fulfill({ response });
        }
      },
    );
    await selection.selectOption(old);
    await arrived;
    await selection.selectOption(current);
    const delayed = page.waitForResponse(
      (response) =>
        response.url().includes(`/reconciliation-runs/${old}/findings`) &&
        new URL(response.url()).searchParams.get('after') === '1',
    );
    release();
    await delayed;
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#recon-summary')).toContainText('COMPLETED_CLEAN');
    await expect(page.locator('#recon-provenance')).toContainText(current);
    await expect(page.locator('#recon-provenance')).not.toContainText(old);
    await expect(page.locator('#recon-findings button')).toHaveCount(0);
  } finally {
    release();
    await admin.end();
    await f.close();
  }
});
test('loading another authorized sandbox invalidates a pending reconciliation read', async ({
  page,
}) => {
  const f = await fixture(page),
    admin = await connection('admin'),
    maintenance = await connection('maintenance');
  const second = {
    sandbox_id: randomUUID(),
    read_capability: randomBytes(32).toString('base64url'),
    trade_capability: randomBytes(32).toString('base64url'),
  };
  let release = () => {};
  try {
    await requestRun(page);
    const old = await page.getByLabel('Reconciliation run', { exact: true }).inputValue();
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await allowLateResponse(page, `/reconciliation-runs/${old}`);
    await page.route(`**/reconciliation-runs/${old}`, async (route) => {
      const response = await route.fetch();
      reached();
      await blocked;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Refresh reconciliation', exact: true }).click();
    await arrived;
    // Creating another sandbox replaces this token's single workflow binding. Rebind only
    // after the old authorized response has been captured behind the barrier.
    expect(
      (await f.lab.request('/api/fixed-income/v1/sandboxes', f.token, 'POST', second, randomUUID()))
        .status,
    ).toBe(201);
    await page.getByLabel('Authorized sandbox UUID').fill(second.sandbox_id);
    const button = page.getByRole('button', { name: 'Load authorized sandbox', exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.locator('#recon-summary')).toContainText('No retained reconciliation runs');
    const delayed = page.waitForResponse((response) =>
      response.url().endsWith(`/reconciliation-runs/${old}`),
    );
    release();
    await delayed;
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#recon-provenance')).not.toContainText(old);
    await expect(page.locator('#recon-summary')).toContainText('No retained reconciliation runs');
  } finally {
    release();
    await admin.query(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
      [second.sandbox_id],
    );
    await maintenance.query('SELECT fi_control.purge_expired()');
    await maintenance.end();
    await admin.end();
    await f.close();
  }
});
test('logout discards a reconciliation response already in flight', async ({ page }) => {
  const f = await fixture(page);
  let release = () => {};
  try {
    await requestRun(page);
    const run = await page.getByLabel('Reconciliation run', { exact: true }).inputValue();
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await allowLateResponse(page, `/reconciliation-runs/${run}`);
    await page.route(`**/reconciliation-runs/${run}`, async (route) => {
      const response = await route.fetch();
      reached();
      await blocked;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Refresh reconciliation', exact: true }).click();
    await arrived;
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('#recon-panel')).toBeHidden();
    const delayed = page.waitForResponse((response) =>
      response.url().endsWith(`/reconciliation-runs/${run}`),
    );
    release();
    await delayed;
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#recon-summary')).toHaveText('');
    await expect(page.locator('#recon-provenance')).toHaveText('');
    await expect(page.locator('#recon-trace')).toHaveText('');
  } finally {
    release();
    await f.close();
  }
});
test('a delayed refresh cannot restore an older run selection', async ({ page }) => {
  const f = await fixture(page);
  let release = () => {};
  try {
    await requestRun(page);
    await requestRun(page);
    const selection = page.getByLabel('Reconciliation run', { exact: true });
    await expect(selection.locator('option')).toHaveCount(2);
    const ids = await selection
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    const old = ids[0]!,
      current = ids[1]!;
    await selection.selectOption(old);
    await expect(page.locator('#recon-provenance')).toContainText(old);
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await allowLateResponse(page, '/reconciliation-runs?limit=20');
    await page.route(
      (url) => url.pathname.endsWith('/reconciliation-runs') && url.searchParams.has('limit'),
      async (route) => {
        const response = await route.fetch();
        const data = (await response.json()) as { runs: { id: string }[] };
        reached();
        await blocked;
        await route.fulfill({
          response,
          json: {
            ...data,
            runs: data.runs.filter((run) => run.id === old),
            as_of: 1,
            latest_completed_run_id: old,
          },
        });
      },
    );
    await page.getByRole('button', { name: 'Refresh reconciliation', exact: true }).click();
    await arrived;
    await selection.selectOption(current);
    const delayed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/reconciliation-runs') &&
        new URL(response.url()).searchParams.has('limit'),
    );
    release();
    await delayed;
    await page.waitForLoadState('networkidle');
    await expect(selection).toHaveValue(current);
    await expect(page.locator('#recon-provenance')).toContainText(current);
    await expect(page.locator('#recon-provenance')).not.toContainText(old);
  } finally {
    release();
    await f.close();
  }
});
test('recovery cannot target a clean run using another run’s pending state', async ({ page }) => {
  const f = await fixture(page);
  let release = () => {};
  try {
    await requestRun(page);
    await requestRun(page);
    const selection = page.getByLabel('Reconciliation run', { exact: true });
    await expect(selection.locator('option')).toHaveCount(2);
    const ids = await selection
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    const old = ids[0]!,
      current = ids[1]!;
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    await allowLateResponse(page, `/reconciliation-runs/${old}`);
    await page.route(`**/reconciliation-runs/${old}`, async (route) => {
      const response = await route.fetch();
      const data = (await response.json()) as { run: Record<string, unknown> };
      if (first) {
        first = false;
        reached();
        await blocked;
      }
      await route.fulfill({
        response,
        json: { ...data, run: { ...data.run, state: 'RUNNING', complete: false } },
      });
    });
    await selection.selectOption(old);
    await arrived;
    await selection.selectOption(current);
    const delayed = page.waitForResponse((response) =>
      response.url().endsWith(`/reconciliation-runs/${old}`),
    );
    release();
    await delayed;
    await page.waitForLoadState('networkidle');
    const recover = page.getByRole('button', { name: 'Recover interrupted run', exact: true });
    await expect(selection).toHaveValue(current);
    await expect(page.locator('#recon-provenance')).toContainText(current);
    await expect(recover).toBeDisabled();
    await selection.selectOption(old);
    await expect(page.locator('#recon-provenance')).toContainText(old);
    await expect(recover).toBeEnabled();
    const submitted = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        request.url().endsWith(`/reconciliation-runs/${old}/recover`),
    );
    await recover.click();
    expect(new URL((await submitted).url()).pathname).toBe(
      `${f.root}/reconciliation-runs/${old}/recover`,
    );
  } finally {
    release();
    await f.close();
  }
});
test('a stale unauthorized read cannot sign out a newer run selection', async ({ page }) => {
  const f = await fixture(page);
  let release = () => {};
  try {
    await requestRun(page);
    await requestRun(page);
    const selection = page.getByLabel('Reconciliation run', { exact: true });
    await expect(selection.locator('option')).toHaveCount(2);
    const ids = await selection
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    const old = ids[0]!,
      current = ids[1]!;
    await expect(page.locator('#recon-provenance')).toContainText(current);
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let currentSeen = false;
    await allowLateResponse(page, `/reconciliation-runs/${old}`);
    await page.route(`**/reconciliation-runs/${current}`, async (route) => {
      const response = await route.fetch();
      currentSeen = true;
      await route.fulfill({ response });
    });
    await page.route(`**/reconciliation-runs/${old}`, async (route) => {
      reached();
      await blocked;
      await route.fulfill({
        status: 401,
        json: { error: { code: 'UNAUTHORIZED', message: 'Session expired.' } },
      });
    });
    await selection.selectOption(old);
    await arrived;
    await selection.selectOption(current);
    await expect.poll(() => currentSeen).toBe(true);
    await expect(page.locator('#recon-provenance')).toContainText(current);
    const delayed = page.waitForResponse((response) =>
      response.url().endsWith(`/reconciliation-runs/${old}`),
    );
    release();
    await delayed;
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(page.locator('#recon-panel')).toBeVisible();
    await expect(page.locator('#recon-provenance')).toContainText(current);
    await expect(page.locator('#rfq-error')).toHaveText('');
  } finally {
    release();
    await f.close();
  }
});
test('a run transition between detail and findings cannot publish a mixed snapshot', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await requestRun(page);
    const run = await page.getByLabel('Reconciliation run', { exact: true }).inputValue();
    await page.route(`**/reconciliation-runs/${run}`, async (route) => {
      const response = await route.fetch();
      const data = (await response.json()) as { run: Record<string, unknown> };
      await route.fulfill({
        response,
        json: {
          ...data,
          run: {
            ...data.run,
            state: 'RUNNING',
            complete: false,
            finding_count: 0,
            total_findings: 0,
          },
        },
      });
    });
    await page.route(
      (url) => url.pathname.endsWith(`/reconciliation-runs/${run}/findings`),
      async (route) => {
        const response = await route.fetch();
        const data = (await response.json()) as Record<string, unknown>;
        await route.fulfill({
          response,
          json: {
            ...data,
            as_of: 1,
            next_after: null,
            findings: [
              {
                ordinal: 1,
                category: 'POSITION',
                code: 'POSITION_TOTALS',
                record_kind: 'POSITION',
                record_id: 'synthetic-position',
                related: {},
                expected: {},
                observed: {},
              },
            ],
          },
        });
      },
    );
    await page.getByRole('button', { name: 'Refresh reconciliation', exact: true }).click();
    await expect(page.locator('#recon-error')).toContainText('finding');
    await expect(page.locator('#recon-summary')).not.toContainText('RUNNING');
    await expect(page.locator('#recon-findings button')).toHaveCount(0);
  } finally {
    await f.close();
  }
});
test('out-of-order finding pages never publish a complete assessment', async ({ page }) => {
  const f = await fixture(page);
  try {
    await requestRun(page);
    const run = await page.getByLabel('Reconciliation run', { exact: true }).inputValue();
    await page.route(`**/reconciliation-runs/${run}`, async (route) => {
      const response = await route.fetch();
      const data = (await response.json()) as { run: Record<string, unknown> };
      await route.fulfill({
        response,
        json: {
          ...data,
          run: {
            ...data.run,
            state: 'COMPLETED_WITH_FINDINGS',
            finding_count: 2,
            total_findings: 2,
          },
        },
      });
    });
    await page.route(
      (url) => url.pathname.endsWith(`/reconciliation-runs/${run}/findings`),
      async (route) => {
        const response = await route.fetch();
        const data = (await response.json()) as Record<string, unknown>;
        const finding = {
          category: 'POSITION',
          code: 'POSITION_TOTALS',
          record_kind: 'POSITION',
          record_id: 'synthetic-position',
          related: {},
          expected: {},
          observed: {},
        };
        await route.fulfill({
          response,
          json: {
            ...data,
            as_of: 2,
            next_after: null,
            findings: [
              { ...finding, ordinal: 2 },
              { ...finding, ordinal: 1 },
            ],
          },
        });
      },
    );
    await page.getByRole('button', { name: 'Refresh reconciliation', exact: true }).click();
    await expect(page.locator('#recon-error')).toContainText('finding');
    await expect(page.locator('#recon-summary')).not.toContainText('Verification complete');
    await expect(page.locator('#recon-findings button')).toHaveCount(0);
  } finally {
    await f.close();
  }
});
test('a committed reconciliation request cannot override a newer selected run', async ({
  page,
}) => {
  const f = await fixture(page);
  let release = () => {};
  try {
    await requestRun(page);
    await requestRun(page);
    const selection = page.getByLabel('Reconciliation run', { exact: true });
    await expect(selection.locator('option')).toHaveCount(2);
    const old = await selection.locator('option').first().getAttribute('value');
    expect(old).not.toBeNull();
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/reconciliation-runs', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      reached();
      await blocked;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Request reconciliation', exact: true }).click();
    await arrived;
    await selection.selectOption(old);
    await expect(page.locator('#recon-provenance')).toContainText(old!);
    const delayed = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/reconciliation-runs'),
    );
    release();
    await delayed;
    await expect(selection.locator('option')).toHaveCount(3);
    await expect(selection).toHaveValue(old!);
    await expect(page.locator('#recon-provenance')).toContainText(old!);
    await expect(
      page.getByRole('button', { name: 'Retry retained command', exact: true }),
    ).toBeDisabled();
    expect(
      await page.evaluate(() =>
        Object.keys(sessionStorage).filter((key) => key.startsWith('tradeflow.rfq.command.v1.')),
      ),
    ).toHaveLength(0);
  } finally {
    release();
    await f.close();
  }
});
test('reconciliation errors clear on selection without erasing RFQ errors', async ({ page }) => {
  const f = await fixture(page);
  try {
    await requestRun(page);
    await requestRun(page);
    const selection = page.getByLabel('Reconciliation run', { exact: true });
    await expect(selection.locator('option')).toHaveCount(2);
    const ids = await selection
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    const old = ids[0]!,
      current = ids[1]!;
    await expect(page.locator('#recon-provenance')).toContainText(current);
    await page.getByLabel('RFQ par amount USD').fill('0');
    await page.getByRole('button', { name: 'Send RFQ', exact: true }).click();
    await expect(page.locator('#rfq-error')).not.toHaveText('');
    const rfqError = await page.locator('#rfq-error').textContent();
    await page.route(`**/reconciliation-runs/${old}`, (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE', message: 'Unavailable.' } },
      }),
    );
    await selection.selectOption(old);
    await expect(page.locator('#recon-error')).toContainText('HTTP 503');
    await expect(page.locator('#rfq-error')).toHaveText(rfqError!);
    await selection.selectOption(current);
    await expect(page.locator('#recon-provenance')).toContainText(current);
    await expect(page.locator('#recon-error')).toHaveText('');
    await expect(page.locator('#rfq-error')).toHaveText(rfqError!);
  } finally {
    await f.close();
  }
});
test('reconciliation command errors preserve the RFQ error', async ({ page }) => {
  const f = await fixture(page);
  try {
    await requestRun(page);
    await page.getByLabel('RFQ par amount USD').fill('0');
    await page.getByRole('button', { name: 'Send RFQ', exact: true }).click();
    await expect(page.locator('#rfq-error')).not.toHaveText('');
    const rfqError = await page.locator('#rfq-error').textContent();
    await page.route('**/reconciliation-runs', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 503,
            json: { error: { code: 'OUTCOME_UNKNOWN', message: 'Outcome unknown.' } },
          })
        : route.continue(),
    );
    await page.getByRole('button', { name: 'Request reconciliation', exact: true }).click();
    await expect(page.locator('#recon-error')).toContainText('HTTP 503');
    await expect(page.locator('#rfq-error')).toHaveText(rfqError!);
    await expect(
      page.getByRole('button', { name: 'Retry retained command', exact: true }),
    ).toBeEnabled();
  } finally {
    await f.close();
  }
});
test('a stale unauthorized reconciliation command cannot sign out a newer selection', async ({
  page,
}) => {
  const f = await fixture(page);
  let release = () => {};
  try {
    await requestRun(page);
    await requestRun(page);
    const selection = page.getByLabel('Reconciliation run', { exact: true });
    await expect(selection.locator('option')).toHaveCount(2);
    const old = (await selection.locator('option').first().getAttribute('value'))!;
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/reconciliation-runs', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      reached();
      await blocked;
      await route.fulfill({
        status: 401,
        json: { error: { code: 'UNAUTHORIZED', message: 'Session expired.' } },
      });
    });
    await page.getByRole('button', { name: 'Request reconciliation', exact: true }).click();
    await arrived;
    await selection.selectOption(old);
    await expect(page.locator('#recon-provenance')).toContainText(old);
    const delayed = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/reconciliation-runs'),
    );
    release();
    await delayed;
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(selection).toHaveValue(old);
    await expect(page.locator('#recon-provenance')).toContainText(old);
    await expect(page.locator('#recon-error')).toHaveText('');
    await expect(page.locator('#rfq-error')).toHaveText('');
    await expect(
      page.getByRole('button', { name: 'Retry retained command', exact: true }),
    ).toBeEnabled();
  } finally {
    release();
    await f.close();
  }
});
test('changing a finding filter clears the previous trace error', async ({ page }) => {
  const f = await fixture(page),
    admin = await connection('admin');
  try {
    await createExecutionAndFindings(page, f.keys.sandbox_id, admin);
    await expect.poll(() => page.locator('#recon-findings button').count()).toBeGreaterThan(0);
    await page.route(`**/sandboxes/${f.keys.sandbox_id}/positions`, (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE', message: 'Unavailable.' } },
      }),
    );
    await page.locator('#recon-findings button').first().click();
    await expect(page.locator('#recon-error')).toContainText('HTTP 503');
    await page.getByLabel('Finding category').selectOption('POSITION');
    await expect(page.locator('#recon-error')).toHaveText('');
    await expect(page.locator('#recon-summary')).toContainText('COMPLETED_WITH_FINDINGS');
  } finally {
    await admin.end();
    await f.close();
  }
});
test('changing runs aborts the superseded reconciliation request', async ({ page }) => {
  const f = await fixture(page);
  let release = () => {};
  try {
    await requestRun(page);
    await requestRun(page);
    const selection = page.getByLabel('Reconciliation run', { exact: true });
    await expect(selection.locator('option')).toHaveCount(2);
    const ids = await selection
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    const old = ids[0]!,
      current = ids[1]!;
    await expect(page.locator('#recon-provenance')).toContainText(current);
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/reconciliation-runs/${old}`, async (route) => {
      const response = await route.fetch();
      reached();
      await blocked;
      try {
        await route.fulfill({ response });
      } catch {
        expect(route.request().failure()).not.toBeNull();
      }
    });
    const aborted = page.waitForEvent('requestfailed', (request) =>
      request.url().endsWith(`/reconciliation-runs/${old}`),
    );
    await selection.selectOption(old);
    await arrived;
    await selection.selectOption(current);
    expect((await aborted).failure()).not.toBeNull();
    release();
    await expect(page.locator('#recon-provenance')).toContainText(current);
  } finally {
    release();
    await f.close();
  }
});
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
    // Actual command traffic places the investigated execution beyond the first 100 audit events.
    const app = await connection('app');
    try {
      const command = async (action: string, p: unknown) =>
        (
          await app.query<{ result: { status: number } }>(
            'SELECT fi_control.rfq_command($1,$2,$3,$4,$5,$6,$7,$8) AS result',
            [
              f.keys.sandbox_id,
              capabilityDigest(f.keys.sandbox_id, 'trade', f.keys.trade_capability),
              '1',
              action,
              JSON.stringify(p),
              digest(JSON.stringify({ action, p })),
              randomUUID(),
              randomUUID(),
            ],
          )
        ).rows[0]!.result;
      for (let n = 0; n < 35; n++) {
        const input = rfqInput();
        expect((await command('CREATE_RFQ', input)).status).toBe(201);
        expect(
          (
            await command('RESPOND_DEALER', {
              rfq_id: input.rfq_id,
              expected_version: '1',
              dealer_id: 'ATLAS',
              response: 'QUOTE',
            })
          ).status,
        ).toBe(200);
      }
    } finally {
      await app.end();
    }
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
    await expect(page.locator('#recon-trace')).toContainText('audit_events');
    await expect(page.locator('#recon-trace')).toContainText('EXECUTION_RECORDED');
    const trace = JSON.parse(await page.locator('#recon-trace').innerText()) as {
      historical_finding: { related: { command_seq: string } };
      audit_events: { command_seq: string }[];
    };
    expect(trace.audit_events.length).toBeGreaterThan(0);
    expect(
      trace.audit_events.every(
        (e) => e.command_seq === trace.historical_finding.related.command_seq,
      ),
    ).toBe(true);
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
    await expect(page.locator('#recon-recover')).toBeHidden();
    await page.getByRole('button', { name: 'Refresh reconciliation', exact: true }).click();
    await expect(page.locator('#recon-summary')).toContainText('historical/as-of');
  } finally {
    await f.close();
  }
});
