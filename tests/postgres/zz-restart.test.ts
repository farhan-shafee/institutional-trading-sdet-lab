import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readConfiguration } from '../../app/server/configuration.js';
import { restartOwnedPostgres } from '../../scripts/owned-postgres.js';
import { owner, connection } from './harness.js';
import { httpLab } from './http.js';

await test('actual PostgreSQL stop and restart preserves ownership while workflow fails closed during outage', async () => {
  const owned = await owner();
  if (!owned.appUrl || !process.env.TF_DB_OWNER_FILE) throw new Error('Owned PostgreSQL required.');
  const lab = await httpLab(
    readConfiguration({
      TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
      TRADEFLOW_FIXED_INCOME_DATABASE_URL: owned.appUrl,
    }),
  );
  const input = {
    sandbox_id: randomUUID(),
    read_capability: randomBytes(32).toString('base64url'),
    trade_capability: randomBytes(32).toString('base64url'),
  };
  try {
    const token = await lab.login();
    const key = randomUUID();
    assert.equal(
      (await lab.request('/api/fixed-income/v1/sandboxes', token, 'POST', input, key)).status,
      201,
    );
    await restartOwnedPostgres(process.env.TF_DB_OWNER_FILE, async () => {
      assert.deepEqual(
        await (await lab.request('/api/fixed-income/v1/workflow/status', token)).json(),
        { enabled: true, state: 'unavailable' },
      );
      assert.equal(
        (await lab.request(`/api/fixed-income/v1/sandboxes/${input.sandbox_id}`, token)).status,
        503,
      );
      assert.equal((await lab.request('/health')).status, 200);
      assert.equal((await lab.request('/api/orders', token)).status, 200);
      assert.equal((await lab.request('/api/fixed-income/v1/instruments', token)).status, 200);
    });
    assert.equal(
      (await lab.request(`/api/fixed-income/v1/sandboxes/${input.sandbox_id}`, token)).status,
      200,
    );
    const replay = await lab.request('/api/fixed-income/v1/sandboxes', token, 'POST', input, key);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
  } finally {
    await lab.close();
    const admin = await connection('admin');
    const maint = await connection('maintenance');
    try {
      await admin.query(
        "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
        [input.sandbox_id],
      );
      await maint.query('SELECT fi_control.purge_expired()');
    } finally {
      await maint.end();
      await admin.end();
    }
  }
});
