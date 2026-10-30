import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { connection, scalar } from './harness.js';
import { rfqInput, sandbox } from './rfq-fixture.js';

await test('additive RFQ schema has three frozen fictional dealers and no application writes', async () => {
  const admin = await connection('admin'),
    app = await connection('app');
  try {
    assert.notEqual(
      await scalar(
        admin,
        "SELECT to_regprocedure('fi_control.rfq_command(uuid,text,bigint,text,jsonb,text,text,uuid)')::text",
      ),
      null,
    );
    assert.deepEqual((await app.query('SELECT id FROM fi.dealers ORDER BY id')).rows, [
      { id: 'ATLAS' },
      { id: 'BIRCH' },
      { id: 'CEDAR' },
    ]);
    for (const table of ['rfqs', 'invitations', 'quotes', 'orders']) {
      assert.equal(
        await scalar(
          admin,
          `SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='fi.${table}'::regclass`,
        ),
        true,
      );
      assert.equal(await scalar(app, `SELECT count(*)::int FROM fi.${table}`), 0);
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
        assert.equal(
          await scalar(
            app,
            `SELECT has_table_privilege(current_user,'fi.${table}','${privilege}')`,
          ),
          false,
        );
      await assert.rejects(app.query(`DELETE FROM fi.${table}`), { code: '42501' });
    }
  } finally {
    await app.end();
    await admin.end();
  }
});

await test('twenty independently connected competing accepts commit one order and a complete three-event receipt', async () => {
  const f = await sandbox();
  const clients = await Promise.all(Array.from({ length: 20 }, () => connection('app')));
  const reader = await connection('reconciler');
  try {
    const input = rfqInput();
    assert.equal((await f.command('CREATE_RFQ', input)).status, 201);
    const a = await f.command('RESPOND_DEALER', {
      rfq_id: input.rfq_id,
      expected_version: '1',
      dealer_id: 'ATLAS',
      response: 'QUOTE',
    });
    assert.equal(a.status, 200);
    const b = await f.command('RESPOND_DEALER', {
      rfq_id: input.rfq_id,
      expected_version: '2',
      dealer_id: 'BIRCH',
      response: 'QUOTE',
    });
    assert.equal(b.status, 200);
    const quotes = b.body.quotes;
    assert.equal(quotes.length, 2);
    const keys = clients.map(() => randomUUID());
    const payloads = clients.map((_, i) => ({
      rfq_id: input.rfq_id,
      expected_version: '3',
      quote_id: quotes[i % 2]!.id,
    }));
    const outcomes = await Promise.all(
      clients.map((db, i) => f.command('ACCEPT_QUOTE', payloads[i], keys[i], db)),
    );
    assert.equal(outcomes.filter((r) => r.status === 201).length, 1);
    assert.equal(outcomes.filter((r) => r.status === 409).length, 19);
    const winner = outcomes.findIndex((r) => r.status === 201);
    const replay = await f.command('ACCEPT_QUOTE', payloads[winner], keys[winner]);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, outcomes[winner]!.body);
    assert.equal(
      (
        await f.command(
          'ACCEPT_QUOTE',
          { ...payloads[winner], expected_version: '4' },
          keys[winner],
        )
      ).body.error?.code,
      'IDEMPOTENCY_KEY_REUSED',
    );
    const economic = await reader.query<{
      status: string;
      contract: Record<string, unknown>;
      ask_clean_price: string;
      state: string;
      winner: boolean;
    }>(
      'SELECT o.status,o.contract,q.ask_clean_price,r.state,r.accepted_quote_id=q.id AS winner FROM fi.orders o JOIN fi.rfqs r ON (r.sandbox_id,r.id)=(o.sandbox_id,o.rfq_id) JOIN fi.quotes q ON (q.sandbox_id,q.id)=(o.sandbox_id,o.quote_id) WHERE o.sandbox_id=$1',
      [f.id],
    );
    assert.equal(economic.rowCount, 1);
    assert.equal(economic.rows[0]!.status, 'PENDING_ACK');
    assert.equal(economic.rows[0]!.state, 'ACCEPTED');
    assert.equal(economic.rows[0]!.winner, true);
    const contract = economic.rows[0]!.contract;
    assert.equal(contract.clean_price, economic.rows[0]!.ask_clean_price);
    assert.equal(contract.par_amount, '1000000.25');
    assert.equal(contract.settlement_date, '2028-02-29');
    assert.equal(contract.instrument_revision, 'phase1-ust-1');
    assert.equal(contract.side, 'BUY');
    const events = await reader.query<{ event_type: string; event_index: number }>(
      'SELECT event_type,event_index FROM fi.audit_events WHERE sandbox_id=$1 AND command_seq=(SELECT command_seq FROM fi.commands WHERE sandbox_id=$1 AND idempotency_key=$2) ORDER BY event_index',
      [f.id, keys[winner]],
    );
    assert.deepEqual(
      events.rows.map((r) => r.event_type),
      ['QUOTE_ACCEPTED', 'RFQ_ACCEPTED', 'ORDER_CREATED'],
    );
    assert.deepEqual(
      events.rows.map((r) => r.event_index),
      [0, 1, 2],
    );
    for (const name of ['foundation', 'rfq']) {
      const sql = await readFile(
        new URL(`../../verification/sql/${name}.sql`, import.meta.url),
        'utf8',
      );
      assert.equal((await reader.query(sql)).rowCount, 0);
    }
    const before = await reader.query(
      'SELECT count(*)::int AS n FROM fi.commands WHERE sandbox_id=$1',
      [f.id],
    );
    await f.app.query('BEGIN');
    const rolled = await f.command('CREATE_RFQ', rfqInput());
    assert.equal(rolled.status, 201);
    await f.app.query('ROLLBACK');
    assert.deepEqual(
      (await reader.query('SELECT count(*)::int AS n FROM fi.commands WHERE sandbox_id=$1', [f.id]))
        .rows,
      before.rows,
    );
  } finally {
    await reader.end();
    await Promise.all(clients.map((db) => db.end()));
    await f.close();
  }
});

