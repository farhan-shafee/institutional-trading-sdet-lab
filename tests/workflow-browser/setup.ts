import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { connection, owner } from '../postgres/harness.js';
import { httpLab } from '../postgres/http.js';
import { readConfiguration } from '../../app/server/configuration.js';
import { capabilityDigest } from '../../app/server/fixed-income-workflow/service.js';
import { digest, rfqInput } from '../postgres/rfq-fixture.js';

export async function boundPage(page: Page, viewer = false, readOnlyTrader = false) {
  const owned = await owner();
  const lab = await httpLab(
    readConfiguration({
      TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
      TRADEFLOW_FIXED_INCOME_DATABASE_URL: owned.appUrl!,
    }),
  );
  const id = randomUUID(),
    read = randomBytes(32).toString('base64url'),
    trade = randomBytes(32).toString('base64url');
  const ids = [id];
  let token = await lab.login();
  assert.equal(
    (
      await lab.request(
        '/api/fixed-income/v1/sandboxes',
        token,
        'POST',
        { sandbox_id: id, read_capability: read, trade_capability: trade },
        randomUUID(),
      )
    ).status,
    201,
  );
  if (viewer || readOnlyTrader) {
    if (viewer) token = await lab.login(true);
    assert.equal(
      (
        await lab.request('/api/fixed-income/v1/sandboxes/recover', token, 'POST', {
          sandbox_id: id,
          capability: read,
          scope: 'read',
        })
      ).status,
      200,
    );
  }
  await page.addInitScript((value) => localStorage.setItem('tradeflow.token', value), token);
  await page.goto(lab.origin);
  return {
    id,
    lab,
    async seedRfqCapacity() {
      const db = await connection('app');
      try {
        for (let n = 0; n < 50; n++) {
          const input = rfqInput();
          const result = await db.query<{ result: { status: number } }>(
            'SELECT fi_control.rfq_command($1,$2,$3,$4,$5,$6,$7,$8) AS result',
            [
              id,
              capabilityDigest(id, 'trade', trade),
              '1',
              'CREATE_RFQ',
              JSON.stringify(input),
              digest(JSON.stringify(input)),
              randomUUID(),
              randomUUID(),
            ],
          );
          assert.equal(result.rows[0]?.result.status, 201);
        }
      } finally {
        await db.end();
      }
    },
    async bindAnotherSandbox() {
      const next = randomUUID();
      ids.push(next);
      assert.equal(
        (
          await lab.request(
            '/api/fixed-income/v1/sandboxes',
            token,
            'POST',
            {
              sandbox_id: next,
              read_capability: randomBytes(32).toString('base64url'),
              trade_capability: randomBytes(32).toString('base64url'),
            },
            randomUUID(),
          )
        ).status,
        201,
      );
      return next;
    },
    async purgeFirstSandbox() {
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
    },
    async close() {
      await lab.close();
      const admin = await connection('admin'),
        maint = await connection('maintenance');
      try {
        await admin.query(
          "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=ANY($1::uuid[])",
          [ids],
        );
        await maint.query('SELECT fi_control.purge_expired()');
      } finally {
        await maint.end();
        await admin.end();
      }
    },
  };
}
