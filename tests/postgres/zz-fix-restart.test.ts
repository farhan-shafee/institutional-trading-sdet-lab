import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, report, record } from './fix-fixture.js';
import { owner } from './harness.js';
import { restartOwnedPostgres } from '../../scripts/owned-postgres.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { FixFoundationService } from '../../app/server/fix/foundation.js';
import { DomainError } from '../../app/domain/errors.js';
void test('real PostgreSQL stop/restart preserves immutable protocol bytes and original receipts, outage fails closed', async () => {
  const s = await fixture(),
    cfg = await owner(),
    db = new WorkflowDatabase(cfg.appUrl!),
    service = new FixFoundationService(db, true);
  s.app.on('error', () => {});
  const p = { order_id: s.order, dealer_id: 'ATLAS', channel_id: s.channel },
    key = randomUUID(),
    binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' };
  try {
    const original = await service.command(binding, s.actor, 'BIND', p, key, () => {});
    await record(s, await report(s));
    const state = await service.read(binding, 'STATE', s.order, () => {});
    await restartOwnedPostgres(process.env.TF_DB_OWNER_FILE!, async () => {
      await assert.rejects(
        service.read(binding, 'STATE', s.order, () => {}),
        (e: unknown) => e instanceof DomainError && e.status === 503,
      );
      await assert.rejects(
        service.command(binding, s.actor, 'BIND', p, key, () => {}),
        (e: unknown) => e instanceof DomainError && e.status === 503,
      );
    });
    assert.deepEqual((await service.read(binding, 'STATE', s.order, () => {})).body, state.body);
    const replay = await service.command(binding, s.actor, 'BIND', p, key, () => {});
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, original.body);
  } finally {
    await db.close();
    await s.close();
  }
});
