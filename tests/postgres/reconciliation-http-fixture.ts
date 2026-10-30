import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readConfiguration } from '../../app/server/configuration.js';
import { connection, owner } from './harness.js';
import { httpLab } from './http.js';
import type { RunnerHooks } from '../../app/server/reconciliation/runner.js';
export async function reconciliationHttp(hooks?: RunnerHooks, now?: () => number) {
  const owned = await owner(),
    config = readConfiguration({
      TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
      TRADEFLOW_FIXED_INCOME_DATABASE_URL: owned.appUrl!,
      TRADEFLOW_FIXED_INCOME_RECONCILER_URL: owned.reconcilerUrl!,
    });
  const lab = await httpLab(config, undefined, now, hooks);
  const token = await lab.login();
  const keys = {
    sandbox_id: randomUUID(),
    read_capability: randomBytes(32).toString('base64url'),
    trade_capability: randomBytes(32).toString('base64url'),
  };
  assert.equal(
    (await lab.request('/api/fixed-income/v1/sandboxes', token, 'POST', keys, randomUUID())).status,
    201,
  );
  return {
    lab,
    token,
    keys,
    config,
    root: `/api/fixed-income/v1/sandboxes/${keys.sandbox_id}`,
    async close() {
      if (lab.server.listening) await lab.close();
      const admin = await connection('admin'),
        maintenance = await connection('maintenance');
      try {
        await admin.query('BEGIN');
        await admin.query("SET LOCAL session_replication_role='replica'");
        await admin.query(
          "UPDATE fi.reconciliation_runs SET requested_at=requested_at-interval '1 minute',started_at=started_at-interval '1 minute',lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1 AND state IN ('REQUESTED','RUNNING')",
          [keys.sandbox_id],
        );
        await admin.query('COMMIT');
        await admin.query(
          "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
          [keys.sandbox_id],
        );
        await maintenance.query('SELECT fi_control.purge_expired()');
      } finally {
        await admin.end();
        await maintenance.end();
      }
    },
  };
}
