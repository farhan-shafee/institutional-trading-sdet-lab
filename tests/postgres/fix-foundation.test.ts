import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connection } from './harness.js';
import { fixture } from './fix-fixture.js';
void test('FIX binding reserves capacity and locks the immutable pending order to its accepted dealer without financial effects', async () => {
  const s = await fixture();
  try {
    const before = await s.app.query<Record<string, unknown>>(
      'SELECT command_count,event_count,commit_seq FROM fi.sandboxes WHERE id=$1',
      [s.id],
    );
    const r = await s.bind();
    assert.equal(r.status, 201);
    const rows = await s.app.query<Record<string, unknown>>(
      'SELECT * FROM fi.fix_bindings WHERE sandbox_id=$1',
      [s.id],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0]!.cl_ord_id, s.order);
    assert.equal(rows.rows[0]!.dealer_id, 'ATLAS');
    assert.equal(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi.fix_dealer_correlations WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      0,
    );
    assert.deepEqual(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT command_count,event_count,commit_seq FROM fi.sandboxes WHERE id=$1',
          [s.id],
        )
      ).rows,
      before.rows,
    );
    assert.equal((await s.command('ACK_ORDER', { expected_version: '1' })).status, 409);
    assert.equal(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT status FROM fi.order_states WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.status,
      'PENDING_ACK',
    );
    assert.equal(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi.executions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      0,
    );
  } finally {
    await s.close();
  }
});
void test('wrong dealer, foreign ownership and conflicting idempotency fail without mutation; original key replays', async () => {
  const s = await fixture();
  try {
    assert.equal(
      (await s.fix('BIND', { order_id: s.order, dealer_id: 'BIRCH', channel_id: s.channel }))
        .status,
      409,
    );
    assert.equal(
      (await s.fix('BIND', { order_id: randomUUID(), dealer_id: 'ATLAS', channel_id: s.channel }))
        .status,
      404,
    );
    const p = { order_id: s.order, dealer_id: 'ATLAS', channel_id: s.channel },
      key = randomUUID();
    assert.equal((await s.fix('BIND', p, key)).status, 201);
    assert.equal((await s.fix('BIND', p, key)).replayed, true);
    assert.equal((await s.fix('BIND', { ...p, dealer_id: 'CEDAR' }, key)).status, 409);
  } finally {
    await s.close();
  }
});
void test('twenty independent concurrent bindings reserve exactly one owned order', async () => {
  const s = await fixture();
  const clients = await Promise.all(Array.from({ length: 20 }, () => connection('app')));
  try {
    const results = await Promise.all(
      clients.map((db) =>
        s.fix(
          'BIND',
          { order_id: s.order, dealer_id: 'ATLAS', channel_id: s.channel },
          randomUUID(),
          db,
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 19);
    const admin = await connection('admin');
    try {
      const r = await admin.query<Record<string, unknown>>(
        'SELECT sum(commands)::int c,sum(events)::int e FROM fi_control.fix_reservations WHERE sandbox_id=$1 AND released_at IS NULL',
        [s.id],
      );
      assert.deepEqual(r.rows, [{ c: 25, e: 43 }]);
    } finally {
      await admin.end();
    }
  } finally {
    await Promise.all(clients.map((c) => c.end()));
    await s.close();
  }
});
import { report, record } from './fix-fixture.js';
void test('durable receipt/economic identity survives physical retransmission; changed economic fields conflict', async () => {
  const s = await fixture();
  try {
    await s.bind();
    const f = await report(s),
      a = await record(s, f);
    assert.equal(a.status, 201);
    const replay = await record(s, {
      ...f,
      '43': 'Y',
      '122': f['52'],
      '52': '20261030-12:01:00.000',
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.body['message_id'], a.body['message_id']);
    assert.equal((await record(s, { ...f, '34': '2' })).body['message_id'], a.body['message_id']);
    const conflicting = { ...f, '34': '3', '150': '8', '39': '8', '151': '0.00', '103': '99' };
    assert.equal((await record(s, conflicting)).status, 409);
    assert.equal(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi.fix_messages WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi.fix_attempts WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      3,
    );
    assert.equal(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi.executions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      0,
    );
  } finally {
    await s.close();
  }
});
void test('ordered prepared head retains original financial identities and blocks later work and all FIX application', async () => {
  const s = await fixture();
  try {
    await s.bind();
    const a = await record(s, await report(s)),
      b = await record(
        s,
        await report(s, {
          '34': '2',
          '150': 'F',
          '39': '1',
          '14': '40.00',
          '151': '60.00',
          '32': '40.00',
          '31': (await report(s))['44'],
          '6': (await report(s))['44'],
        }),
      );
    assert.equal(b.status, 201);
    const work = randomUUID(),
      later = randomUUID(),
      owner = randomUUID();
    assert.equal(
      (await s.fix('QUEUE', { order_id: s.order, message_id: a.body['message_id'], work_id: work }))
        .status,
      201,
    );
    assert.equal(
      (
        await s.fix('QUEUE', {
          order_id: s.order,
          message_id: b.body['message_id'],
          work_id: later,
        })
      ).status,
      201,
    );
    const claim = await s.fix('CLAIM', { order_id: s.order, owner_id: owner });
    assert.equal(claim.status, 200);
    const key = randomUUID(),
      finKey = randomUUID(),
      p = {
        order_id: s.order,
        owner_id: owner,
        fence: claim.body['fence'],
        work_id: work,
        financial_key: finKey,
      };
    assert.equal((await s.fix('PREPARE', { ...p, work_id: later })).status, 409);
    const prepared = await s.fix('PREPARE', p, key);
    assert.equal(prepared.status, 201);
    assert.deepEqual(prepared.body['payload'], { order_id: s.order, expected_version: '1' });
    assert.deepEqual((await s.fix('PREPARE', p, key)).body, prepared.body);
    assert.equal(
      (
        await s.fix('RESOLVE_METADATA', {
          order_id: s.order,
          owner_id: owner,
          fence: claim.body['fence'],
          work_id: work,
        })
      ).status,
      409,
    );
    assert.equal((await s.fix('RELEASE', { order_id: s.order })).status, 409);
    assert.equal((await s.command('ACK_ORDER', { expected_version: '1' }, finKey)).status, 409);
    assert.equal(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT status FROM fi.order_states WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.status,
      'PENDING_ACK',
    );
  } finally {
    await s.close();
  }
});
void test('twenty independent claim contenders produce one fenced lane owner', async () => {
  const s = await fixture();
  const clients = await Promise.all(Array.from({ length: 20 }, () => connection('app')));
  try {
    await s.bind();
    const r = await Promise.all(
      clients.map((db) =>
        s.fix('CLAIM', { order_id: s.order, owner_id: randomUUID() }, randomUUID(), db),
      ),
    );
    assert.equal(r.filter((x) => x.status === 200).length, 1);
    assert.equal(r.filter((x) => x.status === 409).length, 19);
    assert.equal(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT fence::text FROM fi.fix_lanes WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.fence,
      '1',
    );
  } finally {
    await Promise.all(clients.map((c) => c.end()));
    await s.close();
  }
});
void test('metadata-only head can resolve without acknowledging or filling the economic order', async () => {
  const s = await fixture();
  try {
    await s.bind();
    const cancel = randomUUID(),
      f = await report(s, { '11': cancel, '41': s.order, '150': '6', '39': '6' }),
      m = await record(s, f),
      work = randomUUID(),
      owner = randomUUID();
    assert.equal(m.status, 201);
    await s.fix('QUEUE', { order_id: s.order, message_id: m.body['message_id'], work_id: work });
    const lease = await s.fix('CLAIM', { order_id: s.order, owner_id: owner });
    const p = { order_id: s.order, owner_id: owner, fence: lease.body['fence'], work_id: work };
    assert.equal((await s.fix('PREPARE', { ...p, financial_key: randomUUID() })).status, 201);
    assert.equal((await s.fix('RESOLVE_METADATA', p)).status, 200);
    assert.equal(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT status FROM fi.order_states WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.status,
      'PENDING_ACK',
    );
    assert.equal(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi.positions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      0,
    );
  } finally {
    await s.close();
  }
});
void test('NewOrderSingle and cancellation bytes are staged without delivery, duplicate orders or invented dealer/report IDs', async () => {
  const s = await fixture();
  try {
    await s.bind();
    const base: Record<string, string> = await report(s),
      header = ['35', '49', '56', '34', '52'];
    const d = Object.fromEntries(
      [
        ...header,
        '11',
        '55',
        '167',
        '54',
        '854',
        '38',
        '40',
        '59',
        '423',
        '44',
        '15',
        '64',
        '60',
      ].map((t) => [t, base[t]!]),
    );
    Object.assign(d, { '35': 'D', '49': 'TRADEFLOW', '56': 'ATLAS' });
    assert.equal((await record(s, d)).status, 201);
    assert.equal(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi.fix_dealer_correlations WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      0,
    );
    await record(s, base);
    const cancel = randomUUID();
    const f = Object.fromEntries(
      [...header, '37', '55', '167', '54', '38', '60'].map((t) => [t, base[t]!]),
    );
    Object.assign(f, {
      '35': 'F',
      '49': 'TRADEFLOW',
      '56': 'ATLAS',
      '34': '2',
      '11': cancel,
      '41': s.order,
    });
    assert.equal((await record(s, f)).status, 201);
    const rejection = Object.fromEntries([...header, '37', '60'].map((t) => [t, base[t]!]));
    Object.assign(rejection, {
      '35': '9',
      '34': '2',
      '11': cancel,
      '41': s.order,
      '39': '0',
      '434': '1',
      '102': '99',
    });
    assert.equal((await record(s, rejection)).status, 201);
    const intents = await s.app.query<Record<string, unknown>>(
      'SELECT delivery_state FROM fi.fix_outbox WHERE sandbox_id=$1',
      [s.id],
    );
    assert.deepEqual(intents.rows, [
      { delivery_state: 'NOT_IMPLEMENTED' },
      { delivery_state: 'NOT_IMPLEMENTED' },
    ]);
    assert.equal(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi.orders WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi.fix_cancel_correlations WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      1,
    );
  } finally {
    await s.close();
  }
});
void test('physical attempt and metadata receipt quotas reject atomically while original receipt remains readable', async () => {
  const s = await fixture();
  try {
    await s.bind();
    const f = await report(s),
      key = randomUUID(),
      p = {
        order_id: s.order,
        attempt_id: randomUUID(),
        raw_hex: (await import('../../app/protocol/fix44/index.js')).encodeFix44(f).toString('hex'),
      };
    const original = await s.fix('RECORD', p, key);
    assert.equal(original.status, 201);
    for (let i = 0; i < 3; i++) assert.equal((await record(s, f)).status, 201);
    const count = (
      await s.app.query<Record<string, unknown>>(
        'SELECT count(*)::int n FROM fi.fix_commands WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.n;
    assert.equal((await record(s, f)).status, 429);
    assert.equal(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi.fix_commands WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      count,
    );
    for (let i = Number(count); i < 960; i++) assert.equal((await s.fix('RECORD', p)).status, 201);
    assert.equal((await s.fix('RECORD', p)).status, 429);
    assert.equal((await s.fix('RECORD', p, key)).replayed, true);
    assert.equal((await s.fix('CLAIM', { order_id: s.order, owner_id: randomUUID() })).status, 200);
  } finally {
    await s.close();
  }
});
