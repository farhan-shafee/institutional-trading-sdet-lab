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
}
async function initialize(page: Page) {
  await page
    .getByRole('button', { name: 'Initialize USD100,000,000 paper funding', exact: true })
    .click();
  await expect(page.getByTestId('posttrade-balances')).toContainText('100000000.00');
}

test('malformed HTTP200 financial marks stay UNAVAILABLE rather than becoming fabricated zeros', async ({
  page,
}) => {
  const f = await publicPostTradeBrowser();
  try {
    await login(page, f.origin);
    await initialize(page);
    await page.route('**/posttrade/pnl?**', (route) =>
      route.fulfill({ status: 200, json: { status: 'AVAILABLE', pnl: { equity_usd: '0.00' } } }),
    );
    await page.getByRole('button', { name: 'Refresh financial book', exact: true }).click();
    await expect(page.getByTestId('posttrade-error')).toContainText('expected contract');
    await expect(page.getByTestId('posttrade-pnl')).toContainText('UNAVAILABLE');
    await expect(page.getByTestId('posttrade-pnl')).not.toContainText('Equity USD: 0.00');
    await expect(page.getByTestId('posttrade-risk')).toContainText('UNAVAILABLE');
  } finally {
    await f.close();
  }
});

test('a delayed old-session financial response cannot populate a replacement viewer workspace', async ({
  page,
}) => {
  const f = await publicPostTradeBrowser();
  let release = () => {},
    captured = false,
    first = true;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await login(page, f.origin);
    await initialize(page);
    const before = await page.locator('#public-workspace-id').innerText();
    await page.route('**/posttrade/risk?**', async (route) => {
      if (!first) {
        await route.continue();
        return;
      }
      first = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      captured = true;
      await gate;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Refresh financial book', exact: true }).click();
    await expect.poll(() => captured).toBe(true);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await login(page, f.origin, true);
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(page.locator('#public-workspace-id')).not.toHaveText(before);
    await expect(page.getByTestId('posttrade-balances')).toContainText('Uninitialized');
    await expect(page.getByTestId('posttrade-pnl')).toContainText('UNAVAILABLE');
    await expect(
      page.getByRole('button', { name: 'Initialize USD100,000,000 paper funding', exact: true }),
    ).toBeDisabled();
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await f.close();
  }
});

test('failed original-intent storage prevents the financial HTTP request and leaves SQL unfunded', async ({
  page,
}) => {
  const f = await publicPostTradeBrowser();
  let posted = 0;
  try {
    await login(page, f.origin);
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/posttrade/initialize')) posted++;
    });
    await page.evaluate(() => {
      const original = Reflect.get<typeof Storage.prototype, 'setItem'>(
        Storage.prototype,
        'setItem',
      );
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key.startsWith('tradeflow.posttrade.command.v1.'))
          throw new Error('CONTROLLED_STORAGE_FAILURE');
        Reflect.apply(original, this, [key, value]);
      };
    });
    await page
      .getByRole('button', { name: 'Initialize USD100,000,000 paper funding', exact: true })
      .click();
    await expect(page.getByTestId('posttrade-error')).toContainText('no request was submitted');
    expect(posted).toBe(0);
    const admin = await connection('admin');
    try {
      expect(
        (
          await admin.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM fi.posttrade_books',
          )
        ).rows[0]!.count,
      ).toBe(0);
      expect(
        (
          await admin.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM fi.posttrade_commands',
          )
        ).rows[0]!.count,
      ).toBe(0);
    } finally {
      await admin.end();
    }
  } finally {
    await f.close();
  }
});

test('malformed committed funding response retains uncertainty and replays its original key once', async ({
  page,
}) => {
  const f = await publicPostTradeBrowser();
  let first = true;
  const keys: string[] = [];
  try {
    await login(page, f.origin);
    await page.route('**/posttrade/initialize', async (route) => {
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      if (!first) {
        await route.continue();
        return;
      }
      first = false;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.fulfill({ status: 201, json: { opening_cash_cents: '0' } });
    });
    await page
      .getByRole('button', { name: 'Initialize USD100,000,000 paper funding', exact: true })
      .click();
    await expect(page.getByTestId('posttrade-error')).toContainText('original request retained');
    await expect(page.getByTestId('posttrade-balances')).toContainText('UNCONFIRMED');
    await expect(page.getByTestId('posttrade-pnl')).toContainText('UNAVAILABLE');
    await page
      .getByRole('button', { name: 'Recover original financial request', exact: true })
      .click();
    await expect(page.getByTestId('posttrade-command-result')).toContainText(
      'Original command replayed',
    );
    await expect(page.getByTestId('posttrade-balances')).toContainText('100000000.00');
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
    } finally {
      await admin.end();
    }
  } finally {
    await f.close();
  }
});
