import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { startOwnedPostgres } from '../../scripts/owned-postgres.js';
import { bootstrap, migrate, readOwner } from '../../scripts/workflow-database.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { digest } from './rfq-fixture.js';

await test('migration 003 upgrades a populated exact Phase 2A schema without changing its receipts or references', async () => {
  const instance = await startOwnedPostgres(process.env.TF_PG_BIN);
  let app: pg.Client | undefined;
  try {
    await bootstrap(instance.path, 2);
    const owned = await readOwner(instance.path);
    app = new pg.Client({ connectionString: owned.appUrl! });
    await app.connect();
    const id = randomUUID(),
      key = randomUUID();
    const args = [id, digest('r' + id), digest('t' + id), digest('create'), key, randomUUID()];
    const created = await app.query<{ result: { status: number; body: unknown } }>(
      'SELECT fi_control.create_sandbox($1,$2,$3,$4,$5,$6) AS result',
      args,
    );
    assert.equal(created.rows[0]?.result.status, 201);
    const before = await app.query(
      'SELECT version,checksum FROM fi_control.schema_migrations ORDER BY version',
    );
    const references = await app.query('SELECT * FROM fi.instrument_versions ORDER BY id');
    const beforeRuntime = new WorkflowDatabase(owned.appUrl!);
    try {
      await assert.rejects(
        beforeRuntime.transaction(
          true,
          () => undefined,
          () => Promise.resolve(undefined),
        ),
        { code: 'SCHEMA_INCOMPATIBLE' },
      );
    } finally {
      await beforeRuntime.close();
    }
    await migrate(owned);
    assert.deepEqual(
      (
        await app.query(
          'SELECT version,checksum FROM fi_control.schema_migrations WHERE version<=2 ORDER BY version',
        )
      ).rows,
      before.rows,
    );
    assert.deepEqual(
      (await app.query('SELECT * FROM fi.instrument_versions ORDER BY id')).rows,
      references.rows,
    );
    const replay = await app.query<{
      result: { status: number; body: unknown; replayed: boolean };
    }>('SELECT fi_control.create_sandbox($1,$2,$3,$4,$5,$6) AS result', args);
    assert.equal(replay.rows[0]?.result.replayed, true);
    assert.deepEqual(replay.rows[0]?.result.body, created.rows[0]?.result.body);
    const runtime = new WorkflowDatabase(owned.appUrl!);
    try {
      await runtime.transaction(
        true,
        () => undefined,
        () => Promise.resolve(undefined),
      );
    } finally {
      await runtime.close();
    }
  } finally {
    await app?.end();
    await instance.stop();
  }
});
