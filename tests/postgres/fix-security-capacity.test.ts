import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, report, record } from './fix-fixture.js';
import { connection } from './harness.js';
import { digest, rfqInput } from './rfq-fixture.js';
void test('real roles force RLS, reject cross-sandbox proof and deny private kernels, forged contexts and immutable writes', async () => {
  const a = await fixture(),
    b = await fixture();
  const db = await connection('app');
  try {
    await a.bind();
    await b.bind();
    await db.query<Record<string, unknown>>("SELECT set_config('tradeflow.sandbox_id',$1,false)", [
      b.id,
    ]);
    assert.equal(
      (
        await db.query<Record<string, unknown>>(
          'SELECT * FROM fi.fix_bindings WHERE sandbox_id=$1',
          [a.id],
        )
      ).rowCount,
      0,
    );
    const denied = await db.query<{ result: { status: number } }>(
      'SELECT fi_control.fix_command($1,$2,$3,$4,$5,$6,$7) result',
      [
        a.id,
        b.proof,
        1,
        'CLAIM',
        JSON.stringify({ order_id: a.order, owner_id: randomUUID() }),
        randomUUID(),
        b.actor,
      ],
    );
    assert.equal(denied.rows[0]!.result.status, 404);
    for (const sql of [
      'UPDATE fi.fix_bindings SET dealer_id=dealer_id',
      'DELETE FROM fi.fix_events',
      "INSERT INTO fi_control.fix_writer_context VALUES(gen_random_uuid(),pg_current_xact_id(),'ROTATION')",
      'SELECT fi_control.order_command_kernel(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)',
      'SELECT fi_control.rotate_capabilities_kernel(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)',
    ])
      await assert.rejects(
        db.query<Record<string, unknown>>(sql),
        (e: unknown) => (e as { code?: string }).code === '42501',
      );
    const roles = await db.query<{ v: boolean }>(
      "SELECT NOT rolsuper AND NOT rolbypassrls AND NOT pg_has_role(current_user,'tf_owner','MEMBER') v FROM pg_roles WHERE rolname=current_user",
    );
    assert.equal(roles.rows[0]!.v, true);
    const tables = await db.query<{ n: number }>(
      "SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fi' AND c.relname LIKE 'fix_%' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity",
    );
    assert.equal(tables.rows[0]!.n, 14);
  } finally {
    await db.end();
    await a.close();
    await b.close();
  }
});
void test('every financial writer respects protected reservations and only authenticated rotation can use security headroom', async () => {
  const s = await fixture();
  const admin = await connection('admin');
  try {
    const other = await s.createOrder();
    const actual = (
      await admin.query<Record<string, unknown>>(
        'SELECT command_count FROM fi.sandboxes WHERE id=$1',
        [s.id],
      )
    ).rows[0]!.command_count as number;
    for (let i = actual; i < 485; i++)
      assert.equal(
        (await s.command('ACK_ORDER', { order_id: other, expected_version: '999' })).status,
        409,
      );
    assert.equal((await s.bind()).status, 201);
    assert.equal(
      (await s.fix('BIND', { order_id: other, dealer_id: 'ATLAS', channel_id: randomUUID() }))
        .status,
      429,
    );
    assert.equal(
      (await s.command('ACK_ORDER', { order_id: other, expected_version: '1' })).status,
      429,
    );
    const before = (
      await admin.query<Record<string, unknown>>(
        'SELECT count(*)::int n FROM fi.rfqs WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows;
    await assert.rejects(
      s.app.query<Record<string, unknown>>(
        'SELECT fi_control.rfq_command($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          s.id,
          s.proof,
          1,
          'CREATE_RFQ',
          JSON.stringify(rfqInput()),
          digest('x'),
          randomUUID(),
          s.actor,
        ],
      ),
      (e: unknown) => (e as { code?: string }).code === 'TF429',
    );
    assert.deepEqual(
      (
        await admin.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi.rfqs WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows,
      before,
    );
    const newRead = digest(randomUUID()),
      newTrade = digest(randomUUID());
    const rotated = await s.app.query<{ r: { status: number } }>(
      'SELECT fi_control.rotate_capabilities($1,$2,1,1,$3,$4,$5,$6,$7) r',
      [s.id, s.proof, newRead, newTrade, digest('rotate'), randomUUID(), s.actor],
    );
    assert.equal(rotated.rows[0]!.r.status, 200);
    assert.equal((await s.fix('CLAIM', { order_id: s.order, owner_id: randomUUID() })).status, 404);
    assert.equal(
      (
        await admin.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi_control.fix_writer_context',
        )
      ).rows[0]!.n,
      0,
    );
    assert.deepEqual(
      (
        await admin.query<Record<string, unknown>>(
          'SELECT commands,events FROM fi_control.fix_reservations WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows,
      [{ commands: 25, events: 43 }],
    );
  } finally {
    await admin.end();
    await s.close();
  }
});
void test('rotated proof/fence cannot prepare and current generation can fence out an old lease without changing payloads', async () => {
  const s = await fixture();
  try {
    await s.bind();
    const msg = await record(s, await report(s)),
      work = randomUUID(),
      owner = randomUUID();
    await s.fix('QUEUE', { order_id: s.order, message_id: msg.body['message_id'], work_id: work });
    const lease = await s.fix('CLAIM', { order_id: s.order, owner_id: owner });
    const trade = digest(randomUUID());
    await s.app.query<Record<string, unknown>>(
      'SELECT fi_control.rotate_capabilities($1,$2,1,1,$3,$4,$5,$6,$7)',
      [s.id, s.proof, digest(randomUUID()), trade, digest('rotated'), randomUUID(), s.actor],
    );
    assert.equal(
      (
        await s.fix('PREPARE', {
          order_id: s.order,
          owner_id: owner,
          fence: lease.body['fence'],
          work_id: work,
          financial_key: randomUUID(),
        })
      ).status,
      404,
    );
    const r = await s.app.query<{ r: { status: number; body: { fence: string } } }>(
      'SELECT fi_control.fix_command($1,$2,2,$3,$4,$5,$6) r',
      [
        s.id,
        trade,
        'CLAIM',
        JSON.stringify({ order_id: s.order, owner_id: owner }),
        randomUUID(),
        s.actor,
      ],
    );
    assert.equal(r.rows[0]!.r.status, 200);
    assert.equal(r.rows[0]!.r.body.fence, '2');
    const bad = await s.app.query<{ r: { status: number } }>(
      'SELECT fi_control.fix_command($1,$2,2,$3,$4,$5,$6) r',
      [
        s.id,
        trade,
        'PREPARE',
        JSON.stringify({
          order_id: s.order,
          owner_id: owner,
          fence: '1',
          work_id: work,
          financial_key: randomUUID(),
        }),
        randomUUID(),
        s.actor,
      ],
    );
    assert.equal(bad.rows[0]!.r.status, 409);
  } finally {
    await s.close();
  }
});
void test('expiry preserves replay; safe pristine release restores reservation capacity but never reopens a driver', async () => {
  const s = await fixture();
  const admin = await connection('admin');
  try {
    const p = { order_id: s.order, dealer_id: 'ATLAS', channel_id: s.channel },
      key = randomUUID();
    await s.fix('BIND', p, key);
    const rel = await s.fix('RELEASE', { order_id: s.order });
    assert.equal(rel.status, 200);
    assert.equal((await s.command('ACK_ORDER', { expected_version: '1' })).status, 409);
    assert.equal(
      (
        await admin.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi_control.fix_reservations WHERE sandbox_id=$1 AND released_at IS NULL',
          [s.id],
        )
      ).rows[0]!.n,
      0,
    );
    await admin.query<Record<string, unknown>>(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '8 days',write_expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",
      [s.id],
    );
    assert.equal((await s.fix('BIND', p, key)).replayed, true);
    assert.equal((await s.fix('CLAIM', { order_id: s.order, owner_id: randomUUID() })).status, 409);
  } finally {
    await admin.end();
    await s.close();
  }
});
for (const bindFirst of [true, false])
  void test(`deterministic manual/FIX driver race commits ${bindFirst ? 'binding' : 'manual acknowledgment'} first`, async () => {
    const s = await fixture(),
      first = await connection('app'),
      second = await connection('app'),
      monitor = await connection('admin');
    let pending: Promise<unknown> | undefined;
    try {
      const pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
      await first.query('BEGIN');
      const p = { order_id: s.order, dealer_id: 'ATLAS', channel_id: s.channel };
      if (bindFirst) assert.equal((await s.fix('BIND', p, randomUUID(), first)).status, 201);
      else
        assert.equal(
          (await s.command('ACK_ORDER', { expected_version: '1' }, randomUUID(), first)).status,
          200,
        );
      const next = bindFirst
        ? s.command('ACK_ORDER', { expected_version: '1' }, randomUUID(), second)
        : s.fix('BIND', p, randomUUID(), second);
      pending = next;
      const deadline = performance.now() + 1000;
      let blocked = false;
      while (performance.now() < deadline) {
        if (
          (
            await monitor.query<{ b: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 b', [
              pid,
            ])
          ).rows[0]!.b
        ) {
          blocked = true;
          break;
        }
        await new Promise<void>((r) => setImmediate(r));
      }
      assert.equal(blocked, true);
      await first.query('COMMIT');
      const result = await next;
      assert.equal(result.status, 409);
      assert.equal(
        (
          await s.app.query<{ status: string }>(
            'SELECT status FROM fi.order_states WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0]!.status,
        bindFirst ? 'PENDING_ACK' : 'NEW',
      );
      assert.equal(
        (
          await s.app.query<{ n: number }>(
            'SELECT count(*)::int n FROM fi.fix_bindings WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0]!.n,
        bindFirst ? 1 : 0,
      );
    } finally {
      await first.query('ROLLBACK');
      await pending?.catch(() => {});
      await first.end();
      await second.end();
      await monitor.end();
      await s.close();
    }
  });
void test('reclaim after lease expiry preserves prepared payload/key and blocks stale owners without rebasing', async () => {
  const s = await fixture(),
    admin = await connection('admin');
  try {
    await s.bind();
    const m = await record(s, await report(s)),
      work = randomUUID(),
      owner = randomUUID();
    await s.fix('QUEUE', { order_id: s.order, message_id: m.body['message_id'], work_id: work });
    const claim = await s.fix('CLAIM', { order_id: s.order, owner_id: owner });
    const p = {
        order_id: s.order,
        owner_id: owner,
        fence: claim.body['fence'],
        work_id: work,
        financial_key: randomUUID(),
      },
      key = randomUUID();
    const original = await s.fix('PREPARE', p, key);
    assert.equal(original.status, 201);
    await admin.query(
      "UPDATE fi.fix_lanes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1",
      [s.id],
    );
    const current = await s.fix('CLAIM', { order_id: s.order, owner_id: randomUUID() });
    assert.equal(current.body['fence'], '2');
    const replay = await s.fix('PREPARE', p, key);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, original.body);
    assert.equal((await s.fix('PREPARE', p)).status, 409);
    assert.equal(
      (
        await s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_prepared WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      1,
    );
  } finally {
    await admin.end();
    await s.close();
  }
});
void test('bound-order guard preserves the existing financial invalid-command validation contract', async () => {
  const s = await fixture();
  try {
    await s.bind();
    for (const action of [null, 'UNSUPPORTED', 'ACK_ORDER']) {
      const p =
        action === 'ACK_ORDER'
          ? { order_id: s.order, expected_version: 'not-a-version' }
          : { order_id: s.order, expected_version: '1' };
      const r = await s.app.query<{ r: { status: number } }>(
        'SELECT fi_control.order_command($1,$2,1,$3,$4,$5,$6,$7) r',
        [s.id, s.proof, action, JSON.stringify(p), digest('invalid'), randomUUID(), s.actor],
      );
      assert.equal(r.rows[0]!.r.status, 400);
    }
  } finally {
    await s.close();
  }
});
void test('review: UUID aliases cannot bypass a bound order driver', async () => {
  const s = await fixture();
  try {
    await s.bind();
    for (const alias of [s.order.toUpperCase(), s.order.replaceAll('-', ''), '{' + s.order + '}']) {
      const r = await s.app.query<{ r: { status: number } }>(
        'SELECT fi_control.order_command($1,$2,1,$3,$4,$5,$6,$7) r',
        [
          s.id,
          s.proof,
          'ACK_ORDER',
          JSON.stringify({ order_id: alias, expected_version: '1' }),
          digest('alias'),
          randomUUID(),
          s.actor,
        ],
      );
      assert.equal(r.rows[0]!.r.status, 409);
    }
  } finally {
    await s.close();
  }
});
void test('review: a trade cannot freeze a financial preparation before acknowledgment', async () => {
  const s = await fixture();
  try {
    await s.bind();
    const base = await report(s),
      m = await record(s, {
        ...base,
        '150': 'F',
        '39': '1',
        '14': '40.00',
        '151': '60.00',
        '32': '40.00',
        '31': base['44'],
        '6': base['44'],
      }),
      work = randomUUID(),
      owner = randomUUID();
    await s.fix('QUEUE', { order_id: s.order, message_id: m.body['message_id'], work_id: work });
    const lease = await s.fix('CLAIM', { order_id: s.order, owner_id: owner });
    assert.equal(
      (
        await s.fix('PREPARE', {
          order_id: s.order,
          work_id: work,
          owner_id: owner,
          fence: lease.body['fence'],
          financial_key: randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_prepared WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      0,
    );
  } finally {
    await s.close();
  }
});
