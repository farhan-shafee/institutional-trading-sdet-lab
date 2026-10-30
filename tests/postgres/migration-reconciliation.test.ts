import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { startOwnedPostgres } from '../../scripts/owned-postgres.js';
import { bootstrap, migrate, readOwner } from '../../scripts/workflow-database.js';
import { digest, rfqInput } from './rfq-fixture.js';
await test('005 upgrades populated Phase 2C contracts, execution ledger, projections, audit and receipts byte-for-byte and backfills global command keys', async () => {
  const instance = await startOwnedPostgres(process.env.TF_PG_BIN);
  let app: pg.Client | undefined, admin: pg.Client | undefined;
  try {
    await bootstrap(instance.path, 4);
    const owned = await readOwner(instance.path);
    app = new pg.Client({ connectionString: owned.appUrl });
    admin = new pg.Client({ connectionString: owned.adminUrl });
    await app.connect();
    await admin.connect();
    const sid = randomUUID(),
      proof = digest('trade' + sid),
      actor = randomUUID();
    await app.query<Record<string, unknown>>(
      'SELECT fi_control.create_sandbox($1,$2,$3,$4,$5,$6)',
      [sid, digest('read' + sid), proof, digest('create'), randomUUID(), actor],
    );
    const command = async (fn: string, action: string, p: unknown) =>
      (
        await app!.query<{
          result: { status: number; body: { quotes: { id: string }[]; order: { id: string } } };
        }>(`SELECT fi_control.${fn}($1,$2,$3,$4,$5,$6,$7,$8) AS result`, [
          sid,
          proof,
          '1',
          action,
          JSON.stringify(p),
          digest(JSON.stringify({ action, p })),
          randomUUID(),
          actor,
        ])
      ).rows[0]!.result;
    const rfq = rfqInput();
    await command('rfq_command', 'CREATE_RFQ', rfq);
    const quoted = await command('rfq_command', 'RESPOND_DEALER', {
      rfq_id: rfq.rfq_id,
      expected_version: '1',
      dealer_id: 'ATLAS',
      response: 'QUOTE',
    });
    const accepted = await command('rfq_command', 'ACCEPT_QUOTE', {
      rfq_id: rfq.rfq_id,
      expected_version: '2',
      quote_id: quoted.body.quotes[0]!.id,
    });
    assert.equal(accepted.status, 201);
    const order = accepted.body.order.id;
    await command('order_command', 'ACK_ORDER', { order_id: order, expected_version: '1' });
    assert.equal(
      (
        await command('order_command', 'EXECUTE_ORDER', {
          order_id: order,
          expected_version: '2',
          execution_id: randomUUID(),
          source_event_id: randomUUID(),
          par_amount: '100.00',
        })
      ).status,
      201,
    );
    const tables = [
      'orders',
      'order_states',
      'executions',
      'positions',
      'commands',
      'audit_events',
      'order_history',
      'quotes',
      'rfqs',
    ];
    const before = new Map<string, unknown>();
    for (const t of tables)
      before.set(
        t,
        (
          await admin.query<Record<string, unknown>>(
            `SELECT to_jsonb(t) AS row FROM fi.${t} t ORDER BY to_jsonb(t)::text`,
          )
        ).rows,
      );
    const versions = (
      await app.query<Record<string, unknown>>(
        'SELECT * FROM fi_control.schema_migrations ORDER BY version',
      )
    ).rows;
    await migrate(owned);
    for (const t of tables)
      assert.deepEqual(
        (
          await admin.query<Record<string, unknown>>(
            `SELECT to_jsonb(t) AS row FROM fi.${t} t ORDER BY to_jsonb(t)::text`,
          )
        ).rows,
        before.get(t),
        t,
      );
    assert.deepEqual(
      (
        await app.query<Record<string, unknown>>(
          'SELECT * FROM fi_control.schema_migrations WHERE version<=4 ORDER BY version',
        )
      ).rows,
      versions,
    );
    assert.equal(
      (await admin.query('SELECT * FROM fi_control.command_keys WHERE sandbox_id=$1', [sid]))
        .rowCount,
      6,
    );
    assert.equal((await admin.query('SELECT * FROM fi.reconciliation_runs')).rowCount, 0);
    await migrate(owned);
    assert.equal((await app.query('SELECT * FROM fi_control.schema_migrations')).rowCount, 5);
  } finally {
    await app?.end();
    await admin?.end();
    await instance.stop();
  }
});
