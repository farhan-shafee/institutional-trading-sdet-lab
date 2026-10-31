import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { reconciliationHttp } from './reconciliation-http-fixture.js';
import { reconcile } from '../../scripts/reconcile.js';
import { savePrivate, loadPrivate } from '../../scripts/private-state.js';
await test('standalone local service durably retains operation before submission and replays the same completed run without browser or HTTP session', async () => {
  const f = await reconciliationHttp(),
    dir = await mkdtemp(resolve('.local/reconciliation-cli-'));
  try {
    const ownership = dir + '/ownership.json',
      operation = dir + '/operation.json';
    await savePrivate(ownership, {
      version: 1,
      operation: 'create',
      ...f.keys,
      idempotency_key: randomUUID(),
    });
    const first = await reconcile(process.env.TF_DB_OWNER_FILE!, ownership, operation);
    assert.equal(first.result.run.state, 'COMPLETED_CLEAN');
    assert.equal(first.replayed, false);
    assert.equal((await lstat(operation)).mode & 0o077, 0);
    const material: unknown = await loadPrivate(operation);
    assert.ok(!JSON.stringify(material).includes(f.keys.trade_capability));
    const second = await reconcile(process.env.TF_DB_OWNER_FILE!, ownership, operation);
    assert.equal(second.replayed, true);
    assert.deepEqual(second.result, first.result);
    assert.equal(second.run_id, first.run_id);
    await assert.rejects(
      reconcile(process.env.TF_DB_OWNER_FILE!, ownership, operation, 'recover', first.run_id),
      /mismatch/,
    );
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
