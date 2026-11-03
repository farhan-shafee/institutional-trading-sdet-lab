import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type pg from 'pg';
import { assertCleanCapacity, capacityEvidence } from './fix-capacity-oracle.js';
import { applicationFixture } from './fix-application-fixture.js';
import { fixture } from './fix-fixture.js';
import { connection, owner } from './harness.js';
import { digest } from './rfq-fixture.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { FixFoundationService } from '../../app/server/fix/foundation.js';
import { DomainError } from '../../app/domain/errors.js';

type Sandbox = Awaited<ReturnType<typeof fixture>>;
const binding = (s: Sandbox, proof = s.proof, generation = '1') => ({
  sandboxId: s.id,
  digest: proof,
  generation,
  scope: 'trade' as const,
});
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
// Financial padding is unrelated to ownership. Renew through the supported
// command immediately before using the lane, while proving its metadata-only cost.
async function claimAfterPadding(s: Awaited<ReturnType<typeof applicationFixture>>, db: pg.Client) {
  const before = await capacityEvidence(db, s.id),
    oldFence = BigInt(s.fence),
    mutable = new Set([
      'fi.fix_lanes',
      'fi.fix_commands',
      'fi.fix_events',
      'fi_control.command_keys',
    ]);
  // Even a full 25-application lifecycle plus the next BIND fits below the
  // ordinary protocol-command ceiling after this one additional CLAIM.
  assert.ok(before.state['fi.fix_commands']!.length + 1 + 25 * 4 + 1 <= 960);
  await s.claim();
  const after = await capacityEvidence(db, s.id);
  for (const field of ['C', 'E', 'R', 'S', 'N', 'H', 'bindings', 'active'] as const)
    assert.equal(after[field], before[field], 'CLAIM must not spend financial capacity: ' + field);
  for (const table of Object.keys(before.state))
    if (!mutable.has(table))
      assert.deepEqual(after.state[table], before.state[table], 'CLAIM changed retained ' + table);
  const oldReceipts = before.state['fi.fix_commands']!,
    receipts = after.state['fi.fix_commands']!,
    added = receipts.filter((r) => !oldReceipts.some((old) => old['id'] === r['id']));
  assert.equal(receipts.length, oldReceipts.length + 1);
  assert.equal(added.length, 1);
  assert.deepEqual(
    receipts.filter((r) => !added.includes(r)),
    oldReceipts,
  );
  const receipt = added[0]!,
    body = receipt['response_body'] as Record<string, unknown>;
  assert.equal(receipt['operation'], 'CLAIM');
  assert.equal(receipt['http_status'], 200);
  assert.equal(receipt['actor_id'], s.actor);
  assert.equal(Number(receipt['command_seq']), oldReceipts.length + 1);
  assert.equal(body['order_id'], s.order);
  assert.equal(body['owner_id'], s.owner);
  assert.equal(body['fence'], String(oldFence + 1n));
  assert.equal(s.fence, body['fence']);
  const events = after.state['fi.fix_events']!,
    event = events.filter((e) => e['command_seq'] === receipt['command_seq']);
  assert.equal(events.length, before.state['fi.fix_events']!.length + 1);
  assert.equal(event.length, 1);
  assert.deepEqual(
    events.filter((e) => !event.includes(e)),
    before.state['fi.fix_events'],
  );
  assert.equal(event[0]!['event_type'], 'CLAIM');
  assert.equal(event[0]!['order_id'], s.order);
  assert.deepEqual(event[0]!['payload'], { financial_applied: false, record: body });
  const keys = after.state['fi_control.command_keys']!,
    key = keys.filter((k) => k['idempotency_key'] === receipt['idempotency_key']);
  assert.equal(keys.length, before.state['fi_control.command_keys']!.length + 1);
  assert.equal(key.length, 1);
  assert.equal(key[0]!['domain'], 'FIX');
  assert.deepEqual(
    keys.filter((k) => !key.includes(k)),
    before.state['fi_control.command_keys'],
  );
  const oldLanes = before.state['fi.fix_lanes']!,
    lanes = after.state['fi.fix_lanes']!,
    oldLane = oldLanes.find((l) => l['order_id'] === s.order)!,
    lane = lanes.find((l) => l['order_id'] === s.order)!;
  assert.equal(lanes.length, oldLanes.length);
  assert.deepEqual(
    lanes.filter((l) => l !== lane),
    oldLanes.filter((l) => l !== oldLane),
  );
  const stableLane = (row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(row).filter(
        ([key]) => !['fence', 'lease_expires_at', '_exact_row'].includes(key),
      ),
    );
  assert.deepEqual(stableLane(lane), stableLane(oldLane));
  assert.equal(lane['owner_id'], s.owner);
  assert.equal(lane['actor_id'], s.actor);
  assert.equal(String(lane['capability_generation']), '1');
  assert.equal(String(lane['fence']), s.fence);
  assert.equal(lane['lease_expires_at'], body['lease_expires_at']);
  const live = (
    await db.query<{ live: boolean; remaining_ms: string }>(
      'SELECT lease_expires_at>clock_timestamp() live,(extract(epoch from(lease_expires_at-clock_timestamp()))*1000)::text remaining_ms FROM fi.fix_lanes WHERE sandbox_id=$1 AND order_id=$2',
      [s.id, s.order],
    )
  ).rows[0]!;
  assert.equal(live.live, true);
  console.log(
    'Post-padding authenticated CLAIM:',
    JSON.stringify({
      order: s.order,
      fence: s.fence,
      C: after.C,
      E: after.E,
      R: after.R,
      S: after.S,
      N: after.N,
      H: after.H,
      protocolBefore: oldReceipts.length,
      protocolAfter: receipts.length,
      remainingMs: live.remaining_ms,
    }),
  );
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
        if (consumed > 0) await claimAfterPadding(s, admin);
        if (consumed === 1) assert.equal((await s.apply((await s.prepare()).work)).status, 200);
        if (consumed === 25) await completeLifecycle(s);
        const before = await ledger(s, admin);
        assert.equal(before.c, 460 + excess + consumed);
        assert.equal(before.consumed_c, consumed);
        assert.equal(before.consumed_e, consumed === 25 ? 41 : consumed);
        assert.equal(before.c + (25 - consumed) + 25 + 2, 512 + excess);
        const independent = await capacityEvidence(admin, s.id);
        assert.equal(independent.C, before.c);
        assert.equal(independent.R, 25 - consumed);
        assert.equal(independent.S, 43 - (consumed === 25 ? 41 : consumed));
        assert.equal(independent.H, 2);
        assert.equal(independent.bindings, 1);
        assert.equal(independent.C + independent.R + 25 + independent.H, 512 + excess);
        await assertCleanCapacity(admin, binding(s));
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
        const admitted = await capacityEvidence(admin, s.id);
        assert.equal(admitted.C, independent.C);
        assert.equal(admitted.E, independent.E);
        assert.equal(admitted.R, independent.R + (excess ? 0 : 25));
        assert.equal(admitted.S, independent.S + (excess ? 0 : 43));
        assert.equal(admitted.bindings, excess ? 1 : 2);
        if (excess) {
          assert.equal((result.body['error'] as { code: string }).code, 'FIX_RESERVATION_CAPACITY');
          assert.deepEqual(admitted.state, independent.state);
        }
        await assertCleanCapacity(admin, binding(s));
        const replay = await s.fix('BIND', p, key);
        assert.equal(replay.status, excess ? 429 : 201);
        assert.equal(replay.replayed, !excess);
        assert.deepEqual(replay.body, result.body);
        assert.deepEqual((await capacityEvidence(admin, s.id)).state, admitted.state);
        await assertCleanCapacity(admin, binding(s));
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
      await claimAfterPadding(s, admin);
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
      const independent = await capacityEvidence(admin, s.id);
      assert.equal(independent.E, 940 + excess);
      assert.equal(independent.R, 23);
      assert.equal(independent.S, 39);
      assert.equal(independent.H, 2);
      assert.equal(independent.E + independent.S + 43 + independent.H, 1024 + excess);
      assert.ok(independent.C + independent.R + 25 + independent.H < 512);
      await assertCleanCapacity(admin, binding(s));
      const input = { order_id: next, dealer_id: 'ATLAS', channel_id: randomUUID() },
        key = randomUUID(),
        result = await s.fix('BIND', input, key);
      assert.equal(result.status, excess ? 429 : 201, JSON.stringify({ before, result }));
      assert.deepEqual(await ledger(s, admin), before);
      const admitted = await capacityEvidence(admin, s.id);
      assert.equal(admitted.C, independent.C);
      assert.equal(admitted.E, independent.E);
      assert.equal(admitted.R, independent.R + (excess ? 0 : 25));
      assert.equal(admitted.S, independent.S + (excess ? 0 : 43));
      assert.equal(admitted.bindings, excess ? 1 : 2);
      if (excess) {
        assert.equal((result.body['error'] as { code: string }).code, 'FIX_RESERVATION_CAPACITY');
        assert.deepEqual(admitted.state, independent.state);
      }
      await assertCleanCapacity(admin, binding(s));
      const replay = await s.fix('BIND', input, key);
      assert.equal(replay.status, excess ? 429 : 201);
      assert.equal(replay.replayed, !excess);
      assert.deepEqual(replay.body, result.body);
      assert.deepEqual((await capacityEvidence(admin, s.id)).state, admitted.state);
      await assertCleanCapacity(admin, binding(s));
    } finally {
      await admin.end();
      await s.close();
    }
  });

