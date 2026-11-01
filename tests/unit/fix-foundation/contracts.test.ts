import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metadataSchema } from '../../../app/domain/workflow/reconciliation.js';
import { manifest } from '../../postgres/reconciliation-fixture.js';
void test('new physical schema6 manifests and historical schema5 financial profiles remain distinct', () => {
  assert.equal(metadataSchema.safeParse(manifest).success, true);
  const checks = Array.from({ length: 6 }, (_, i) => ({
    version: i + 1,
    checksum: 'a'.repeat(64),
  }));
  assert.equal(
    metadataSchema.safeParse({
      ...manifest,
      engine_version: 'reconciliation-v2',
      schema_revision: 6,
      schema_checksums: checks,
    }).success,
    true,
  );
  assert.equal(
    metadataSchema.safeParse({ ...manifest, schema_revision: 6, schema_checksums: checks }).success,
    false,
  );
  assert.equal(
    metadataSchema.safeParse({
      ...manifest,
      engine_version: 'reconciliation-v2',
      schema_revision: 5,
      schema_checksums: checks,
    }).success,
    false,
  );
});
void test('foundation contract has no financial application or transport activation', async () => {
  const { readFile } = await import('node:fs/promises');
  const { parse } = await import('yaml');
  const c = parse(await readFile('contracts/fix-foundation-v1.yaml', 'utf8')) as {
    schema_revision: number;
    transport: string;
    financial_application: string;
    operations: Record<string, unknown>;
    reconciliation: { complete: boolean; delivery_verified: boolean };
  };
  assert.equal(c.schema_revision, 6);
  assert.equal(c.transport, 'NONE');
  assert.equal(c.financial_application, 'NOT_IMPLEMENTED');
  assert.deepEqual(Object.keys(c.operations).sort(), [
    'BIND',
    'CLAIM',
    'PREPARE',
    'QUEUE',
    'RECORD',
    'RELEASE',
    'RESOLVE_METADATA',
  ]);
  assert.equal(c.reconciliation.complete, false);
  assert.equal(c.reconciliation.delivery_verified, false);
});
