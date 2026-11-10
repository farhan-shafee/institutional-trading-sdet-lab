import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { executionSandbox, connection, randomUUID } from './fixture.js';
type Root = {
  execution_id: string;
  current_revision: number;
  active_consideration_cents: string;
  active_clean_price: string;
  busted: boolean;
  settlement_state: string;
  par_amount: string;
  side: string;
  value_date: string;
};
async function adjusted(par = '100.00', date = '2030-01-15', fillPar = par) {
  const s = await executionSandbox(par, 'BUY', 'SYN-UST-2031', date);
  try {
    assert.equal((await s.command('ACK_ORDER', { expected_version: '1' })).status, 200);
    const fill = await s.fill('2', fillPar);
    assert.equal(fill.status, 201);
    const raw = fill.body.execution!;
    const command = async (
      operation: string,
      payload: unknown,
      key: string = randomUUID(),
      db: pg.Client = s.app,
      generation = '1',
      proof = s.proof,
    ) =>
      (
        await db.query<{ r: { status: number; replayed: boolean; body: Record<string, unknown> } }>(
          'SELECT fi_control.posttrade_command($1,$2,$3,$4,$5,$6,$7) r',
          [s.id, proof, generation, operation, JSON.stringify(payload), key, s.actor],
        )
      ).rows[0]!.r;
    const read = async (post: string | null = null) =>
      (
        await s.app.query<{
          r: {
            status: number;
            body: { roots: Root[]; available_cash_cents: string; posttrade_command_seq: string };
          };
        }>("SELECT fi_control.read_posttrade($1,$2,'trade',1,NULL,$3) r", [s.id, s.proof, post])
      ).rows[0]!.r.body;
    assert.equal((await command('INITIALIZE', { economic_start_date: date })).status, 201);
    assert.equal((await command('REGISTER', { execution_id: raw.id })).status, 201);
    return { ...s, raw, post: command, read };
  } catch (error) {
    await s.close();
    throw error;
  }
}
async function rawState(db: pg.Client, id: string) {
  const result: Record<string, unknown[]> = {};
  for (const name of [
    'executions',
    'orders',
    'order_states',
    'positions',
    'commands',
    'audit_events',
    'fix_commands',
    'fix_events',
  ])
    result[name] = (
      await db.query<Record<string, unknown>>(
        'SELECT to_jsonb(x) row FROM fi.' +
          name +
          ' x WHERE sandbox_id=$1 ORDER BY to_jsonb(x)::text',
        [id],
      )
    ).rows;
  return result;
}
await test('two immutable price corrections compensate and replace exact cash while preserving every raw/order/FIX row', async () => {
  const s = await adjusted(),
    admin = await connection('admin');
  try {
    const original = await rawState(admin, s.id);
    const key = randomUUID(),
      payload = { execution_id: s.raw.id, expected_revision: 0, clean_price: '100.000000000000' };
    const first = await s.post('CORRECT_PRICE', payload, key);
    assert.equal(first.status, 201);
    assert.deepEqual((await s.post('CORRECT_PRICE', payload, key)).body, first.body);
    assert.equal((await s.post('CORRECT_PRICE', payload, key)).replayed, true);
    assert.equal(
      (await s.post('CORRECT_PRICE', { ...payload, clean_price: '101.000000000000' }, key)).status,
      409,
    );
    assert.equal((await s.post('CORRECT_PRICE', payload, key, s.app, '2')).status, 404);
    assert.equal(
      (await s.post('CORRECT_PRICE', payload, key, s.app, '1', '0'.repeat(64))).status,
      404,
    );
    const r1 = (await s.read()).roots[0]!;
    assert.equal(r1.current_revision, 1);
    assert.equal(r1.active_consideration_cents, '10000');
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          ...payload,
          expected_revision: 1,
          clean_price: '102.000000000000',
        })
      ).status,
      201,
    );
    assert.equal((await s.post('CORRECT_PRICE', { ...payload, expected_revision: 2 })).status, 409);
    const current = await s.read();
    assert.equal(current.roots[0]!.current_revision, 2);
    assert.equal(current.roots[0]!.active_consideration_cents, '10200');
    assert.equal(current.available_cash_cents, '10000000000');
    assert.deepEqual(await rawState(admin, s.id), original);
    assert.equal(
      (await s.read('2')).roots[0]!.active_consideration_cents,
      s.raw.consideration_cents,
    );
    assert.equal((await s.read('3')).roots[0]!.active_consideration_cents, '10000');
    const events = (
      await admin.query<{ t: string; n: number }>(
        'SELECT event_type t,count(*)::int n FROM fi.posttrade_events WHERE sandbox_id=$1 GROUP BY event_type ORDER BY event_type',
        [s.id],
      )
    ).rows;
    assert.deepEqual(events, [
      { t: 'COMPENSATE', n: 2 },
      { t: 'FUNDING', n: 1 },
      { t: 'REGISTERED', n: 1 },
      { t: 'REPLACEMENT', n: 2 },
    ]);
    await assert.rejects(
      admin.query(
        "UPDATE fi.posttrade_revisions SET clean_price='99.000000000000' WHERE sandbox_id=$1",
        [s.id],
      ),
      { code: '42501' },
    );
  } finally {
    await admin.end();
    await s.close();
  }
});
await test('competing expected-revision corrections serialize exactly one effect and leave one immutable receipt', async () => {
  const s = await adjusted(),
    other = await connection('app'),
    admin = await connection('admin');
  try {
    const replies = await Promise.all([
      s.post('CORRECT_PRICE', {
        execution_id: s.raw.id,
        expected_revision: 0,
        clean_price: '100.000000000000',
      }),
      s.post(
        'CORRECT_PRICE',
        { execution_id: s.raw.id, expected_revision: 0, clean_price: '101.000000000000' },
        randomUUID(),
        other,
      ),
    ]);
    assert.deepEqual(replies.map((r) => r.status).sort(), [201, 409]);
    assert.equal((await s.read()).roots[0]!.current_revision, 1);
    assert.equal(
      (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.posttrade_commands WHERE sandbox_id=$1 AND operation=$2',
          [s.id, 'CORRECT_PRICE'],
        )
      ).rows[0]!.n,
      1,
    );
  } finally {
    await admin.end();
    await other.end();
    await s.close();
  }
});
await test('terminal full bust removes an entire partial fill without reopening its parent', async () => {
  const s = await adjusted('100.00', '2030-01-15', '40.00'),
    admin = await connection('admin');
  try {
    const before = await rawState(admin, s.id);
    const payload = { execution_id: s.raw.id, expected_revision: 0 },
      key = randomUUID();
    assert.equal((await s.post('BUST', { ...payload, par_amount: '20.00' })).status, 400);
    const bust = await s.post('BUST', payload, key);
    assert.equal(bust.status, 201);
    assert.deepEqual((await s.post('BUST', payload, key)).body, bust.body);
    assert.equal((await s.post('BUST', payload)).status, 409);
    assert.equal(
      (await s.post('CORRECT_PRICE', { ...payload, clean_price: '100.000000000000' })).status,
      409,
    );
    const root = (await s.read()).roots[0]!;
    assert.equal(root.busted, true);
    assert.equal(root.settlement_state, 'VOIDED');
    assert.equal(root.par_amount, '40.00');
    assert.deepEqual(await rawState(admin, s.id), before);
    const economic = (
      await admin.query<{ cash: string; par: string }>(
        'SELECT sum(economic_cash_cents)::text cash,sum(economic_par_amount)::text par FROM fi.posttrade_events WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!;
    assert.equal(BigInt(economic.cash), 0n);
    assert.equal(Number(economic.par), 0);
  } finally {
    await admin.end();
    await s.close();
  }
});
await test('valid tiny-par correction posts zero cash cents and keeps full source quantity', async () => {
  const s = await adjusted('1.00', '2025-01-15', '0.01');
  try {
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          execution_id: s.raw.id,
          expected_revision: 0,
          clean_price: '10.000000000000',
        })
      ).status,
      201,
    );
    const root = (await s.read()).roots[0]!;
    assert.equal(root.active_consideration_cents, '0');
    assert.equal(root.par_amount, '0.01');
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          execution_id: s.raw.id,
          expected_revision: 1,
          clean_price: '5.000000000000',
        })
      ).status,
      201,
    );
    assert.equal((await s.read()).roots[0]!.active_consideration_cents, '0');
  } finally {
    await s.close();
  }
});
await test('correction rejects invented terms, noncanonical quotes, endpoint violations and wrong revisions with no receipts', async () => {
  const s = await adjusted(),
    admin = await connection('admin');
  try {
    const base = { execution_id: s.raw.id, expected_revision: 0, clean_price: '100.000000000000' };
    for (const payload of [
      { ...base, side: 'SELL' },
      { ...base, par_amount: '1.00' },
      { ...base, settlement_date: '2030-01-16' },
      { ...base, clean_price: '0100.000000000000' },
      { ...base, clean_price: '100.0' },
      { ...base, clean_price: '-1.000000000000' },
      { ...base, clean_price: '99999.000000000000' },
      { ...base, expected_revision: '0' },
      { ...base, expected_revision: 0.5 },
      { ...base, expected_revision: 3 },
    ])
      assert.equal((await s.post('CORRECT_PRICE', payload)).status, 400);
    assert.equal((await s.post('CORRECT_PRICE', { ...base, expected_revision: 1 })).status, 409);
    assert.equal(
      (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.posttrade_commands WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      2,
    );
  } finally {
    await admin.end();
    await s.close();
  }
});
await test('foreign execution roots cannot be corrected or busted under another owned capability', async () => {
  const s = await adjusted(),
    foreign = await adjusted();
  try {
    const before = await s.read();
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          execution_id: foreign.raw.id,
          expected_revision: 0,
          clean_price: '100.000000000000',
        })
      ).status,
      404,
    );
    assert.equal(
      (await s.post('BUST', { execution_id: foreign.raw.id, expected_revision: 0 })).status,
      404,
    );
    assert.deepEqual(await s.read(), before);
    assert.equal((await foreign.read()).roots[0]!.current_revision, 0);
  } finally {
    await foreign.close();
    await s.close();
  }
});
await test('correction and terminal bust contenders share one expected-revision boundary', async () => {
  const s = await adjusted(),
    other = await connection('app');
  try {
    const replies = await Promise.all([
      s.post('CORRECT_PRICE', {
        execution_id: s.raw.id,
        expected_revision: 0,
        clean_price: '100.000000000000',
      }),
      s.post('BUST', { execution_id: s.raw.id, expected_revision: 0 }, randomUUID(), other),
    ]);
    assert.deepEqual(replies.map((r) => r.status).sort(), [201, 409]);
    const root = (await s.read()).roots[0]!;
    assert.equal(root.current_revision, root.busted ? 0 : 1);
    assert.equal((await s.read()).posttrade_command_seq, '3');
  } finally {
    await other.end();
    await s.close();
  }
});
await test('immutable submitted payloads independently reconstruct hashes and registry corruption cannot commit', async () => {
  const s = await adjusted(),
    admin = await connection('admin'),
    key = randomUUID();
  try {
    assert.equal(
      (
        await s.post(
          'CORRECT_PRICE',
          { execution_id: s.raw.id, expected_revision: 0, clean_price: '100.000000000000' },
          key,
        )
      ).status,
      201,
    );
    const proof = (
      await admin.query<{ valid: boolean; n: number }>(
        `SELECT bool_and(request_hash=encode(sha256(convert_to(jsonb_build_object(
      'version','OWNED_POSTTRADE_COMMAND_V1','sandbox_id',sandbox_id,'operation',operation,'payload',request_payload)::text,'UTF8')),'hex')) valid,
      count(*)::int n FROM fi.posttrade_commands WHERE sandbox_id=$1`,
        [s.id],
      )
    ).rows[0]!;
    assert.deepEqual(proof, { valid: true, n: 3 });
    await assert.rejects(
      admin.query("UPDATE fi.posttrade_commands SET request_payload='{}' WHERE sandbox_id=$1", [
        s.id,
      ]),
      { code: '42501' },
    );
    await assert.rejects(
      admin.query(
        "UPDATE fi_control.command_keys SET domain='FINANCIAL' WHERE sandbox_id=$1 AND idempotency_key=$2",
        [s.id, key],
      ),
      { code: '23514' },
    );
    await assert.rejects(
      admin.query(
        'DELETE FROM fi_control.command_keys WHERE sandbox_id=$1 AND idempotency_key=$2',
        [s.id, key],
      ),
      { code: '23514' },
    );
    assert.equal((await s.read()).roots[0]!.current_revision, 1);
    assert.equal(
      (
        await s.post(
          'CORRECT_PRICE',
          { execution_id: s.raw.id, expected_revision: 0, clean_price: '100.000000000000' },
          key,
        )
      ).replayed,
      true,
    );
  } finally {
    await admin.end();
    await s.close();
  }
});
