import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { FixApplicationService, applyFixSchema } from '../../../app/server/fix/application.js';
import { WorkflowDatabase } from '../../../app/persistence/postgres/workflow.js';
import { DomainError } from '../../../app/domain/errors.js';
import { metadataSchema } from '../../../app/domain/workflow/reconciliation.js';
import { manifest } from '../../postgres/reconciliation-fixture.js';
void test('FIX application defaults OFF and does not establish a PostgreSQL connection', async () => {
  const db = new WorkflowDatabase(
    'postgresql://tf_app@127.0.0.1:1/tradeflow_local_0000000000000000',
  );
  try {
    const s = new FixApplicationService(db),
      b = {
        sandboxId: randomUUID(),
        digest: 'a'.repeat(64),
        scope: 'trade' as const,
        generation: '1',
      };
    for (const run of [
      () => s.apply(b, randomUUID(), {}, randomUUID(), () => {}),
      () => s.ingest(b, randomUUID(), {}, randomUUID(), () => {}),
    ])
      await assert.rejects(
        run(),
        (e: unknown) => e instanceof DomainError && e.code === 'FIX_APPLICATION_DISABLED',
      );
    assert.equal(db.pool.totalCount, 0);
  } finally {
    await db.close();
  }
});
void test('application contracts are narrow, historical profiles remain distinct and current schema7 is explicit', async () => {
  const p = { order_id: randomUUID(), owner_id: randomUUID(), fence: '1', work_id: randomUUID() };
  assert.equal(applyFixSchema.safeParse(p).success, true);
  assert.equal(applyFixSchema.safeParse({ ...p, par_amount: '1.00' }).success, false);
  const current = {
    ...manifest,
    engine_version: 'reconciliation-v3',
    schema_revision: 7,
    schema_checksums: Array.from({ length: 7 }, (_, i) => ({
      version: i + 1,
      checksum: 'a'.repeat(64),
    })),
  };
  assert.equal(metadataSchema.safeParse(current).success, true);
  assert.equal(
    metadataSchema.safeParse({ ...current, engine_version: 'reconciliation-v2' }).success,
    false,
  );
  assert.equal(metadataSchema.safeParse(manifest).success, true);
  const c = parse(await readFile('contracts/fix-application-v1.yaml', 'utf8')) as {
    transport: string;
    delivery_verified: boolean;
    schema_revision: number;
  };
  assert.equal(c.transport, 'NONE');
  assert.equal(c.delivery_verified, false);
  assert.equal(c.schema_revision, 7);
});
