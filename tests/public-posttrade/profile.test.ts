import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connection, roleTarget } from '../public-demo/database.js';
import { PublicPostTradeWorkflowDatabase } from '../../app/persistence/postgres/public-post-trade-workflow.js';
import { publicPostTradeProfileChecksum } from '../../app/server/public-demo/posttrade-profile.js';
import { postTradeMigrationChecksums } from '../../app/domain/post-trade/database-contract.js';
import { verifyPublicProfile } from '../../app/server/public-demo/profile.js';
import { VerificationDatabase } from '../../app/server/reconciliation/database.js';
import { verificationManifest } from '../../app/server/reconciliation/manifest.js';

await test('actual hosted profile installs exactly ten original migrations, distinct authorities and forced accounting RLS', async () => {
  const app = await connection('app'),
    admin = await connection('admin');
  const database = new PublicPostTradeWorkflowDatabase(await roleTarget('app'));
  try {
    await verifyPublicProfile(app, 'posttrade');
    await assert.rejects(verifyPublicProfile(app));
    assert.deepEqual(
      (
        await app.query(
          'SELECT version,checksum FROM fi_control.schema_migrations ORDER BY version',
        )
      ).rows,
      postTradeMigrationChecksums,
    );
    const tables = await admin.query<{ name: string; rls: boolean; forced: boolean }>(
      "SELECT relname AS name,relrowsecurity AS rls,relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fi' AND relname LIKE 'posttrade_%' AND relkind='r'",
    );
    assert.equal(tables.rows.length, 8);
    assert.ok(tables.rows.every((row) => row.rls && row.forced));
    for (const role of ['app', 'reconciler', 'maintenance'] as const) {
      const client = await connection(role);
      try {
        assert.equal(
          (
            await client.query<{ valid: boolean }>(
              "SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT pg_has_role(current_user,'tf_owner','MEMBER') AS valid FROM pg_roles WHERE rolname=current_user",
            )
          ).rows[0]!.valid,
          true,
        );
        for (const table of tables.rows)
          await assert.rejects(client.query('SELECT * FROM fi.' + table.name), { code: '42501' });
      } finally {
        await client.end();
      }
    }
    await database.transaction(
      true,
      () => {},
      async (db) => {
        assert.equal(
          (await db.query<{ admitted: number }>('SELECT 1 AS admitted')).rows[0]!.admitted,
          1,
        );
      },
    );
    for (const [alter, restore] of [
      [
        "UPDATE fi_control.public_demo_profile SET source_checksum=repeat('0',64)",
        "UPDATE fi_control.public_demo_profile SET source_checksum='" +
          publicPostTradeProfileChecksum +
          "'",
      ],
      [
        "UPDATE fi_control.schema_migrations SET checksum=repeat('0',64) WHERE version=9",
        "UPDATE fi_control.schema_migrations SET checksum='" +
          postTradeMigrationChecksums[8]!.checksum +
          "' WHERE version=9",
      ],
      [
        'GRANT SELECT ON fi.posttrade_roots TO tf_app',
        'REVOKE SELECT ON fi.posttrade_roots FROM tf_app',
      ],
    ]) {
      await admin.query(alter!);
      try {
        await assert.rejects(
          database.transaction(
            true,
            () => {},
            (db) => db.query('SELECT 1 AS must_not_run'),
          ),
        );
      } finally {
        await admin.query(restore!);
      }
    }
  } finally {
    await database.close();
    await app.end();
    await admin.end();
  }
});

await test('public reconciliation requires explicit schema10 admission and cannot claim broader financial verification', async () => {
  const target = await roleTarget('reconciler');
  const legacy = new VerificationDatabase(target);
  const current = new VerificationDatabase(target, {}, 'public-posttrade-v1');
  const admin = await connection('admin');
  try {
    await assert.rejects(
      legacy.transaction(
        true,
        () => {},
        (db) => db.query('SELECT 1'),
      ),
    );
    await current.transaction(
      true,
      () => {},
      (db) => db.query('SELECT 1'),
    );
    const metadata = await verificationManifest('public-posttrade-v1');
    assert.equal(
      (
        await admin.query<{ valid: boolean }>(
          'SELECT fi_control.valid_reconciliation_metadata($1::jsonb) AS valid',
          [JSON.stringify(metadata)],
        )
      ).rows[0]!.valid,
      true,
    );
    for (const invalid of [
      await verificationManifest(),
      { ...metadata, schema_revision: '10' },
      { ...metadata, verification_scope: 'ALL_FINANCE_VERIFIED' },
      { ...metadata, public_profile_checksum: '0'.repeat(64) },
      { ...metadata, arbitrary_report: 'must not be admitted' },
      { ...metadata, schema_checksums: metadata.schema_checksums?.slice(0, 8) },
    ])
      assert.equal(
        (
          await admin.query<{ valid: boolean }>(
            'SELECT fi_control.valid_reconciliation_metadata($1::jsonb) AS valid',
            [JSON.stringify(invalid)],
          )
        ).rows[0]!.valid,
        false,
      );
    await admin.query('GRANT SELECT ON fi.posttrade_roots TO tf_reconciler');
    try {
      await assert.rejects(
        current.transaction(
          true,
          () => {},
          (db) => db.query('SELECT 1'),
        ),
      );
    } finally {
      await admin.query('REVOKE SELECT ON fi.posttrade_roots FROM tf_reconciler');
    }
  } finally {
    await legacy.close();
    await current.close();
    await admin.end();
  }
});
