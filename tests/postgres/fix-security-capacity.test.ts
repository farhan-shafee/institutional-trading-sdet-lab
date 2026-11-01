import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { durableFixSnapshot } from './fix-recovery-evidence.js';
import { fixture, report, record } from './fix-fixture.js';
import { connection, owner } from './harness.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { RfqService } from '../../app/server/fixed-income-workflow/rfq-service.js';
import { DomainError } from '../../app/domain/errors.js';
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

void test('distinct-order BIND contenders admit only the final retained slot without partial state', async () => {
  const s = await fixture(),
    holder = await connection('admin'),
    monitor = await connection('admin');
  const clients: Awaited<ReturnType<typeof connection>>[] = [];
  let holding = false;
  let pending: Promise<Awaited<ReturnType<typeof s.fix>>[]> | undefined;
  try {
    const orders = [s.order];
    for (let i = 0; i < 5; i++) orders.push(await s.createOrder());
    assert.equal(new Set(orders).size, 6);
    const requests = orders.map((order) => ({
      input: { order_id: order, dealer_id: 'ATLAS', channel_id: randomUUID() },
      key: randomUUID(),
    }));
    assert.equal(new Set(requests.map((request) => request.key)).size, 6);
    for (const request of requests.slice(0, 3)) {
      const bound = await s.fix('BIND', request.input, request.key);
      assert.equal(bound.status, 201);
      assert.equal(bound.replayed, false);
      assert.equal(bound.body['order_id'], request.input.order_id);
    }

    const before = await durableFixSnapshot(s.id);
    const retained = requests
      .slice(0, 3)
      .map((request) => request.input.order_id)
      .sort();
    assert.deepEqual(before['fix_bindings']!.map((row) => row['order_id']).sort(), retained);
    assert.equal(before['fix_reservations']!.length, 3);
    assert.equal(before['fix_commands']!.length, 3);
    assert.equal(before['fix_events']!.length, 3);
    assert.equal(before['fix_lanes']!.length, 3);
    assert.equal(before['fix_channels']!.length, 3);
    for (const reservation of before['fix_reservations']!) {
      assert.equal(reservation['commands'], 25);
      assert.equal(reservation['events'], 43);
      assert.equal(reservation['released_at'], null);
    }
    assert.equal(
      before['fix_reservations']!.reduce((n, row) => n + Number(row['commands']), 0),
      75,
    );
    assert.equal(
      before['fix_reservations']!.reduce((n, row) => n + Number(row['events']), 0),
      129,
    );
    assert.equal(before['orders']!.length, 6);
    assert.equal(before['order_states']!.length, 6);
    for (const order of before['orders']!) {
      assert.equal((order['contract'] as Record<string, unknown>)['dealer_id'], 'ATLAS');
    }
    for (const state of before['order_states']!) {
      assert.equal(state['status'], 'PENDING_ACK');
      assert.equal(state['version'], 1);
      assert.equal(state['execution_count'], 0);
      assert.equal(state['pending_cancel_id'], null);
    }
    // Financial budgets permit the fourth binding; the retained-slot cap is decisive.
    assert.ok(Number(before['sandboxes']![0]!['command_count']) + 100 + 2 <= 512);
    assert.ok(Number(before['sandboxes']![0]!['event_count']) + 172 + 2 <= 1024);
    // Even a fifth binding would fit the financial budgets: the retained limit rejects it.
    assert.ok(Number(before['sandboxes']![0]!['command_count']) + 125 + 2 <= 512);
    assert.ok(Number(before['sandboxes']![0]!['event_count']) + 215 + 2 <= 1024);

    const contenders = requests.slice(3);
    for (let i = 0; i < contenders.length; i++) clients.push(await connection('app'));
    const pids = await Promise.all(
      clients.map(async (client) => {
        const row = (
          await client.query<{ pid: number; role: string }>(
            'SELECT pg_backend_pid() AS pid,current_user AS role',
          )
        ).rows[0]!;
        assert.equal(row.role, 'tf_app');
        return row.pid;
      }),
    );
    assert.equal(new Set(pids).size, 3);
    await holder.query('BEGIN');
    holding = true;
    assert.equal(
      (await holder.query('SELECT id FROM fi.sandboxes WHERE id=$1 FOR UPDATE', [s.id])).rowCount,
      1,
    );

    // Every request is submitted before waiting; only PostgreSQL serializes admission.
    pending = Promise.all(
      contenders.map((request, index) => s.fix('BIND', request.input, request.key, clients[index])),
    );
    void pending.catch(() => {});
    const deadline = performance.now() + 1000;
    let blocked = 0;
    while (performance.now() < deadline) {
      const rows = (
        await monitor.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
         WHERE pid=ANY($1::int[]) AND state='active' AND wait_event_type='Lock'
         AND cardinality(pg_blocking_pids(pid))>0
         AND query LIKE 'SELECT fi_control.fix_command(%'`,
          [pids],
        )
      ).rows;
      blocked = rows.length;
      if (blocked === 3) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(blocked, 3, 'All distinct-order BIND calls must reach the database lock barrier.');
    assert.ok(
      isDeepStrictEqual(await durableFixSnapshot(s.id), before),
      'Blocked contenders must expose no partial durable state.',
    );
    await holder.query('COMMIT');
    holding = false;
    const results = await pending;
    assert.equal(results.filter((result) => result.status === 201).length, 1);
    assert.equal(results.filter((result) => result.status === 429).length, 2);
    const winnerIndex = results.findIndex((result) => result.status === 201);
    const winner = contenders[winnerIndex]!;
    for (const result of results) {
      assert.equal(result.replayed, false);
      if (result.status === 429)
        assert.equal((result.body['error'] as { code: string }).code, 'FIX_RESERVATION_CAPACITY');
    }

    const after = await durableFixSnapshot(s.id);
    const accepted = [...requests.slice(0, 3), winner];
    const acceptedIds = accepted.map((request) => request.input.order_id).sort();
    for (const table of ['fix_bindings', 'fix_lanes', 'fix_reservations']) {
      assert.equal(after[table]!.length, 4);
      assert.deepEqual(after[table]!.map((row) => row['order_id']).sort(), acceptedIds);
    }
    assert.equal(after['fix_channels']!.length, 4);
    assert.deepEqual(
      after['fix_channels']!.map((row) => row['id']).sort(),
      accepted.map((request) => request.input.channel_id).sort(),
    );
    for (const request of accepted) {
      const binding = after['fix_bindings']!.find(
        (row) => row['order_id'] === request.input.order_id,
      )!;
      assert.equal(binding['cl_ord_id'], request.input.order_id);
      assert.equal(binding['channel_id'], request.input.channel_id);
      assert.equal(binding['dealer_id'], 'ATLAS');
    }
    for (const lane of after['fix_lanes']!) {
      assert.equal(lane['owner_id'], null);
      assert.equal(lane['actor_id'], null);
      assert.equal(lane['fence'], 0);
      assert.equal(lane['closed_at'], null);
      assert.equal(lane['lease_expires_at'], null);
    }
    for (const reservation of after['fix_reservations']!) {
      assert.equal(reservation['commands'], 25);
      assert.equal(reservation['events'], 43);
      assert.equal(reservation['released_at'], null);
    }
    const reservedCommands = after['fix_reservations']!.reduce(
      (n, row) => n + Number(row['commands']),
      0,
    );
    const reservedEvents = after['fix_reservations']!.reduce(
      (n, row) => n + Number(row['events']),
      0,
    );
    assert.equal(reservedCommands, 100);
    assert.equal(reservedEvents, 172);
    assert.ok(Number(after['sandboxes']![0]!['command_count']) + reservedCommands + 2 <= 512);
    assert.ok(Number(after['sandboxes']![0]!['event_count']) + reservedEvents + 2 <= 1024);
    assert.equal(after['fix_commands']!.length, 4);
    assert.equal(after['fix_events']!.length, 4);
    assert.deepEqual(after['fix_commands']!.map((row) => row['command_seq']).sort(), [1, 2, 3, 4]);
    assert.deepEqual(
      after['fix_commands']!.map((row) => row['idempotency_key']).sort(),
      accepted.map((request) => request.key).sort(),
    );
    for (const request of accepted) {
      const command = after['fix_commands']!.find((row) => row['idempotency_key'] === request.key)!;
      assert.equal(command['operation'], 'BIND');
      assert.equal(command['http_status'], 201);
      assert.equal(command['actor_id'], s.actor);
      const expectedBody = {
        order_id: request.input.order_id,
        cl_ord_id: request.input.order_id,
        dealer_order_id: null,
        reserved_commands: 25,
        reserved_events: 43,
        financial_applied: false,
      };
      assert.ok(isDeepStrictEqual(command['response_body'], expectedBody));
      const event = after['fix_events']!.find(
        (row) => row['command_seq'] === command['command_seq'],
      )!;
      assert.equal(event['event_index'], 0);
      assert.equal(event['event_type'], 'BIND');
      assert.equal(event['order_id'], request.input.order_id);
      assert.ok(
        isDeepStrictEqual(event['payload'], { financial_applied: false, record: expectedBody }),
      );
    }
    assert.ok(
      isDeepStrictEqual(
        after['command_keys']!.filter((row) => row['idempotency_key'] !== winner.key),
        before['command_keys'],
      ),
      'Only the admitted BIND may reserve a new key.',
    );
    assert.deepEqual(
      after['command_keys']!.filter((row) => row['idempotency_key'] === winner.key).map(
        (row) => row['domain'],
      ),
      ['FIX'],
    );
    for (const table of [
      'fix_messages',
      'fix_attempts',
      'fix_sequence_slots',
      'fix_outbox',
      'fix_dealer_correlations',
      'fix_cancel_correlations',
      'fix_work',
      'fix_prepared',
      'fix_outcomes',
    ]) {
      assert.equal(after[table]!.length, 0);
    }
    for (const table of [
      'sandboxes',
      'commands',
      'audit_events',
      'orders',
      'order_states',
      'executions',
      'positions',
      'cancellation_requests',
      'cancellation_outcomes',
      'order_history',
    ])
      assert.ok(
        isDeepStrictEqual(after[table], before[table]),
        `BIND contention changed ${table}.`,
      );

    for (const [index, request] of contenders.entries()) {
      const replay = await s.fix('BIND', request.input, request.key, clients[index]);
      assert.equal(replay.status, index === winnerIndex ? 201 : 429);
      assert.equal(replay.replayed, index === winnerIndex);
      if (index === winnerIndex) {
        assert.ok(isDeepStrictEqual(replay.body, results[index]!.body));
      } else {
        assert.equal((replay.body['error'] as { code: string }).code, 'FIX_RESERVATION_CAPACITY');
        const receipt = (
          await clients[index]!.query<{
            result: { status: number; body: { error: { code: string } } };
          }>('SELECT fi_control.read_fix($1,$2,$3,$4,$5,$6) AS result', [
            s.id,
            s.proof,
            'trade',
            '1',
            'RECEIPT',
            request.key,
          ])
        ).rows[0]!.result;
        assert.equal(receipt.status, 404);
        assert.equal(receipt.body.error.code, 'FIX_OUTCOME_UNRESOLVED');
      }
    }
    assert.ok(
      isDeepStrictEqual(await durableFixSnapshot(s.id), after),
      'Original-key replays and capacity rejections must not change accounting or evidence.',
    );
    console.log(
      'Distinct-order BIND persisted evidence:',
      JSON.stringify({
        distinctOrders: orders.length,
        blockedCompetitors: blocked,
        retainedBefore: before['fix_bindings']!.length,
        retainedAfter: after['fix_bindings']!.length,
        admitted: results.filter((result) => result.status === 201).length,
        rejected: results.filter((result) => result.status === 429).length,
        reservedCommands,
        reservedEvents,
        protocolReceipts: after['fix_commands']!.length,
        protocolEvents: after['fix_events']!.length,
        executions: after['executions']!.length,
        outboundIntents: after['fix_outbox']!.length,
      }),
    );
  } finally {
    if (holding) await holder.query('ROLLBACK');
    await pending?.catch(() => {});
    await Promise.all(clients.map((client) => client.end()));
    await holder.end();
    await monitor.end();
    await s.close();
  }
});

void test('protected event totals admit 1023 and 1024 but reject 1025 independently of command and binding limits', async () => {
  const s = await fixture(),
    cfg = await owner(),
    observer = await connection('admin');
  const database = new WorkflowDatabase(cfg.appUrl!);
  const rfq = new RfqService(database);
  const binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' };
  const financialRows = [
    'orders',
    'order_states',
    'executions',
    'positions',
    'order_history',
    'cancellation_requests',
    'cancellation_outcomes',
  ] as const;
  async function snapshot() {
    const data = await durableFixSnapshot(s.id);
    for (const table of ['rfqs', 'quotes', 'invitations']) {
      data[table] = (
        await observer.query<{ record: Record<string, unknown> }>(
          `SELECT to_jsonb(t) AS record FROM fi.${table} t WHERE sandbox_id=$1 ORDER BY to_jsonb(t)::text`,
          [s.id],
        )
      ).rows.map((row) => row.record);
    }
    assert.equal(Number(data['sandboxes']![0]!['command_count']), data['commands']!.length);
    assert.equal(Number(data['sandboxes']![0]!['commit_seq']), data['commands']!.length);
    assert.equal(Number(data['sandboxes']![0]!['event_count']), data['audit_events']!.length);
    return data;
  }
  function budgets(data: Awaited<ReturnType<typeof snapshot>>) {
    const active = data['fix_reservations']!.filter((row) => row['released_at'] === null);
    return {
      commands: Number(data['sandboxes']![0]!['command_count']),
      events: Number(data['sandboxes']![0]!['event_count']),
      reservedCommands: active.reduce((sum, row) => sum + Number(row['commands']), 0),
      reservedEvents: active.reduce((sum, row) => sum + Number(row['events']), 0),
      retained: data['fix_bindings']!.length,
    };
  }
  async function create(input: ReturnType<typeof rfqInput>, key: string) {
    return rfq.command(binding, 'CREATE_RFQ', input, key, s.actor, () => {});
  }
  try {
    // Supported Phase 2C manual activity: 30 full orders and one seven-fill order.
    // The fixture's original order stays pristine for FIX binding.
    for (let index = 0; index < 31; index++) {
      const order = await s.createOrder();
      assert.equal(
        (await s.command('ACK_ORDER', { order_id: order, expected_version: '1' })).status,
        200,
      );
      const fills = index === 30 ? 7 : 8;
      for (let fill = 0; fill < fills; fill++) {
        const executed = await s.command('EXECUTE_ORDER', {
          order_id: order,
          expected_version: String(fill + 2),
          par_amount: '12.50',
          execution_id: randomUUID(),
          source_event_id: randomUUID(),
        });
        assert.equal(executed.status, 201);
        assert.equal(executed.body.lifecycle.execution_count, fill + 1);
        assert.equal(executed.body.lifecycle.status, fill === 7 ? 'FILLED' : 'PARTIALLY_FILLED');
      }
    }
    const targets = [s.order, await s.createOrder(), await s.createOrder()];
    assert.equal(new Set(targets).size, 3);
    assert.equal((await create(rfqInput(), randomUUID())).status, 201);
    const initial = await snapshot();
    assert.deepEqual(budgets(initial), {
      commands: 382,
      events: 978,
      reservedCommands: 0,
      reservedEvents: 0,
      retained: 0,
    });
    assert.equal(initial['rfqs']!.length, 35);
    assert.equal(initial['orders']!.length, 34);
    assert.equal(initial['executions']!.length, 247);
    assert.equal(initial['order_states']!.filter((row) => row['status'] === 'FILLED').length, 30);
    assert.equal(
      initial['order_states']!.filter((row) => row['status'] === 'PARTIALLY_FILLED').length,
      1,
    );
    for (const target of targets) {
      const state = initial['order_states']!.find((row) => row['order_id'] === target)!;
      assert.equal(state['status'], 'PENDING_ACK');
      assert.equal(state['version'], 1);
      assert.equal(state['execution_count'], 0);
      assert.equal(state['pending_cancel_id'], null);
    }
    assert.equal(initial['positions']!.length, 1);
    assert.equal(Number(initial['positions']![0]!['signed_par']), 3087.5);
    assert.equal(initial['positions']![0]!['execution_count'], 247);
    assert.equal(
      BigInt(String(initial['positions']![0]!['signed_cash_cents'])),
      -initial['executions']!.reduce(
        (sum, row) => sum + BigInt(String(row['consideration_cents'])),
        0n,
      ),
    );

    const requests = targets.map((order_id) => ({
      input: { order_id, dealer_id: 'ATLAS', channel_id: randomUUID() },
      key: randomUUID(),
    }));
    assert.ok(382 + 25 + 2 < 512);
    assert.equal(978 + 43 + 2, 1023);
    const below = await s.fix('BIND', requests[0]!.input, requests[0]!.key);
    assert.equal(below.status, 201);
    assert.equal(below.replayed, false);
    assert.equal(below.body['financial_applied'], false);
    const afterBelow = await snapshot();
    assert.deepEqual(budgets(afterBelow), {
      commands: 382,
      events: 978,
      reservedCommands: 25,
      reservedEvents: 43,
      retained: 1,
    });

    // A real one-event writer fills the last protected slot without hitting C or RFQ limits.
    const atInput = rfqInput(),
      atKey = randomUUID();
    const at = await create(atInput, atKey);
    assert.equal(at.status, 201);
    assert.equal(at.replayed, false);
    const limit = await snapshot();
    assert.deepEqual(budgets(limit), {
      commands: 383,
      events: 979,
      reservedCommands: 25,
      reservedEvents: 43,
      retained: 1,
    });
    assert.equal(limit['rfqs']!.length, 36);
    assert.equal(979 + 43 + 2, 1024);
    const atReplay = await create(atInput, atKey);
    assert.equal(atReplay.status, 201);
    assert.equal(atReplay.replayed, true);
    assert.ok(isDeepStrictEqual(atReplay.body, at.body));
    assert.ok(
      isDeepStrictEqual(await snapshot(), limit),
      'Replay at the event boundary changed state.',
    );

    const overInput = rfqInput(),
      overKey = randomUUID();
    assert.ok(384 + 25 + 2 < 512);
    assert.equal(980 + 43 + 2, 1025);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(
        create(overInput, overKey),
        (error: unknown) =>
          error instanceof DomainError &&
          error.status === 429 &&
          error.code === 'PROTECTED_FINANCIAL_CAPACITY',
      );
      assert.ok(
        isDeepStrictEqual(await snapshot(), limit),
        'Rejected one-event writer left partial financial/RFQ/protocol state.',
      );
    }
    assert.equal(limit['commands']!.filter((row) => row['idempotency_key'] === overKey).length, 0);
    assert.equal(
      limit['command_keys']!.filter((row) => row['idempotency_key'] === overKey).length,
      0,
    );

    // Legitimate pristine release restores active reservations without erasing retained bindings.
    assert.equal((await s.fix('RELEASE', { order_id: targets[0] })).status, 200);
    const releasedA = await snapshot();
    assert.deepEqual(budgets(releasedA), {
      commands: 383,
      events: 979,
      reservedCommands: 0,
      reservedEvents: 0,
      retained: 1,
    });
    const equality = await s.fix('BIND', requests[1]!.input, requests[1]!.key);
    assert.equal(equality.status, 201);
    assert.equal(equality.replayed, false);
    const exact = await snapshot();
    assert.deepEqual(budgets(exact), {
      commands: 383,
      events: 979,
      reservedCommands: 25,
      reservedEvents: 43,
      retained: 2,
    });
    assert.equal(979 + 43 + 2, 1024);
    const equalityReplay = await s.fix('BIND', requests[1]!.input, requests[1]!.key);
    assert.equal(equalityReplay.status, 201);
    assert.equal(equalityReplay.replayed, true);
    assert.ok(isDeepStrictEqual(equalityReplay.body, equality.body));
    assert.ok(isDeepStrictEqual(await snapshot(), exact));

    assert.equal((await s.fix('RELEASE', { order_id: targets[1] })).status, 200);
    const retry = await create(overInput, overKey);
    assert.equal(retry.status, 201);
    assert.equal(retry.replayed, false);
    const over = await snapshot();
    assert.deepEqual(budgets(over), {
      commands: 384,
      events: 980,
      reservedCommands: 0,
      reservedEvents: 0,
      retained: 2,
    });
    assert.equal(over['rfqs']!.length, 37);
    assert.equal(over['rfqs']!.filter((row) => row['id'] === overInput.rfq_id).length, 1);
    assert.equal(over['commands']!.filter((row) => row['idempotency_key'] === overKey).length, 1);
    assert.ok(384 + 25 + 2 < 512);
    assert.ok(over['fix_bindings']!.length < 4);
    assert.equal(980 + 43 + 2, 1025);
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = await s.fix('BIND', requests[2]!.input, requests[2]!.key);
      assert.equal(rejected.status, 429);
      assert.equal(rejected.replayed, false);
      assert.equal((rejected.body['error'] as { code: string }).code, 'FIX_RESERVATION_CAPACITY');
      assert.ok(
        isDeepStrictEqual(await snapshot(), over),
        'Event-only BIND rejection left a partial binding/reservation/receipt/record.',
      );
    }
    assert.equal(over['fix_channels']!.length, 2);
    for (const table of ['fix_bindings', 'fix_reservations', 'fix_lanes']) {
      assert.deepEqual(
        over[table]!.map((row) => row['order_id']).sort(),
        targets.slice(0, 2).sort(),
      );
    }
    assert.equal(over['fix_commands']!.length, 4);
    assert.equal(over['fix_events']!.length, 4);
    assert.equal(
      over['fix_commands']!.filter((row) => row['idempotency_key'] === requests[2]!.key).length,
      0,
    );
    assert.equal(
      over['command_keys']!.filter((row) => row['idempotency_key'] === requests[2]!.key).length,
      0,
    );
    for (const table of [
      'fix_messages',
      'fix_attempts',
      'fix_sequence_slots',
      'fix_outbox',
      'fix_dealer_correlations',
      'fix_cancel_correlations',
      'fix_work',
      'fix_prepared',
      'fix_outcomes',
    ])
      assert.equal(over[table]!.length, 0);
    for (const table of financialRows)
      assert.ok(
        isDeepStrictEqual(over[table], initial[table]),
        `Capacity checks changed ${table}.`,
      );
    assert.ok(
      isDeepStrictEqual(
        over['commands']!.filter((row) => Number(row['command_seq']) <= 382),
        initial['commands'],
      ),
      'Existing financial receipts changed.',
    );
    assert.ok(
      isDeepStrictEqual(
        over['audit_events']!.filter((row) => Number(row['command_seq']) <= 382),
        initial['audit_events'],
      ),
      'Existing financial audit events changed.',
    );
    const original = await s.fix('BIND', requests[0]!.input, requests[0]!.key);
    assert.equal(original.status, 201);
    assert.equal(original.replayed, true);
    assert.ok(isDeepStrictEqual(original.body, below.body));
    const financialReplay = await create(overInput, overKey);
    assert.equal(financialReplay.status, 201);
    assert.equal(financialReplay.replayed, true);
    assert.ok(isDeepStrictEqual(financialReplay.body, retry.body));
    assert.ok(
      isDeepStrictEqual(await snapshot(), over),
      'Closed-binding/original-key replay changed capacity.',
    );
    console.log(
      'Independent event-capacity persisted evidence:',
      JSON.stringify({
        initialCommands: 382,
        initialEvents: 978,
        belowProtectedEvents: 1023,
        equalityCommands: 383,
        equalityEvents: 979,
        activeReservedCommands: 25,
        activeReservedEvents: 43,
        equalityProtectedEvents: 1024,
        rejectedWriterProjectedCommands: 411,
        rejectedWriterProjectedEvents: 1025,
        finalCommands: budgets(over).commands,
        finalEvents: budgets(over).events,
        retainedBindings: budgets(over).retained,
        finalActiveReservations: budgets(over).reservedEvents,
        rejectedBindProjectedCommands: 411,
        rejectedBindProjectedEvents: 1025,
        rfqs: over['rfqs']!.length,
        orders: over['orders']!.length,
        manualExecutions: over['executions']!.length,
        fixMessages: over['fix_messages']!.length,
        protocolReceipts: over['fix_commands']!.length,
        protocolEvents: over['fix_events']!.length,
      }),
    );
  } finally {
    await database.close();
    await observer.end();
    await s.close();
  }
});