void test('twenty net-boundary BIND contenders admit exactly one new reservation after committed consumption', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin'),
    holder = await connection('admin');
  const clients = await Promise.all(Array.from({ length: 20 }, () => connection('app')));
  let holding = false;
  let pending: Promise<Awaited<ReturnType<typeof s.fix>>[]> | undefined;
  try {
    const orders: string[] = [];
    for (let i = 0; i < 20; i++) orders.push(await s.createOrder());
    await padCommands(s, orders[0]!, 460, admin);
    await claimAfterPadding(s, admin);
    assert.equal((await s.apply((await s.prepare()).work)).status, 200);
    const before = await capacityEvidence(admin, s.id);
    assert.equal(before.C, 461);
    assert.equal(before.R, 24);
    assert.equal(before.S, 42);
    assert.equal(before.H, 2);
    assert.equal(before.bindings, 1);
    assert.equal(before.C + before.R + 25 + before.H, 512);
    await assertCleanCapacity(admin, binding(s));
    const beforeChannels = (
      await admin.query<{ id: string; dealer_id: string }>(
        'SELECT id,dealer_id FROM fi.fix_channels WHERE sandbox_id=$1 ORDER BY id',
        [s.id],
      )
    ).rows;
    const requests = orders.map((order_id) => ({
      input: { order_id, dealer_id: 'ATLAS', channel_id: randomUUID() },
      key: randomUUID(),
    }));
    assert.equal(new Set(requests.map((request) => request.key)).size, 20);
    assert.equal(new Set(orders).size, 20);
    const pids = await Promise.all(
      clients.map(async (db) => {
        const row = (
          await db.query<{ pid: number; role: string }>(
            'SELECT pg_backend_pid() pid,current_user AS role',
          )
        ).rows[0]!;
        assert.equal(row.role, 'tf_app');
        return row.pid;
      }),
    );
    assert.equal(new Set(pids).size, 20);
    await holder.query('BEGIN');
    holding = true;
    assert.equal(
      (await holder.query('SELECT id FROM fi.sandboxes WHERE id=$1 FOR UPDATE', [s.id])).rowCount,
      1,
    );
    pending = Promise.all(
      clients.map((db, i) => s.fix('BIND', requests[i]!.input, requests[i]!.key, db)),
    );
    void pending.catch(() => {});
    for (const pid of pids) await waitForLock(admin, pid);
    const blocked = (
      await admin.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND state='active' AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE 'SELECT fi_control.fix_command(%'",
        [pids],
      )
    ).rows;
    assert.equal(
      blocked.length,
      20,
      'All twenty BIND calls must overlap at the PostgreSQL barrier.',
    );
    assert.deepEqual((await capacityEvidence(admin, s.id)).state, before.state);
    assert.deepEqual(
      (
        await admin.query<{ id: string; dealer_id: string }>(
          'SELECT id,dealer_id FROM fi.fix_channels WHERE sandbox_id=$1 ORDER BY id',
          [s.id],
        )
      ).rows,
      beforeChannels,
    );
    await holder.query('COMMIT');
    holding = false;
    const results = await pending;
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
    const after = await capacityEvidence(admin, s.id),
      winnerIndex = results.findIndex((r) => r.status === 201),
      winner = requests[winnerIndex]!;
    assert.equal(after.C, before.C);
    assert.equal(after.E, before.E);
    assert.equal(after.R, 49);
    assert.equal(after.S, 85);
    assert.equal(after.H, 2);
    assert.equal(after.bindings, 2);
    assert.equal(after.active, 2);
    assert.equal(after.C + after.R + after.H, 512);
    assert.ok(after.E + after.S + after.H <= 1024);
    for (const table of ['fi.fix_bindings', 'fi.fix_lanes', 'fi_control.fix_reservations']) {
      const additions = after.state[table]!.filter(
        (row) => row['order_id'] === winner.input.order_id,
      );
      assert.equal(additions.length, 1, table);
      assert.deepEqual(
        after.state[table]!.filter((row) => row['order_id'] !== winner.input.order_id),
        before.state[table],
        table,
      );
    }
    const acceptedBinding = after.state['fi.fix_bindings']!.find(
      (row) => row['order_id'] === winner.input.order_id,
    )!;
    assert.equal(acceptedBinding['channel_id'], winner.input.channel_id);
    assert.equal(acceptedBinding['dealer_id'], 'ATLAS');
    const afterChannels = (
      await admin.query<{ id: string; dealer_id: string }>(
        'SELECT id,dealer_id FROM fi.fix_channels WHERE sandbox_id=$1 ORDER BY id',
        [s.id],
      )
    ).rows;
    assert.equal(afterChannels.length, beforeChannels.length + 1);
    assert.deepEqual(
      afterChannels.filter((row) => row['id'] !== winner.input.channel_id),
      beforeChannels,
    );
    assert.deepEqual(
      afterChannels.find((row) => row['id'] === winner.input.channel_id),
      { id: winner.input.channel_id, dealer_id: 'ATLAS' },
    );
    const reservation = after.state['fi_control.fix_reservations']!.find(
      (row) => row['order_id'] === winner.input.order_id,
    )!;
    assert.equal(Number(reservation['commands']), 25);
    assert.equal(Number(reservation['events']), 43);
    assert.equal(reservation['released_at'], null);
    const receipt = after.state['fi.fix_commands']!.filter(
      (row) => row['idempotency_key'] === winner.key,
    );
    assert.equal(receipt.length, 1);
    assert.equal(receipt[0]!['operation'], 'BIND');
    assert.equal(receipt[0]!['http_status'], 201);
    assert.deepEqual(receipt[0]!['response_body'], results[winnerIndex]!.body);
    const events = after.state['fi.fix_events']!.filter(
      (row) => row['command_seq'] === receipt[0]!['command_seq'],
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!['event_type'], 'BIND');
    assert.equal(events[0]!['order_id'], winner.input.order_id);
    assert.equal(
      after.state['fi_control.command_keys']!.filter(
        (row) => row['idempotency_key'] === winner.key && row['domain'] === 'FIX',
      ).length,
      1,
    );
    for (const table of ['fi.fix_commands', 'fi_control.command_keys']) {
      assert.deepEqual(
        after.state[table]!.filter((row) => row['idempotency_key'] !== winner.key),
        before.state[table],
        table,
      );
    }
    assert.deepEqual(
      after.state['fi.fix_events']!.filter(
        (row) => row['command_seq'] !== receipt[0]!['command_seq'],
      ),
      before.state['fi.fix_events'],
    );
    for (const table of [
      'fi.commands',
      'fi.audit_events',
      'fi.order_states',
      'fi.order_history',
      'fi.executions',
      'fi.positions',
      'fi.cancellation_requests',
      'fi.cancellation_outcomes',
      'fi.fix_prepared',
      'fi.fix_applications',
      'fi.fix_consumptions',
      'financial_counters',
    ])
      assert.deepEqual(after.state[table], before.state[table], table);
    await assertCleanCapacity(admin, binding(s));
    for (const [index, request] of requests.entries()) {
      assert.equal(results[index]!.replayed, false);
      if (index !== winnerIndex) {
        assert.equal(
          (results[index]!.body['error'] as { code: string }).code,
          'FIX_RESERVATION_CAPACITY',
        );
        assert.equal(
          after.state['fi_control.command_keys']!.some(
            (row) => row['idempotency_key'] === request.key,
          ),
          false,
        );
      }
      const replay = await s.fix('BIND', request.input, request.key, clients[index]);
      assert.equal(replay.status, index === winnerIndex ? 201 : 429);
      assert.equal(replay.replayed, index === winnerIndex);
      assert.deepEqual(replay.body, results[index]!.body);
    }
    assert.deepEqual((await capacityEvidence(admin, s.id)).state, after.state);
    assert.deepEqual(
      (
        await admin.query<{ id: string; dealer_id: string }>(
          'SELECT id,dealer_id FROM fi.fix_channels WHERE sandbox_id=$1 ORDER BY id',
          [s.id],
        )
      ).rows,
      afterChannels,
    );
    await assertCleanCapacity(admin, binding(s));
  } finally {
    if (holding) await holder.query('ROLLBACK');
    await pending?.catch(() => {});
    await Promise.all(clients.map((db) => db.end()));
    await holder.end();
    await admin.end();
    await s.close();
  }
});

