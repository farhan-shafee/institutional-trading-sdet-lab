import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type pg from 'pg';
import { applicationFixture } from './fix-application-fixture.js';
import { fixture } from './fix-fixture.js';
import { connection, owner } from './harness.js';
import { digest } from './rfq-fixture.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { FixFoundationService } from '../../app/server/fix/foundation.js';
import { DomainError } from '../../app/domain/errors.js';

type Sandbox = Awaited<ReturnType<typeof fixture>>;
export async function ledger(s: Sandbox, db: pg.Client) {
  const row = (
    await db.query<{
      c: number;
      e: number;
      receipts: number;
      audits: number;
      consumed_c: number;
      consumed_e: number;
    }>(
      `SELECT command_count c,event_count e,
      (SELECT count(*)::int FROM fi.commands WHERE sandbox_id=$1) receipts,
      (SELECT count(*)::int FROM fi.audit_events WHERE sandbox_id=$1) audits,
      (SELECT count(*)::int FROM fi.fix_consumptions WHERE sandbox_id=$1) consumed_c,
      (SELECT COALESCE(sum(events),0)::int FROM fi.fix_consumptions WHERE sandbox_id=$1) consumed_e
    FROM fi.sandboxes WHERE id=$1`,
      [s.id],
    )
  ).rows[0]!;
  assert.equal(row.c, row.receipts, 'command counter must be backed by committed receipts');
  assert.equal(row.e, row.audits, 'event counter must be backed by actual audits');
  return row;
}
export async function padCommands(s: Sandbox, other: string, target: number, db: pg.Client) {
  for (let current = (await ledger(s, db)).c; current < target; current++)
    assert.equal(
      (await s.command('ACK_ORDER', { order_id: other, expected_version: '999' })).status,
      409,
    );
  assert.equal((await ledger(s, db)).c, target);
}
async function completeLifecycle(s: Awaited<ReturnType<typeof applicationFixture>>) {
  assert.equal((await s.apply((await s.prepare()).work)).status, 200);
  const px = (
    await s.app.query<{ contract: Record<string, string> }>(
      'SELECT contract FROM fi.orders WHERE sandbox_id=$1 AND id=$2',
      [s.id, s.order],
    )
  ).rows[0]!.contract['clean_price']!;
  for (let i = 1; i <= 8; i++) {
    const cancel = randomUUID(),
      base = { '11': cancel, '41': s.order };
    assert.equal(
      (
        await s.apply(
          (await s.prepare({ '35': 'F', '49': 'TRADEFLOW', '56': 'ATLAS', ...base })).work,
        )
      ).status,
      200,
    );
    const fmt = (n: number) => (n / 100).toFixed(2);
    assert.equal(
      (
        await s.apply(
          (
            await s.prepare({
              '150': 'F',
              '39': i === 8 ? '2' : '1',
              '14': fmt(i * 1250),
              '151': fmt(10000 - i * 1250),
              '32': '12.50',
              '31': px,
              '6': px,
            })
          ).work,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await s.apply(
          (
            await s.prepare({
              '35': '9',
              ...base,
              '39': i === 8 ? '2' : '1',
              '434': '1',
              '102': i === 8 ? '0' : '99',
            })
          ).work,
        )
      ).status,
      200,
    );
  }
}

for (const consumed of [0, 1, 25])
  for (const excess of [0, 1])
    void test(`BIND net command boundary: ${consumed} actual consumed effects, ${excess} above512`, async () => {
      const s = await applicationFixture(),
        admin = await connection('admin');
      try {
        const next = await s.createOrder(),
          other = await s.createOrder();
        await padCommands(s, other, 460 + excess, admin);
        if (consumed === 1) assert.equal((await s.apply((await s.prepare()).work)).status, 200);
        if (consumed === 25) await completeLifecycle(s);
        const before = await ledger(s, admin);
        assert.equal(before.c, 460 + excess + consumed);
        assert.equal(before.consumed_c, consumed);
        assert.equal(before.consumed_e, consumed === 25 ? 41 : consumed);
        assert.equal(before.c + (25 - consumed) + 25 + 2, 512 + excess);
        const key = randomUUID(),
          p = { order_id: next, dealer_id: 'ATLAS', channel_id: randomUUID() };
        const result = await s.fix('BIND', p, key);
        assert.equal(
          result.status,
          excess ? 429 : 201,
          JSON.stringify({ before, result, net: 512 + excess }),
        );
        assert.deepEqual(
          await ledger(s, admin),
          before,
          'BIND is metadata and must not spend financial capacity',
        );
        if (!excess) {
          const replay = await s.fix('BIND', p, key);
          assert.equal(replay.replayed, true);
          assert.deepEqual(replay.body, result.body);
        }
        assert.equal(
          (await s.fix('RELEASE', { order_id: s.order })).status,
          409,
          'retained FIX messages/applications cannot release capacity',
        );
      } finally {
        await admin.end();
        await s.close();
      }
    });

async function padEvents(s: Sandbox, other: string, target: number, db: pg.Client) {
  while ((await ledger(s, db)).e + 31 <= target) {
    const id = await s.createOrder('8.00');
    assert.equal(
      (await s.command('ACK_ORDER', { order_id: id, expected_version: '1' })).status,
      200,
    );
    for (let i = 0; i < 8; i++)
      assert.equal(
        (
          await s.command('EXECUTE_ORDER', {
            order_id: id,
            expected_version: String(2 + i),
            execution_id: randomUUID(),
            source_event_id: randomUUID(),
            par_amount: '1.00',
          })
        ).status,
        201,
      );
  }
  for (let current = (await ledger(s, db)).e; current < target; current++)
    assert.equal(
      (await s.command('ACK_ORDER', { order_id: other, expected_version: '999' })).status,
      409,
    );
  assert.equal((await ledger(s, db)).e, target);
}
for (const excess of [0, 1])
  void test(`BIND net audit boundary uses actual three-event fill; ${excess} above1024`, async () => {
    const s = await applicationFixture(),
      admin = await connection('admin');
    try {
      const next = await s.createOrder(),
        other = await s.createOrder();
      assert.equal((await s.apply((await s.prepare()).work)).status, 200);
      await padEvents(s, other, 937 + excess, admin);
      const px = (
        await s.app.query<{ contract: Record<string, string> }>(
          'SELECT contract FROM fi.orders WHERE sandbox_id=$1 AND id=$2',
          [s.id, s.order],
        )
      ).rows[0]!.contract['clean_price']!;
      assert.equal(
        (
          await s.apply(
            (
              await s.prepare({
                '150': 'F',
                '39': '2',
                '14': '100.00',
                '151': '0.00',
                '32': '100.00',
                '31': px,
                '6': px,
              })
            ).work,
          )
        ).status,
        200,
      );
      const before = await ledger(s, admin);
      assert.equal(before.e, 940 + excess);
      assert.equal(before.consumed_c, 2);
      assert.equal(before.consumed_e, 4);
      assert.equal(before.e + (43 - 4) + 43 + 2, 1024 + excess);
      assert.ok(
        before.c + (25 - 2) + 25 + 2 < 512,
        'command quota must not explain an event rejection',
      );
      const result = await s.fix('BIND', {
        order_id: next,
        dealer_id: 'ATLAS',
        channel_id: randomUUID(),
      });
      assert.equal(result.status, excess ? 429 : 201, JSON.stringify({ before, result }));
      assert.deepEqual(await ledger(s, admin), before);
    } finally {
      await admin.end();
      await s.close();
    }
  });

void test('twenty net-boundary BIND contenders admit exactly one new reservation after committed consumption', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin');
  const clients = await Promise.all(Array.from({ length: 20 }, () => connection('app')));
  try {
    const orders: string[] = [];
    for (let i = 0; i < 20; i++) orders.push(await s.createOrder());
    await padCommands(s, orders[0]!, 460, admin);
    assert.equal((await s.apply((await s.prepare()).work)).status, 200);
    const results = await Promise.all(
      clients.map((db, i) =>
        s.fix(
          'BIND',
          { order_id: orders[i], dealer_id: 'ATLAS', channel_id: randomUUID() },
          randomUUID(),
          db,
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 429).length, 19);
    const state = await ledger(s, admin);
    assert.equal(state.c, 461);
    assert.equal(state.consumed_c, 1);
    assert.equal(
      (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_bindings WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      2,
    );
    assert.equal(state.c + 50 - state.consumed_c + 2, 512);
  } finally {
    await Promise.all(clients.map((db) => db.end()));
    await admin.end();
    await s.close();
  }
});

void test('twenty pristine admission contenders preserve the lifetime four-binding limit', async () => {
  const s = await fixture(),
    clients = await Promise.all(Array.from({ length: 20 }, () => connection('app')));
  try {
    const orders = [s.order];
    for (let i = 1; i < 20; i++) orders.push(await s.createOrder());
    const results = await Promise.all(
      clients.map((db, i) =>
        s.fix(
          'BIND',
          { order_id: orders[i], dealer_id: 'ATLAS', channel_id: randomUUID() },
          randomUUID(),
          db,
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 4);
    assert.equal(results.filter((r) => r.status === 429).length, 16);
  } finally {
    await Promise.all(clients.map((db) => db.end()));
    await s.close();
  }
});

void test('rotation headroom is finite through rejected receipts, replay, earliest release and release of every active binding', async () => {
  const s = await fixture(),
    admin = await connection('admin');
  let proof = s.proof,
    generation = 1;
  type Result = { status: number; replayed: boolean; body: Record<string, unknown> };
  const fix = async (action: string, p: Record<string, unknown>, key = randomUUID()) =>
    (
      await s.app.query<{ r: Result }>('SELECT fi_control.fix_command($1,$2,$3,$4,$5,$6,$7) r', [
        s.id,
        proof,
        generation,
        action,
        JSON.stringify(p),
        key,
        s.actor,
      ])
    ).rows[0]!.r;
  const rotate = async (expected = generation) => {
    const trade = digest(randomUUID()),
      args = [
        s.id,
        proof,
        generation,
        expected,
        digest(randomUUID()),
        trade,
        digest(randomUUID()),
        randomUUID(),
        s.actor,
      ];
    const r = (
      await s.app.query<{ r: Result }>(
        'SELECT fi_control.rotate_capabilities($1,$2,$3,$4,$5,$6,$7,$8,$9) r',
        args,
      )
    ).rows[0]!.r;
    if (r.status === 200) {
      proof = trade;
      generation++;
    }
    return { r, args };
  };
  const bind = (order_id: string) =>
    fix('BIND', { order_id, dealer_id: 'ATLAS', channel_id: randomUUID() });
  try {
    const b = await s.createOrder(),
      c = await s.createOrder(),
      d = await s.createOrder(),
      fifth = await s.createOrder();
    assert.equal(
      (await rotate()).r.status,
      200,
      'pre-first-binding rotation remains ordinary spending',
    );
    assert.equal((await bind(s.order)).status, 201);
    const rejected = await rotate(999);
    assert.equal(rejected.r.status, 409);
    const beforeReplay = await ledger(s, admin);
    assert.equal(
      (
        await s.app.query<{ r: Result }>(
          'SELECT fi_control.rotate_capabilities($1,$2,$3,$4,$5,$6,$7,$8,$9) r',
          rejected.args,
        )
      ).rows[0]!.r.replayed,
      true,
    );
    assert.deepEqual(await ledger(s, admin), beforeReplay);
    assert.equal((await bind(b)).status, 201);
    assert.equal((await rotate()).r.status, 200);
    assert.equal((await fix('RELEASE', { order_id: s.order })).status, 200);
    const pad = async (target: number) => {
      for (let n = (await ledger(s, admin)).c; n < target; n++)
        assert.equal(
          (
            await s.app.query<{ r: Result }>(
              'SELECT fi_control.order_command($1,$2,$3,$4,$5,$6,$7,$8) r',
              [
                s.id,
                proof,
                generation,
                'ACK_ORDER',
                JSON.stringify({ order_id: d, expected_version: '999' }),
                digest(randomUUID()),
                randomUUID(),
                s.actor,
              ],
            )
          ).rows[0]!.r.status,
          409,
        );
    };
    await pad(462);
    assert.equal(
      (await bind(c)).status,
      201,
      'spent headroom must not reappear when the earliest binding is released',
    );
    assert.equal((await fix('RELEASE', { order_id: b })).status, 200);
    assert.equal((await fix('RELEASE', { order_id: c })).status, 200);
    await pad(487);
    assert.equal(
      (await bind(d)).status,
      201,
      'releasing every active reservation must not recreate spent rotation allowance',
    );
    assert.equal((await fix('RELEASE', { order_id: d })).status, 200);
    assert.equal(
      (await bind(fifth)).status,
      429,
      'released bindings still count toward four lifetime bindings',
    );
    assert.equal((await ledger(s, admin)).c, 487);
  } finally {
    await admin.end();
    await s.close();
  }
});

async function waitForLock(admin: pg.Client, pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (
      (
        await admin.query<{ blocked: boolean }>(
          "SELECT wait_event_type='Lock' blocked FROM pg_stat_activity WHERE pid=$1",
          [pid],
        )
      ).rows[0]?.blocked
    )
      return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Expected PostgreSQL lock barrier was not reached');
}
for (const first of ['BIND', 'MANUAL'] as const)
  void test(`net-boundary ${first} commits first against competing manual/FIX writer`, async () => {
    const s = await applicationFixture(),
      admin = await connection('admin'),
      a = await connection('app'),
      b = await connection('app');
    let waiting: Promise<unknown> | undefined;
    try {
      const next = await s.createOrder(),
        other = await s.createOrder();
      await padCommands(s, other, 460, admin);
      assert.equal((await s.apply((await s.prepare()).work)).status, 200);
      const bind = (db: pg.Client) =>
        s.fix(
          'BIND',
          { order_id: next, dealer_id: 'ATLAS', channel_id: randomUUID() },
          randomUUID(),
          db,
        );
      const manual = (db: pg.Client) =>
        s.command('ACK_ORDER', { order_id: other, expected_version: '999' }, randomUUID(), db);
      await a.query('BEGIN');
      assert.equal(
        (await (first === 'BIND' ? bind(a) : manual(a))).status,
        first === 'BIND' ? 201 : 409,
      );
      const pid = (await b.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
      waiting = first === 'BIND' ? manual(b) : bind(b);
      await waitForLock(admin, pid);
      await a.query('COMMIT');
      assert.equal(((await waiting) as { status: number }).status, 429);
      assert.equal((await ledger(s, admin)).c, first === 'BIND' ? 461 : 462);
    } finally {
      await a.query('ROLLBACK');
      await waiting?.catch(() => {});
      await a.end();
      await b.end();
      await admin.end();
      await s.close();
    }
  });

void test('rolled-back application and admission retain original reservation and prepared intent', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin');
  try {
    const next = await s.createOrder(),
      p = await s.prepare(),
      before = await ledger(s, admin);
    await s.app.query('BEGIN');
    assert.equal((await s.apply(p.work)).status, 200);
    await s.app.query('ROLLBACK');
    assert.deepEqual(await ledger(s, admin), before);
    assert.equal((await s.fix('RELEASE', { order_id: s.order })).status, 409);
    const input = { order_id: next, dealer_id: 'ATLAS', channel_id: randomUUID() },
      key = randomUUID();
    await s.app.query('BEGIN');
    assert.equal((await s.fix('BIND', input, key)).status, 201);
    await s.app.query('ROLLBACK');
    const recovered = await s.fix('BIND', input, key);
    assert.equal(recovered.status, 201);
    assert.equal(recovered.replayed, false);
    assert.equal((await s.fix('BIND', { ...input, channel_id: randomUUID() }, key)).status, 409);
    assert.equal(
      (await s.apply(p.work)).status,
      200,
      'original prepared key remains usable after rollback',
    );
  } finally {
    await s.app.query('ROLLBACK');
    await admin.end();
    await s.close();
  }
});

for (const after of [false, true])
  void test(`net-capacity admission with lost connection ${after ? 'after' : 'around'} COMMIT recovers only its original key`, async () => {
    const s = await applicationFixture(),
      admin = await connection('admin'),
      cfg = await owner();
    let pid = 0;
    let hookReached = false;
    const db = new WorkflowDatabase(
      cfg.appUrl!,
      after
        ? {
            afterCommit: async () => {
              hookReached = true;
              await admin.query('SELECT pg_terminate_backend($1)', [pid]);
              throw new Error('Lost commit response');
            },
          }
        : {
            beforeCommit: async () => {
              hookReached = true;
              await admin.query('SELECT pg_terminate_backend($1)', [pid]);
            },
          },
    );
    try {
      const next = await s.createOrder(),
        other = await s.createOrder();
      await padCommands(s, other, 460, admin);
      assert.equal((await s.apply((await s.prepare()).work)).status, 200);
      const client = await db.pool.connect();
      pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
      client.release();
      const p = { order_id: next, dealer_id: 'ATLAS', channel_id: randomUUID() },
        key = randomUUID();
      await assert.rejects(
        new FixFoundationService(db, true).command(
          { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
          s.actor,
          'BIND',
          p,
          key,
          () => {},
        ),
        (e: unknown) =>
          e instanceof DomainError &&
          e.status === 503 &&
          (after
            ? e.code === 'OUTCOME_UNKNOWN'
            : ['DATABASE_UNAVAILABLE', 'OUTCOME_UNKNOWN'].includes(e.code)),
      );
      assert.equal(hookReached, true, 'schema/setup errors must not masquerade as COMMIT loss');
      await db.close();
      const recovered = await s.fix('BIND', p, key);
      assert.equal(recovered.status, 201);
      assert.equal(recovered.replayed, after);
      assert.equal(
        (
          await admin.query<{ n: number }>(
            'SELECT count(*)::int n FROM fi.fix_bindings WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0]!.n,
        2,
      );
    } finally {
      await db.close();
      await admin.end();
      await s.close();
    }
  });