await test('invitations, terminal declines, withdrawn and expired quotes reject commands without financial changes', async () => {
  const f = await sandbox();
  const admin = await connection('admin');
  try {
    const input = { ...rfqInput('SELL', 'SYN-CORP-2031'), invited_dealers: ['ATLAS', 'BIRCH'] };
    assert.equal((await f.command('CREATE_RFQ', input)).status, 201);
    assert.equal(
      (
        await f.command('RESPOND_DEALER', {
          rfq_id: input.rfq_id,
          expected_version: '1',
          dealer_id: 'CEDAR',
          response: 'QUOTE',
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.command('RESPOND_DEALER', {
          rfq_id: input.rfq_id,
          expected_version: '1',
          dealer_id: 'ATLAS',
          response: 'DECLINE',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.command('RESPOND_DEALER', {
          rfq_id: input.rfq_id,
          expected_version: '2',
          dealer_id: 'ATLAS',
          response: 'QUOTE',
        })
      ).status,
      409,
    );
    const quoted = await f.command('RESPOND_DEALER', {
      rfq_id: input.rfq_id,
      expected_version: '2',
      dealer_id: 'BIRCH',
      response: 'QUOTE',
    });
    assert.equal(quoted.status, 200);
    const quote = quoted.body.quotes[0]!;
    assert.equal(quote.bid_clean_price, '98.940000000123');
    assert.equal(
      (
        await f.command('WITHDRAW_QUOTE', {
          rfq_id: input.rfq_id,
          expected_version: '3',
          quote_id: quote.id,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.command('ACCEPT_QUOTE', {
          rfq_id: input.rfq_id,
          expected_version: '4',
          quote_id: quote.id,
        })
      ).status,
      409,
    );
    await admin.query(
      "UPDATE fi.rfqs SET expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1 AND id=$2",
      [f.id, input.rfq_id],
    );
    assert.equal(
      (
        await f.command('ACCEPT_QUOTE', {
          rfq_id: input.rfq_id,
          expected_version: '4',
          quote_id: quote.id,
        })
      ).body.error?.code,
      'RFQ_EXPIRED',
    );
    assert.equal(
      await scalar(admin, `SELECT count(*)::int FROM fi.orders WHERE sandbox_id='${f.id}'`),
      0,
    );
  } finally {
    await admin.end();
    await f.close();
  }
});

await test('same-key concurrent acceptance replay, SELL bid precision and authorization survive a fresh connection', async () => {
  const f = await sandbox(),
    reader = await connection('reconciler');
  const others = await Promise.all(Array.from({ length: 20 }, () => connection('app')));
  try {
    const input = rfqInput('SELL', 'SYN-CORP-2031');
    assert.equal((await f.command('CREATE_RFQ', input)).status, 201);
    const response = await f.command('RESPOND_DEALER', {
      rfq_id: input.rfq_id,
      expected_version: '1',
      dealer_id: 'CEDAR',
      response: 'QUOTE',
    });
    const payload = {
        rfq_id: input.rfq_id,
        expected_version: '2',
        quote_id: response.body.quotes[0]!.id,
      },
      key = randomUUID();
    const results = await Promise.all(
      others.map((db) => f.command('ACCEPT_QUOTE', payload, key, db)),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 20);
    assert.equal(results.filter((r) => !r.replayed).length, 1);
    assert.equal(results[0]!.body.order!.contract.clean_price, '98.930000000123');
    assert.equal(results[0]!.body.order!.contract.model_version, 'synthetic-dealer-grid-v1');
    assert.equal((await f.command('ACCEPT_QUOTE', payload, key, others[0], '2')).status, 404);
    const foreign = { ...payload, rfq_id: randomUUID() };
    assert.equal((await f.command('ACCEPT_QUOTE', foreign)).status, 404);
    assert.equal(
      (await reader.query('SELECT * FROM fi.orders WHERE sandbox_id=$1', [f.id])).rowCount,
      1,
    );
    await assert.rejects(others[0]!.query('UPDATE fi.orders SET status=status'), { code: '42501' });
    await assert.rejects(others[0]!.query('UPDATE fi.quotes SET bid_clean_price=bid_clean_price'), {
      code: '42501',
    });
  } finally {
    await reader.end();
    await Promise.all(others.map((db) => db.end()));
    await f.close();
  }
});