void test('twenty pristine admission contenders preserve the lifetime four-binding limit', async () => {
  const s = await fixture(),
    admin = await connection('admin'),
    clients = await Promise.all(Array.from({ length: 20 }, () => connection('app')));
  try {
    const orders = [s.order];
    for (let i = 1; i < 20; i++) orders.push(await s.createOrder());
    const requests = orders.map((order_id) => ({
      input: { order_id, dealer_id: 'ATLAS', channel_id: randomUUID() },
      key: randomUUID(),
    }));
    const before = await capacityEvidence(admin, s.id);
    assert.equal(before.bindings, 0);
    assert.equal(before.active, 0);
    assert.equal(before.R, 0);
    assert.equal(before.S, 0);
    await assertCleanCapacity(admin, binding(s));
    const results = await Promise.all(
      clients.map((db, i) => s.fix('BIND', requests[i]!.input, requests[i]!.key, db)),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 4);
    assert.equal(results.filter((r) => r.status === 429).length, 16);
    const after = await capacityEvidence(admin, s.id),
      accepted = requests.filter((_, index) => results[index]!.status === 201);
    assert.equal(after.C, before.C);
    assert.equal(after.E, before.E);
    assert.equal(after.R, 100);
    assert.equal(after.S, 172);
    assert.equal(after.bindings, 4);
    assert.equal(after.active, 4);
    assert.equal(after.H, 2);
    assert.ok(after.C + after.R + after.H <= 512);
    assert.ok(after.E + after.S + after.H <= 1024);
    assert.deepEqual(
      after.state['fi.fix_bindings']!.map((row) => row['order_id']).sort(),
      accepted.map((request) => request.input.order_id).sort(),
    );
    assert.deepEqual(
      after.state['fi.fix_commands']!.map((row) => row['idempotency_key']).sort(),
      accepted.map((request) => request.key).sort(),
    );
    assert.equal(after.state['fi.fix_events']!.length, 4);
    for (const table of [
      'fi.commands',
      'fi.audit_events',
      'fi.order_states',
      'fi.order_history',
      'fi.executions',
      'fi.positions',
      'financial_counters',
    ])
      assert.deepEqual(after.state[table], before.state[table], table);
    await assertCleanCapacity(admin, binding(s));
    for (const [index, request] of requests.entries()) {
      assert.equal(results[index]!.replayed, false);
      if (results[index]!.status === 429) {
        assert.equal(
          (results[index]!.body['error'] as { code: string }).code,
          'FIX_RESERVATION_CAPACITY',
        );
        assert.equal(
          after.state['fi_control.command_keys']!.some(
            (row) => row['idempotency_key'] === request.key,
          ),
          false,
        );
      }
      const replay = await s.fix('BIND', request.input, request.key, clients[index]);
      assert.equal(replay.status, results[index]!.status);
      assert.equal(replay.replayed, results[index]!.status === 201);
      assert.deepEqual(replay.body, results[index]!.body);
    }
    assert.deepEqual((await capacityEvidence(admin, s.id)).state, after.state);
    await assertCleanCapacity(admin, binding(s));
  } finally {
    await Promise.all(clients.map((db) => db.end()));
    await admin.end();
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
    const final = await capacityEvidence(admin, s.id);
    assert.equal(final.C, 487);
    assert.equal(final.R, 0);
    assert.equal(final.S, 0);
    assert.equal(final.N, 2);
    assert.equal(final.H, 0);
    assert.equal(final.bindings, 4);
    assert.equal(final.active, 0);
    await assertCleanCapacity(admin, {
      sandboxId: s.id,
      digest: proof,
      generation: String(generation),
      scope: 'trade',
    });
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
          "SELECT wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 blocked FROM pg_stat_activity WHERE pid=$1",
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
      await claimAfterPadding(s, admin);
      assert.equal((await s.apply((await s.prepare()).work)).status, 200);
      const input = { order_id: next, dealer_id: 'ATLAS', channel_id: randomUUID() },
        bindKey = randomUUID(),
        manualKey = randomUUID(),
        before = await capacityEvidence(admin, s.id);
      assert.equal(before.C, 461);
      assert.equal(before.R, 24);
      assert.equal(before.H, 2);
      await assertCleanCapacity(admin, binding(s));
      const bind = (db: pg.Client) => s.fix('BIND', input, bindKey, db);
      const manual = (db: pg.Client) =>
        s.command('ACK_ORDER', { order_id: other, expected_version: '999' }, manualKey, db);
      await a.query('BEGIN');
      assert.equal(
        (await (first === 'BIND' ? bind(a) : manual(a))).status,
        first === 'BIND' ? 201 : 409,
      );
      const pid = (await b.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
      waiting = first === 'BIND' ? manual(b) : bind(b);
      await waitForLock(admin, pid);
      await a.query('COMMIT');
      const rejected = (await waiting) as Awaited<ReturnType<typeof s.fix>>;
      assert.equal(rejected.status, 429);
      assert.equal(
        (rejected.body['error'] as { code: string }).code,
        first === 'BIND' ? 'PROTECTED_FINANCIAL_CAPACITY' : 'FIX_RESERVATION_CAPACITY',
      );
      assert.equal((await ledger(s, admin)).c, first === 'BIND' ? 461 : 462);
      const after = await capacityEvidence(admin, s.id);
      assert.equal(after.C, first === 'BIND' ? 461 : 462);
      assert.equal(after.R, first === 'BIND' ? 49 : 24);
      assert.equal(after.S, first === 'BIND' ? 85 : 42);
      assert.equal(after.H, 2);
      assert.equal(after.bindings, first === 'BIND' ? 2 : 1);
      assert.ok(after.C + after.R + after.H <= 512);
      assert.ok(after.E + after.S + after.H <= 1024);
      assert.deepEqual(after.state['fi.fix_consumptions'], before.state['fi.fix_consumptions']);
      assert.deepEqual(after.state['fi.fix_applications'], before.state['fi.fix_applications']);
      await assertCleanCapacity(admin, binding(s));
      const replay = await (first === 'BIND' ? bind(a) : manual(a));
      assert.equal(replay.status, first === 'BIND' ? 201 : 409);
      assert.equal(replay.replayed, true);
      assert.deepEqual((await capacityEvidence(admin, s.id)).state, after.state);
      await assertCleanCapacity(admin, binding(s));
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
      before = await ledger(s, admin),
      independent = await capacityEvidence(admin, s.id);
    await assertCleanCapacity(admin, binding(s));
    await s.app.query('BEGIN');
    assert.equal((await s.apply(p.work)).status, 200);
    await s.app.query('ROLLBACK');
    assert.deepEqual(await ledger(s, admin), before);
    assert.deepEqual((await capacityEvidence(admin, s.id)).state, independent.state);
    await assertCleanCapacity(admin, binding(s));
    assert.equal((await s.fix('RELEASE', { order_id: s.order })).status, 409);
    const input = { order_id: next, dealer_id: 'ATLAS', channel_id: randomUUID() },
      key = randomUUID();
    await s.app.query('BEGIN');
    assert.equal((await s.fix('BIND', input, key)).status, 201);
    await s.app.query('ROLLBACK');
    assert.deepEqual((await capacityEvidence(admin, s.id)).state, independent.state);
    await assertCleanCapacity(admin, binding(s));
    const recovered = await s.fix('BIND', input, key);
    assert.equal(recovered.status, 201);
    assert.equal(recovered.replayed, false);
    assert.equal((await s.fix('BIND', { ...input, channel_id: randomUUID() }, key)).status, 409);
    assert.equal(
      (await s.apply(p.work)).status,
      200,
      'original prepared key remains usable after rollback',
    );
    const committed = await capacityEvidence(admin, s.id);
    assert.equal(committed.C, independent.C + 1);
    assert.equal(committed.E, independent.E + 1);
    assert.equal(committed.R, 49);
    assert.equal(committed.S, 85);
    assert.equal(committed.bindings, 2);
    assert.deepEqual(committed.state['fi.fix_prepared'], independent.state['fi.fix_prepared']);
    await assertCleanCapacity(admin, binding(s));
    const replay = await s.fix('BIND', input, key);
    assert.equal(replay.status, 201);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, recovered.body);
    assert.deepEqual((await capacityEvidence(admin, s.id)).state, committed.state);
    await assertCleanCapacity(admin, binding(s));
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
        key = randomUUID(),
        before = await capacityEvidence(admin, s.id);
      assert.equal(before.C, 461);
      assert.equal(before.R, 24);
      assert.equal(before.H, 2);
      assert.equal(before.C + before.R + 25 + before.H, 512);
      await assertCleanCapacity(admin, binding(s));
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
      const faultState = await capacityEvidence(admin, s.id);
      if (!after) assert.deepEqual(faultState.state, before.state);
      else {
        assert.equal(faultState.C, before.C);
        assert.equal(faultState.E, before.E);
        assert.equal(faultState.R, 49);
        assert.equal(faultState.S, 85);
        assert.equal(faultState.H, 2);
        assert.equal(faultState.bindings, 2);
        assert.equal(
          faultState.state['fi.fix_commands']!.filter(
            (row) => row['idempotency_key'] === key && row['operation'] === 'BIND',
          ).length,
          1,
        );
      }
      await assertCleanCapacity(admin, binding(s));
      const recovered = await s.fix('BIND', p, key);
      assert.equal(recovered.status, 201);
      assert.equal(recovered.replayed, after);
      const committed = await capacityEvidence(admin, s.id);
      assert.equal(committed.C, before.C);
      assert.equal(committed.E, before.E);
      assert.equal(committed.R, 49);
      assert.equal(committed.S, 85);
      assert.equal(committed.H, 2);
      assert.equal(committed.C + committed.R + committed.H, 512);
      assert.ok(committed.E + committed.S + committed.H <= 1024);
      if (after) assert.deepEqual(committed.state, faultState.state);
      for (const table of [
        'fi.commands',
        'fi.audit_events',
        'fi.fix_prepared',
        'fi.fix_consumptions',
        'fi.fix_applications',
        'financial_counters',
      ])
        assert.deepEqual(committed.state[table], before.state[table], table);
      await assertCleanCapacity(admin, binding(s));
      const replay = await s.fix('BIND', p, key);
      assert.equal(replay.status, 201);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.body, recovered.body);
      assert.deepEqual((await capacityEvidence(admin, s.id)).state, committed.state);
      await assertCleanCapacity(admin, binding(s));
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

for (const first of ['BIND', 'APPLY'] as const)
  for (const finish of ['COMMIT', 'ROLLBACK'] as const)
    void test(`net-boundary ${first} ${finish} preserves consuming APPLY and BIND original keys under contention`, async () => {
      const s = await applicationFixture(),
        admin = await connection('admin'),
        a = await connection('app'),
        b = await connection('app');
      let holding = false;
      let pending: Promise<Awaited<ReturnType<typeof s.fix>>> | undefined;
      try {
        const next = await s.createOrder(),
          other = await s.createOrder();
        await padCommands(s, other, 460, admin);
        const prepared = await s.prepare(),
          bindKey = randomUUID(),
          applyKey = randomUUID(),
          input = { order_id: next, dealer_id: 'ATLAS', channel_id: randomUUID() },
          before = await capacityEvidence(admin, s.id);
        assert.equal(before.C, 460);
        assert.equal(before.R, 25);
        assert.equal(before.S, 43);
        assert.equal(before.H, 2);
        assert.equal(before.C + before.R + 25 + before.H, 512);
        await assertCleanCapacity(admin, binding(s));
        const admit = (db: pg.Client) => s.fix('BIND', input, bindKey, db),
          apply = (db: pg.Client) => s.apply(prepared.work, applyKey, db);
        await a.query('BEGIN');
        holding = true;
        const firstResult = await (first === 'BIND' ? admit(a) : apply(a));
        assert.equal(firstResult.status, first === 'BIND' ? 201 : 200);
        assert.equal(firstResult.replayed, false);
        const pid = (await b.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
        pending = first === 'BIND' ? apply(b) : admit(b);
        void pending.catch(() => {});
        await waitForLock(admin, pid);
        assert.deepEqual((await capacityEvidence(admin, s.id)).state, before.state);
        await a.query(finish);
        holding = false;
        const secondResult = await pending;
        assert.equal(secondResult.status, first === 'BIND' ? 200 : 201);
        assert.equal(secondResult.replayed, false);
        const partial = await capacityEvidence(admin, s.id),
          applied = finish === 'COMMIT' || first === 'BIND',
          bound = finish === 'COMMIT' || first === 'APPLY';
        assert.equal(partial.C, 460 + (applied ? 1 : 0));
        assert.equal(partial.E, before.E + (applied ? 1 : 0));
        assert.equal(partial.R, 25 + (bound ? 25 : 0) - (applied ? 1 : 0));
        assert.equal(partial.S, 43 + (bound ? 43 : 0) - (applied ? 1 : 0));
        assert.equal(partial.H, 2);
        assert.equal(partial.bindings, bound ? 2 : 1);
        assert.equal(partial.active, bound ? 2 : 1);
        assert.ok(partial.C + partial.R + partial.H <= 512);
        assert.ok(partial.E + partial.S + partial.H <= 1024);
        assert.deepEqual(partial.state['fi.fix_prepared'], before.state['fi.fix_prepared']);
        assert.equal(partial.state['fi.fix_consumptions']!.length, applied ? 1 : 0);
        assert.equal(partial.state['fi.fix_applications']!.length, applied ? 1 : 0);
        if (finish === 'ROLLBACK') {
          const rolledBackKey = first === 'BIND' ? bindKey : applyKey;
          assert.equal(
            partial.state['fi.fix_commands']!.some(
              (row) => row['idempotency_key'] === rolledBackKey,
            ),
            false,
          );
          assert.equal(
            partial.state['fi_control.command_keys']!.some(
              (row) => row['idempotency_key'] === rolledBackKey,
            ),
            false,
          );
        }
        await assertCleanCapacity(admin, binding(s));
        const recovered = await (first === 'BIND' ? admit(a) : apply(a));
        assert.equal(recovered.status, first === 'BIND' ? 201 : 200);
        assert.equal(recovered.replayed, finish === 'COMMIT');
        if (finish === 'COMMIT') assert.deepEqual(recovered.body, firstResult.body);
        const committed = await capacityEvidence(admin, s.id);
        assert.equal(committed.C, 461);
        assert.equal(committed.E, before.E + 1);
        assert.equal(committed.R, 49);
        assert.equal(committed.S, 85);
        assert.equal(committed.H, 2);
        assert.equal(committed.bindings, 2);
        assert.equal(committed.active, 2);
        assert.equal(committed.C + committed.R + committed.H, 512);
        assert.ok(committed.E + committed.S + committed.H <= 1024);
        assert.deepEqual(committed.state['fi.fix_prepared'], before.state['fi.fix_prepared']);
        assert.equal(committed.state['fi.fix_consumptions']!.length, 1);
        assert.equal(committed.state['fi.fix_applications']!.length, 1);
        assert.equal(
          committed.state['fi.commands']!.filter(
            (row) =>
              row['idempotency_key'] === prepared.financialKey &&
              row['operation'] === 'ACK_ORDER' &&
              row['result_kind'] === 'APPLIED',
          ).length,
          1,
        );
        assert.equal(
          committed.state['fi.fix_commands']!.filter(
            (row) => row['idempotency_key'] === bindKey && row['operation'] === 'BIND',
          ).length,
          1,
        );
        assert.equal(
          committed.state['fi.fix_commands']!.filter(
            (row) => row['idempotency_key'] === applyKey && row['operation'] === 'APPLY',
          ).length,
          1,
        );
        await assertCleanCapacity(admin, binding(s));
        const bindReplay = await admit(a),
          applyReplay = await apply(b);
        assert.equal(bindReplay.status, 201);
        assert.equal(bindReplay.replayed, true);
        assert.equal(applyReplay.status, 200);
        assert.equal(applyReplay.replayed, true);
        assert.deepEqual(bindReplay.body, first === 'BIND' ? recovered.body : secondResult.body);
        assert.deepEqual(applyReplay.body, first === 'APPLY' ? recovered.body : secondResult.body);
        assert.deepEqual((await capacityEvidence(admin, s.id)).state, committed.state);
        await assertCleanCapacity(admin, binding(s));
      } finally {
        if (holding) await a.query('ROLLBACK');
        await pending?.catch(() => {});
        await a.end();
        await b.end();
        await admin.end();
        await s.close();
      }
    });

for (const first of ['BIND', 'ROTATE'] as const)
  for (const successful of [false, true])
    void test(`net-boundary ${first} commits first against ${successful ? 'successful' : 'rejected'} rotation and preserves current-authorized admission replay`, async () => {
      const s = await applicationFixture(),
        admin = await connection('admin'),
        a = await connection('app'),
        b = await connection('app');
      let holding = false;
      let pending: Promise<Awaited<ReturnType<typeof s.fix>>> | undefined;
      try {
        const next = await s.createOrder(),
          other = await s.createOrder();
        await padCommands(s, other, 460, admin);
        const before = await capacityEvidence(admin, s.id),
          input = { order_id: next, dealer_id: 'ATLAS', channel_id: randomUUID() },
          bindKey = randomUUID(),
          rotateKey = randomUUID(),
          read = digest(randomUUID()),
          trade = digest(randomUUID()),
          hash = digest(randomUUID()),
          expected = successful ? 1 : 999;
        assert.equal(before.C, 460);
        assert.equal(before.R, 25);
        assert.equal(before.S, 43);
        assert.equal(before.H, 2);
        assert.equal(before.C + before.R + 25 + before.H, 512);
        await assertCleanCapacity(admin, binding(s));
        const admit = async (db: pg.Client, proof = s.proof, generation = '1') =>
          (
            await db.query<{ r: Awaited<ReturnType<typeof s.fix>> }>(
              'SELECT fi_control.fix_command($1,$2,$3,$4,$5,$6,$7) r',
              [s.id, proof, generation, 'BIND', JSON.stringify(input), bindKey, s.actor],
            )
          ).rows[0]!.r;
        const rotate = async (db: pg.Client, proof = s.proof, generation = '1') =>
          (
            await db.query<{ r: Awaited<ReturnType<typeof s.fix>> }>(
              'SELECT fi_control.rotate_capabilities($1,$2,$3,$4,$5,$6,$7,$8,$9) r',
              [s.id, proof, generation, expected, read, trade, hash, rotateKey, s.actor],
            )
          ).rows[0]!.r;
        await a.query('BEGIN');
        holding = true;
        const firstResult = await (first === 'BIND' ? admit(a) : rotate(a));
        assert.equal(firstResult.status, first === 'BIND' ? 201 : successful ? 200 : 409);
        assert.equal(firstResult.replayed, false);
        const pid = (await b.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
        pending = first === 'BIND' ? rotate(b) : admit(b);
        void pending.catch(() => {});
        await waitForLock(admin, pid);
        assert.deepEqual((await capacityEvidence(admin, s.id)).state, before.state);
        await a.query('COMMIT');
        holding = false;
        const secondResult = await pending,
          deniedOldBinding = first === 'ROTATE' && successful;
        assert.equal(
          secondResult.status,
          first === 'BIND' ? (successful ? 200 : 409) : deniedOldBinding ? 404 : 201,
        );
        assert.equal(secondResult.replayed, false);
        if (deniedOldBinding)
          assert.equal((secondResult.body['error'] as { code: string }).code, 'SANDBOX_NOT_FOUND');
        const proof = successful ? trade : s.proof,
          generation = successful ? '2' : '1',
          current = binding(s, proof, generation),
          partial = await capacityEvidence(admin, s.id);
        assert.equal(partial.C, 461);
        assert.equal(partial.E, before.E + 1);
        assert.equal(partial.H, 1);
        assert.equal(partial.R, deniedOldBinding ? 25 : 50);
        assert.equal(partial.S, deniedOldBinding ? 43 : 86);
        assert.equal(partial.bindings, deniedOldBinding ? 1 : 2);
        assert.ok(partial.C + partial.R + partial.H <= 512);
        assert.ok(partial.E + partial.S + partial.H <= 1024);
        assert.equal(partial.state['fi.commands']!.length, before.state['fi.commands']!.length + 1);
        assert.equal(
          partial.state['fi.audit_events']!.length,
          before.state['fi.audit_events']!.length + 1,
        );
        const rotationReceipts = partial.state['fi.commands']!.filter(
          (row) => row['idempotency_key'] === rotateKey,
        );
        assert.equal(rotationReceipts.length, 1);
        assert.equal(rotationReceipts[0]!['operation'], 'ROTATE_CAPABILITIES');
        assert.equal(rotationReceipts[0]!['http_status'], successful ? 200 : 409);
        assert.equal(rotationReceipts[0]!['result_kind'], successful ? 'APPLIED' : 'REJECTED');
        if (!successful) {
          const rejected = first === 'ROTATE' ? firstResult : secondResult;
          assert.equal((rejected.body['error'] as { code: string }).code, 'GENERATION_CONFLICT');
        }
        if (deniedOldBinding) {
          assert.equal(
            partial.state['fi.fix_commands']!.some((row) => row['idempotency_key'] === bindKey),
            false,
          );
          assert.equal(
            partial.state['fi_control.command_keys']!.some(
              (row) => row['idempotency_key'] === bindKey,
            ),
            false,
          );
        }
        for (const table of [
          'fi.order_states',
          'fi.order_history',
          'fi.executions',
          'fi.positions',
          'fi.fix_prepared',
          'fi.fix_applications',
          'fi.fix_consumptions',
        ])
          assert.deepEqual(partial.state[table], before.state[table], table);
        await assertCleanCapacity(admin, current);
        const recovered = await admit(a, proof, generation);
        assert.equal(recovered.status, 201);
        assert.equal(recovered.replayed, !deniedOldBinding);
        if (!deniedOldBinding)
          assert.deepEqual(recovered.body, first === 'BIND' ? firstResult.body : secondResult.body);
        const committed = await capacityEvidence(admin, s.id);
        assert.equal(committed.C, 461);
        assert.equal(committed.E, before.E + 1);
        assert.equal(committed.R, 50);
        assert.equal(committed.S, 86);
        assert.equal(committed.H, 1);
        assert.equal(committed.bindings, 2);
        assert.equal(committed.active, 2);
        assert.equal(committed.C + committed.R + committed.H, 512);
        assert.ok(committed.E + committed.S + committed.H <= 1024);
        assert.equal(
          committed.state['fi.fix_commands']!.filter(
            (row) => row['idempotency_key'] === bindKey && row['operation'] === 'BIND',
          ).length,
          1,
        );
        await assertCleanCapacity(admin, current);
        if (successful) {
          for (const [staleProof, staleGeneration] of [
            [s.proof, '1'],
            [s.proof, '2'],
            [trade, '1'],
          ]) {
            const stale = await admit(a, staleProof, staleGeneration);
            assert.equal(stale.status, 404);
            assert.equal((stale.body['error'] as { code: string }).code, 'SANDBOX_NOT_FOUND');
          }
        }
        const bindReplay = await admit(a, proof, generation),
          rotationReplay = await rotate(b, proof, generation);
        assert.equal(bindReplay.status, 201);
        assert.equal(bindReplay.replayed, true);
        assert.deepEqual(bindReplay.body, recovered.body);
        assert.equal(rotationReplay.status, successful ? 200 : 409);
        assert.equal(rotationReplay.replayed, true);
        assert.deepEqual(
          rotationReplay.body,
          first === 'ROTATE' ? firstResult.body : secondResult.body,
        );
        assert.deepEqual((await capacityEvidence(admin, s.id)).state, committed.state);
        await assertCleanCapacity(admin, current);
      } finally {
        if (holding) await a.query('ROLLBACK');
        await pending?.catch(() => {});
        await a.end();
        await b.end();
        await admin.end();
        await s.close();
      }
    });
