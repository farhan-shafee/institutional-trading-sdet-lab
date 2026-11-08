import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { startOwnedPostgres } from '../../scripts/owned-postgres.js';
import { bootstrap, readOwner } from '../../scripts/workflow-database.js';
import { migrateLive } from '../../scripts/live-workflow-database.js';
import { migratePostTrade } from '../../scripts/posttrade-workflow-database.js';
import { postTradeMigrationChecksums } from '../../app/domain/post-trade/database-contract.js';

await test('008 to010 and009 to010 preserve all earlier source pins and installed execution kernel identity', async () => {
  for (const liveFirst of [false, true]) {
    const instance = await startOwnedPostgres(process.env['TF_PG_BIN']);
    let admin: pg.Client | undefined;
    try {
      await bootstrap(instance.path);
      if (liveFirst) await migrateLive(instance.path);
      const cfg = await readOwner(instance.path);
      admin = new pg.Client({ connectionString: cfg.adminUrl });
      await admin.connect();
      const before = (
        await admin.query(
          'SELECT version,checksum FROM fi_control.schema_migrations ORDER BY version',
        )
      ).rows;
      const functions = async () =>
        (
          await admin!.query<Record<string, unknown>>(
            "SELECT oid::text,proowner::regrole::text owner,prosecdef,provolatile,proconfig,proacl::text,pg_get_functiondef(oid) source FROM pg_proc WHERE oid IN ('fi_control.order_command_kernel(uuid,text,bigint,text,jsonb,text,text,uuid)'::regprocedure,'fi_control.protect_fix_capacity()'::regprocedure) ORDER BY oid",
          )
        ).rows;
      const original = await functions();
      await migratePostTrade(instance.path);
      await migratePostTrade(instance.path);
      assert.deepEqual(
        (
          await admin.query(
            'SELECT version,checksum FROM fi_control.schema_migrations ORDER BY version',
          )
        ).rows,
        postTradeMigrationChecksums,
      );
      assert.deepEqual(
        (
          await admin.query(
            'SELECT version,checksum FROM fi_control.schema_migrations WHERE version<=$1 ORDER BY version',
            [liveFirst ? 9 : 8],
          )
        ).rows,
        before,
      );
      assert.deepEqual(await functions(), original);
      const tables = (await admin.query<{ n: number }>('SELECT count(*)::int n FROM fi.sandboxes'))
        .rows[0]!.n;
      assert.equal(tables, 0);
      const keySource = (
        await admin.query<{ source: string }>(
          "SELECT pg_get_functiondef('fi_control.reserve_command_key()'::regprocedure) source",
        )
      ).rows[0]!.source;
      assert.ok(keySource.includes('fi_control.fix_apply_context'));
      assert.ok(keySource.includes("WHEN 'posttrade_commands' THEN 'POSTTRADE'"));
    } finally {
      await admin?.end();
      await instance.stop();
    }
  }
});

await test('the ten declared migration hashes match source bytes without changing earlier pins', async () => {
  const names = [
    'db/migrations/001_foundation.sql',
    'db/migrations/002_ownership.sql',
    'db/migrations/003_rfq.sql',
    'db/migrations/004_execution.sql',
    'db/migrations/005_reconciliation.sql',
    'db/migrations/006_fix_adapter.sql',
    'db/migrations/007_fix_application.sql',
    'db/migrations/008_fix_capacity_admission.sql',
    'db/live-migrations/009_fix_live_ingress.sql',
    'db/posttrade-migrations/010_post_trade.sql',
  ];
  for (let i = 0; i < names.length; i++) {
    assert.equal(
      createHash('sha256')
        .update(await readFile(names[i]!))
        .digest('hex'),
      postTradeMigrationChecksums[i]!.checksum,
      names[i],
    );
  }
});
