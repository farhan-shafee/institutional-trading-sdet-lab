import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readConfiguration } from '../../app/server/configuration.js';
import { connection, owner } from './harness.js';
import { httpLab } from './http.js';

export async function rfqHttp(now?: () => number) {
  const owned = await owner();
  const config = readConfiguration({
    TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
    TRADEFLOW_FIXED_INCOME_DATABASE_URL: owned.appUrl!,
  });
  const lab = await httpLab(config, undefined, now);
  const token = await lab.login();
  const keys = {
    sandbox_id: randomUUID(),
    read_capability: randomBytes(32).toString('base64url'),
    trade_capability: randomBytes(32).toString('base64url'),
  };
  const root = `/api/fixed-income/v1/sandboxes/${keys.sandbox_id}`;
  assert.equal(
    (await lab.request('/api/fixed-income/v1/sandboxes', token, 'POST', keys, randomUUID())).status,
    201,
  );
  return {
    lab,
    token,
    keys,
    root,
    config,
    async close() {
      if (lab.server.listening) await lab.close();
      const admin = await connection('admin'),
        maint = await connection('maintenance');
      try {
        await admin.query(
          "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
          [keys.sandbox_id],
        );
        await maint.query('SELECT fi_control.purge_expired()');
      } finally {
        await maint.end();
        await admin.end();
      }
    },
  };
}
