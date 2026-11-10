/** Deliberately fails. Separate from every normal test discovery path. Owned synthetic DB only. */
import assert from 'node:assert/strict';
import { verifyOwned } from '../../scripts/owned-postgres.js';
import { applicationFixture } from '../postgres/fix-application-fixture.js';
import { assertCleanCapacity } from '../postgres/fix-capacity-oracle.js';
import { connection } from '../postgres/harness.js';

const path = process.env['TF_DB_OWNER_FILE'];
assert.ok(path);
await verifyOwned(path);
const admin = await connection('admin');
const s = await applicationFixture();
const binding = { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' as const };
try {
  assert.equal((await s.apply((await s.prepare()).work)).status, 200);
  await assertCleanCapacity(admin, binding);
  await admin.query('BEGIN');
  try {
    // Existing oracle-corruption mechanism on the disposable owned database only.
    // CHECK/NOT NULL/unique constraints stay enabled. Restore triggers before COMMIT.
    await admin.query("SET LOCAL session_replication_role='replica'");
    const changed = await admin.query(
      "UPDATE fi.order_history SET recorded_at=decided_at-interval '1 microsecond' WHERE sandbox_id=$1 AND order_id=$2 AND version=2",
      [s.id, s.order],
    );
    assert.equal(changed.rowCount, 1);
    await admin.query("SET LOCAL session_replication_role='origin'");
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  try {
    await assertCleanCapacity(admin, binding);
    assert.fail('The unchanged financial assertion must reject the controlled corruption.');
  } catch (error) {
    if (
      error instanceof assert.AssertionError &&
      error.actual === 1 &&
      error.expected === 0 &&
      /fix-capacity-oracle\.ts:299:/.test(error.stack ?? '')
    ) {
      console.log(
        'TF_CAPTURE_DEMO_ASSERTION ' +
          JSON.stringify({
            code: error.code,
            actual: error.actual,
            expected: error.expected,
            sandbox_id: s.id,
            order_id: s.order,
            original_assertion: 'tests/postgres/fix-capacity-oracle.ts:299',
          }),
      );
    }
    throw error;
  }
} finally {
  try {
    await s.close();
    const clean = await admin.query<{ clean: boolean }>(
      'SELECT retained_count=0 AND (SELECT count(*) FROM fi.sandboxes)=0 AS clean FROM fi_control.service_capacity',
    );
    assert.equal(clean.rows[0]?.clean, true);
    console.log('TF_CAPTURE_DEMO_CLEANUP ' + JSON.stringify({ sandbox_id: s.id, clean: true }));
  } finally {
    await admin.end();
  }
}
