import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { applicationFixture } from './fix-application-fixture.js';
import { startOwnedPostgres } from '../../scripts/owned-postgres.js';
import { bootstrap, readOwner, migrate } from '../../scripts/workflow-database.js';
void test('007 upgrades populated006 retaining metadata/prepared keys/outcomes and byte-identical private financial kernel', async () => {
  const instance = await startOwnedPostgres(process.env.TF_PG_BIN),
    original = process.env.TF_DB_OWNER_FILE;
  let s: Awaited<ReturnType<typeof applicationFixture>> | undefined;
  let admin: pg.Client | undefined;
  try {
    await bootstrap(instance.path, 6);
    const cfg = await readOwner(instance.path);
    admin = new pg.Client({ connectionString: cfg.adminUrl });
    await admin.connect();
    process.env.TF_DB_OWNER_FILE = instance.path;
    s = await applicationFixture();
    const prepared = await s.prepare();
    const tables = [
      'orders',
      'order_states',
      'commands',
      'audit_events',
      'fix_bindings',
      'fix_messages',
      'fix_attempts',
      'fix_prepared',
      'fix_commands',
      'fix_events',
    ];
    const hashes = async () => {
      const out = [];
      for (const t of tables)
        out.push(
          (
            await admin!.query<{ h: string }>(
              `SELECT md5(COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]')::text) h FROM fi.${t} x WHERE sandbox_id=$1`,
              [s!.id],
            )
          ).rows[0]!.h,
        );
      return out;
    };
    const before = await hashes(),
      kernel = (
        await admin.query<{ prosrc: string; oid: string }>(
          "SELECT prosrc,oid::text FROM pg_proc WHERE oid='fi_control.order_command_kernel(uuid,text,bigint,text,jsonb,text,text,uuid)'::regprocedure",
        )
      ).rows;
    const checks = (
      await admin.query(
        'SELECT version,checksum FROM fi_control.schema_migrations ORDER BY version',
      )
    ).rows;
    await migrate(cfg);
    assert.deepEqual(await hashes(), before);
    assert.deepEqual(
      (
        await admin.query(
          'SELECT version,checksum FROM fi_control.schema_migrations WHERE version<=6 ORDER BY version',
        )
      ).rows,
      checks,
    );
    assert.deepEqual(
      (
        await admin.query(
          "SELECT prosrc,oid::text FROM pg_proc WHERE oid='fi_control.order_command_kernel(uuid,text,bigint,text,jsonb,text,text,uuid)'::regprocedure",
        )
      ).rows,
      kernel,
    );
    assert.equal((await s.apply(prepared.work)).status, 200);
    await migrate(cfg);
    assert.equal((await admin.query('SELECT * FROM fi_control.schema_migrations')).rowCount, 7);
  } finally {
    await s?.close();
    process.env.TF_DB_OWNER_FILE = original;
    await admin?.end();
    await instance.stop();
  }
});
