import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parse } from 'yaml';
import { metadataSchema } from '../../../app/domain/workflow/reconciliation.js';
import { verificationManifest } from '../../../app/server/reconciliation/manifest.js';
import { foundationVerificationSources } from '../../../app/server/fix/reconciliation.js';
import { migrationChecksums } from '../../../app/domain/workflow/database-contract.js';

void test('schema8 has a new financial metadata discriminator and preserves schema5–7 variants', async () => {
  const current = await verificationManifest();
  assert.equal(current.engine_version, 'reconciliation-v4');
  assert.equal(current.schema_revision, 8);
  assert.equal(current.schema_checksums?.length, 8);
  for (const [revision, engine] of [
    [5, 'reconciliation-v1'],
    [6, 'reconciliation-v2'],
    [7, 'reconciliation-v3'],
  ] as const) {
    const historical: Record<string, unknown> = {
      ...current,
      engine_version: engine,
      schema_revision: revision,
      schema_checksums: migrationChecksums.slice(0, revision),
    };
    assert.equal(metadataSchema.safeParse(historical).success, true);
    assert.equal(
      metadataSchema.safeParse({ ...current, engine_version: engine }).success,
      false,
      'old coverage cannot be relabeled as schema8',
    );
  }
  assert.equal(
    metadataSchema.safeParse({ ...current, schema_checksums: migrationChecksums.slice(0, 7) })
      .success,
    false,
  );
});
void test('schema8 FIX profiles are versioned and historical SQL hashes remain unchanged', async () => {
  for (const [name, profile, hash, revision] of [
    [
      'fix_foundation',
      'fix-foundation',
      '6d7141817bb414de9ed957ee4c32c55112620f4bf786a182f2e253d5ac008b73',
      6,
    ],
    [
      'fix_application',
      'fix-application',
      '57a321744df05f3814e976a947dab52c44828161a3398abd65e81bac34613602',
      7,
    ],
  ] as const) {
    const old = await readFile(`verification/sql/${name}.sql`, 'utf8');
    assert.equal(createHash('sha256').update(old).digest('hex'), hash);
    const contract = parse(await readFile(`contracts/${profile}-v1.yaml`, 'utf8')) as {
      schema_revision: number;
    };
    assert.equal(contract.schema_revision, revision);
    const current = parse(await readFile(`contracts/${profile}-v2.yaml`, 'utf8')) as {
      profile: string;
      schema_revision: number;
      reconciliation: { independent_sql: string };
    };
    assert.equal(current.profile, `${profile}-v2`);
    assert.equal(current.schema_revision, 8);
    assert.equal(current.reconciliation.independent_sql, `verification/sql/${name}_v2.sql`);
  }
  assert.equal(foundationVerificationSources.historical.file, 'fix_foundation.sql');
  assert.equal(
    foundationVerificationSources.historical.sha256,
    '6d7141817bb414de9ed957ee4c32c55112620f4bf786a182f2e253d5ac008b73',
  );
  assert.equal(foundationVerificationSources.current.file, 'fix_foundation_v2.sql');
  assert.equal(foundationVerificationSources.current.profile, 'fix-foundation-v2');
  assert.equal(foundationVerificationSources.current.schema, 8);
  for (const source of Object.values(foundationVerificationSources)) {
    const sql = await readFile('verification/sql/' + source.file);
    assert.equal(createHash('sha256').update(sql).digest('hex'), source.sha256);
  }
});
