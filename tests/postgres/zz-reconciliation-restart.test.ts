import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { restartOwnedPostgres } from '../../scripts/owned-postgres.js';
import { reconciliationHttp } from './reconciliation-http-fixture.js';
import { connection } from './harness.js';
import {
  reconciliationDetailSchema,
  reconciliationFindingsSchema,
} from '../../app/domain/workflow/reconciliation.js';
await test('database interruption fails closed and restart preserves exact immutable historical findings and original replay', async () => {
  const f = await reconciliationHttp(),
    admin = await connection('admin');
  try {
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      'UPDATE fi.sandboxes SET command_count=command_count+1,commit_seq=commit_seq+1 WHERE id=$1',
      [f.keys.sandbox_id],
    );
    await admin.query('COMMIT');
    await admin.end();
    const run = randomUUID(),
      key = randomUUID(),
      path = `${f.root}/reconciliation-runs`,
      input = { run_id: run };
    const response = await f.lab.request(path, f.token, 'POST', input, key);
    assert.equal(response.status, 201);
    const reference: unknown = await response.json();
    const before = reconciliationDetailSchema.parse(
        await (await f.lab.request(`${path}/${run}`, f.token)).json(),
      ),
      findings = reconciliationFindingsSchema.parse(
        await (await f.lab.request(`${path}/${run}/findings`, f.token)).json(),
      );
    assert.equal(before.run.state, 'COMPLETED_WITH_FINDINGS');
    assert.ok(findings.findings.length);
    await restartOwnedPostgres(process.env.TF_DB_OWNER_FILE!, async () => {
      assert.equal((await f.lab.request(`${path}/${run}`, f.token)).status, 503);
      assert.equal((await f.lab.request(path, f.token, 'POST', input, key)).status, 503);
      assert.equal((await f.lab.request('/api/orders', f.token)).status, 200);
    });
    assert.deepEqual(
      reconciliationDetailSchema.parse(
        await (await f.lab.request(`${path}/${run}`, f.token)).json(),
      ),
      before,
    );
    assert.deepEqual(
      reconciliationFindingsSchema.parse(
        await (await f.lab.request(`${path}/${run}/findings`, f.token)).json(),
      ),
      findings,
    );
    const replay = await f.lab.request(path, f.token, 'POST', input, key);
    assert.equal(replay.status, 201);
    assert.deepEqual(await replay.json(), reference);
  } finally {
    await admin.end().catch(() => undefined);
    await f.close();
  }
});
