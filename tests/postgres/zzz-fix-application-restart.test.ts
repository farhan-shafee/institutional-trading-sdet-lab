import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applicationFixture } from './fix-application-fixture.js';
import { owner } from './harness.js';
import { restartOwnedPostgres } from '../../scripts/owned-postgres.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { FixApplicationService } from '../../app/server/fix/application.js';
import { DomainError } from '../../app/domain/errors.js';
void test('actual database stop/restart preserves prepared execution identity and financial application, outage fails closed', async () => {
  const s = await applicationFixture(),
    cfg = await owner(),
    db = new WorkflowDatabase(cfg.appUrl!),
    service = new FixApplicationService(db, true);
  s.app.on('error', () => {});
  try {
    await s.apply((await s.prepare()).work);
    const px = (
      await s.app.query<{ contract: Record<string, string> }>(
        'SELECT contract FROM fi.orders WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.contract['clean_price']!;
    const p = await s.prepare({
        '150': 'F',
        '39': '2',
        '14': '100.00',
        '151': '0.00',
        '32': '100.00',
        '31': px,
        '6': px,
      }),
      key = randomUUID(),
      binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' },
      input = { order_id: s.order, owner_id: s.owner, fence: s.fence, work_id: p.work };
    const applied = await service.apply(binding, s.actor, input, key, () => {});
    assert.equal(applied.status, 200);
    await restartOwnedPostgres(process.env.TF_DB_OWNER_FILE!, async () => {
      await assert.rejects(
        service.apply(binding, s.actor, input, key, () => {}),
        (e: unknown) => e instanceof DomainError && e.status === 503,
      );
    });
    const replay = await service.apply(binding, s.actor, input, key, () => {});
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, applied.body);
  } finally {
    await db.close();
    await s.close();
  }
});
