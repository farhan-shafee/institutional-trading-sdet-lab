import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { startOwnedPostgres } from '../../scripts/owned-postgres.js';
import { bootstrap, migrate, readOwner } from '../../scripts/workflow-database.js';
import { digest, rfqInput } from './rfq-fixture.js';
await test('004 backfills a populated exact Phase 2B database without changing economic contracts, receipts, or migrations 001-003', async () => {
  const instance = await startOwnedPostgres(process.env.TF_PG_BIN);
  let app: pg.Client | undefined;
  try {
    await bootstrap(instance.path, 3);
    const owned = await readOwner(instance.path);
    app = new pg.Client({ connectionString: owned.appUrl! });
    await app.connect();
    const sid = randomUUID(),
      proof = digest('t' + sid),
      actor = randomUUID();
    await app.query<Record<string, unknown>>(
      'SELECT fi_control.create_sandbox($1,$2,$3,$4,$5,$6)',
      [sid, digest('r' + sid), proof, digest('create'), randomUUID(), actor],
    );
    const input = rfqInput();
    const run = async (action: string, payload: unknown) =>
      (
        await app!.query<{ result: { body: { quotes: { id: string }[] }; status: number } }>(
          'SELECT fi_control.rfq_command($1,$2,$3,$4,$5,$6,$7,$8) AS result',
          [
            sid,
            proof,
            '1',
            action,
            JSON.stringify(payload),
            digest(JSON.stringify(payload)),
            randomUUID(),
            actor,
          ],
        )
      ).rows[0]!.result;
    await run('CREATE_RFQ', input);
    const quote = await run('RESPOND_DEALER', {
      rfq_id: input.rfq_id,
      expected_version: '1',
      dealer_id: 'ATLAS',
      response: 'QUOTE',
    });
    assert.equal(
      (
        await run('ACCEPT_QUOTE', {
          rfq_id: input.rfq_id,
          expected_version: '2',
          quote_id: quote.body.quotes[0]!.id,
        })
      ).status,
      201,
    );
    const admin = new pg.Client({ connectionString: owned.adminUrl });
    await admin.connect();
    try {
      const contracts = (await admin.query<Record<string, unknown>>('SELECT * FROM fi.orders'))
          .rows,
        receipts = (
          await admin.query<Record<string, unknown>>(
            'SELECT * FROM fi.commands ORDER BY command_seq',
          )
        ).rows,
        versions = (
          await app.query<Record<string, unknown>>(
            'SELECT * FROM fi_control.schema_migrations ORDER BY version',
          )
        ).rows;
      await migrate(owned);
      assert.deepEqual(
        (await admin.query<Record<string, unknown>>('SELECT * FROM fi.orders')).rows,
        contracts,
      );
      assert.deepEqual(
        (
          await admin.query<Record<string, unknown>>(
            'SELECT * FROM fi.commands ORDER BY command_seq',
          )
        ).rows,
        receipts,
      );
      assert.deepEqual(
        (
          await app.query<Record<string, unknown>>(
            'SELECT * FROM fi_control.schema_migrations WHERE version<=3 ORDER BY version',
          )
        ).rows,
        versions,
      );
      const life = (
        await admin.query<Record<string, unknown>>(
          'SELECT status,version::text,filled_par::text FROM fi.order_states',
        )
      ).rows;
      assert.deepEqual(life, [{ status: 'PENDING_ACK', version: '1', filled_par: '0.00' }]);
      assert.equal(
        (await admin.query<Record<string, unknown>>('SELECT * FROM fi.positions')).rowCount,
        0,
      );
      assert.equal(
        (await admin.query<Record<string, unknown>>('SELECT * FROM fi.order_history')).rowCount,
        1,
      );
    } finally {
      await admin.end();
    }
  } finally {
    await app?.end();
    await instance.stop();
  }
});
