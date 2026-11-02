import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from './fix-fixture.js';
import { connection, owner } from './harness.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { FixFoundationService } from '../../app/server/fix/foundation.js';
import { DomainError } from '../../app/domain/errors.js';
for (const committed of [false, true])
  void test(`SIGKILL ${committed ? 'after' : 'before'} protocol metadata COMMIT preserves exact original-key recovery`, async () => {
    const s = await fixture();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const key = randomUUID(),
        p = { order_id: s.order, dealer_id: 'ATLAS', channel_id: s.channel };
      child = spawn(process.execPath, ['--import', 'tsx', 'tests/postgres/fix-crash-worker.ts'], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: process.env,
      });
      const ready = once(child, 'message');
      child.send({
        commit: committed,
        args: [s.id, s.proof, 1, 'BIND', JSON.stringify(p), key, s.actor],
      });
      const [m] = (await ready) as [{ phase: string }];
      assert.equal(m.phase, committed ? 'committed' : 'uncommitted');
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
      const recovered = await s.fix('BIND', p, key);
      assert.equal(recovered.status, 201);
      assert.equal(recovered.replayed, committed);
      assert.equal(
        (
          await s.app.query<Record<string, unknown>>(
            'SELECT count(*)::int n FROM fi.fix_bindings WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0]!.n,
        1,
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
      if (child && child.exitCode === null && child.signalCode === null) {
        const e = once(child, 'exit');
        child.kill('SIGKILL');
        await e;
      }
      await s.close();
    }
  });
for (const after of [false, true])
  void test(`connection loss ${after ? 'after' : 'around'} COMMIT keeps original metadata request and never invents a replacement`, async () => {
    const s = await fixture(),
      cfg = await owner(),
      admin = await connection('admin');
    let pid = 0;
    const db = new WorkflowDatabase(
      cfg.appUrl!,
      after
        ? {
            afterCommit: async () => {
              await admin.query<Record<string, unknown>>('SELECT pg_terminate_backend($1)', [pid]);
              throw new Error('Lost response.');
            },
          }
        : {
            beforeCommit: async () => {
              await admin.query<Record<string, unknown>>('SELECT pg_terminate_backend($1)', [pid]);
            },
          },
    );
    const service = new FixFoundationService(db, true);
    const verify = () => {};
    const p = { order_id: s.order, dealer_id: 'ATLAS', channel_id: s.channel },
      key = randomUUID(),
      binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' };
    try {
      const c = await db.pool.connect();
      pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
      c.release();
      await assert.rejects(
        service.command(binding, s.actor, 'BIND', p, key, verify),
        (e: unknown) => e instanceof DomainError && e.status === 503,
      );
      await db.close();
      const fresh = new WorkflowDatabase(cfg.appUrl!);
      try {
        const r = await new FixFoundationService(fresh, true).command(
          binding,
          s.actor,
          'BIND',
          p,
          key,
          verify,
        );
        assert.equal(r.status, 201);
        assert.equal(r.replayed, after);
      } finally {
        await fresh.close();
      }
    } finally {
      await db.close();
      await admin.end();
      await s.close();
    }
  });
void test('session logout during a queued metadata mutation rolls back its binding/reservation/receipt/audit together', async () => {
  const s = await fixture(),
    cfg = await owner();
  let valid = true;
  const db = new WorkflowDatabase(cfg.appUrl!, {
      beforeCommit: () => {
        valid = false;
      },
    }),
    service = new FixFoundationService(db, true);
  try {
    await assert.rejects(
      service.command(
        { sandboxId: s.id, digest: s.proof, scope: 'trade', generation: '1' },
        s.actor,
        'BIND',
        { order_id: s.order, dealer_id: 'ATLAS', channel_id: s.channel },
        randomUUID(),
        () => {
          if (!valid) throw new DomainError(401, 'UNAUTHORIZED', 'Session expired.');
        },
      ),
      (e: unknown) => e instanceof DomainError && e.status === 401,
    );
    assert.equal(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi.fix_bindings WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      0,
    );
    assert.equal(
      (
        await s.app.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi.fix_commands WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      0,
    );
  } finally {
    await db.close();
    await s.close();
  }
});
void test('feature defaults OFF, read bindings cannot mutate, and no legacy order changes occur', async () => {
  const s = await fixture(),
    cfg = await owner(),
    db = new WorkflowDatabase(cfg.appUrl!);
  try {
    const binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' };
    const input = { order_id: s.order, dealer_id: 'ATLAS', channel_id: s.channel };
    await assert.rejects(
      new FixFoundationService(db).command(binding, s.actor, 'BIND', input, randomUUID(), () => {}),
      (e: unknown) => e instanceof DomainError && e.code === 'FIX_FOUNDATION_DISABLED',
    );
    await assert.rejects(
      new FixFoundationService(db, true).command(
        { ...binding, scope: 'read' },
        s.actor,
        'BIND',
        input,
        randomUUID(),
        () => {},
      ),
      (e: unknown) => e instanceof DomainError && e.status === 403,
    );
    assert.equal((await s.command('ACK_ORDER', { expected_version: '1' })).status, 200);
  } finally {
    await db.close();
    await s.close();
  }
});
void test('an asynchronous leased-client termination after COMMIT is captured as unknown rather than an uncaught error or false success', async () => {
  const s = await fixture(),
    cfg = await owner(),
    admin = await connection('admin');
  let active: PoolClient | undefined,
    pid = 0;
  const db = new WorkflowDatabase(cfg.appUrl!, {
    afterCommit: async () => {
      assert.ok(active);
      const ended = new Promise<void>((resolve) => active!.once('end', resolve));
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      await ended;
    },
  });
  try {
    active = await db.pool.connect();
    pid = (await active.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    active.release();
    const p = { order_id: s.order, dealer_id: 'ATLAS', channel_id: s.channel },
      key = randomUUID();
    await assert.rejects(
      new FixFoundationService(db, true).command(
        { sandboxId: s.id, digest: s.proof, scope: 'trade', generation: '1' },
        s.actor,
        'BIND',
        p,
        key,
        () => {},
      ),
      (e: unknown) => e instanceof DomainError && e.code === 'OUTCOME_UNKNOWN',
    );
    const replay = await s.fix('BIND', p, key);
    assert.equal(replay.status, 201);
    assert.equal(replay.replayed, true);
  } finally {
    await db.close();
    await admin.end();
    await s.close();
  }
});

import { createHash } from 'node:crypto';
import { encodeFix44 } from '../../app/protocol/fix44/index.js';
import { report, record } from './fix-fixture.js';
import { durableFixSnapshot } from './fix-recovery-evidence.js';

type FixFixture = Awaited<ReturnType<typeof fixture>>;
const financialTables = [
  'commands',
  'audit_events',
  'orders',
  'order_states',
  'executions',
  'positions',
  'cancellation_requests',
  'cancellation_outcomes',
  'order_history',
  'sandboxes',
] as const;

async function crashBeforeCommit(
  s: FixFixture,
  action: 'PREPARE' | 'RECORD',
  input: Record<string, unknown>,
  key: string,
) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/postgres/fix-crash-worker.ts'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: process.env,
  });
  try {
    const ready = new Promise<unknown>((resolve, reject) => {
      const clean = () => {
        child.off('message', message);
        child.off('exit', exited);
        child.off('error', failed);
      };
      const message = (value: unknown) => {
        clean();
        resolve(value);
      };
      const exited = () => {
        clean();
        reject(new Error('Crash worker exited before its transaction barrier.'));
      };
      const failed = () => {
        clean();
        reject(new Error('Crash worker could not start.'));
      };
      child.once('message', message);
      child.once('exit', exited);
      child.once('error', failed);
    });
    child.send({
      commit: false,
      args: [s.id, s.proof, '1', action, JSON.stringify(input), key, s.actor],
    });
    assert.deepEqual(await ready, { phase: 'uncommitted' });
    const exited = once(child, 'exit');
    assert.equal(child.kill('SIGKILL'), true);
    await exited;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
}

async function queuedRecoveryHead(s: FixFixture) {
  assert.equal((await s.bind()).status, 201);
  const ackFields = await report(s),
    ackRaw = encodeFix44(ackFields),
    ackAttempt = randomUUID(),
    ack = await record(s, ackFields, randomUUID(), ackAttempt);
  assert.equal(ack.status, 201);
  const fillFields = await report(s, {
      '34': '2',
      '150': 'F',
      '39': '1',
      '14': '40.00',
      '151': '60.00',
      '32': '40.00',
      '31': ackFields['44'],
      '6': ackFields['44'],
    }),
    fillRaw = encodeFix44(fillFields),
    fillAttempt = randomUUID(),
    fill = await record(s, fillFields, randomUUID(), fillAttempt),
    work = randomUUID(),
    later = randomUUID(),
    laneOwner = randomUUID();
  assert.equal(fill.status, 201);
  assert.equal(
    (await s.fix('QUEUE', { order_id: s.order, message_id: ack.body['message_id'], work_id: work }))
      .status,
    201,
  );
  assert.equal(
    (
      await s.fix('QUEUE', {
        order_id: s.order,
        message_id: fill.body['message_id'],
        work_id: later,
      })
    ).status,
    201,
  );
  const claim = await s.fix('CLAIM', { order_id: s.order, owner_id: laneOwner });
  assert.equal(claim.status, 200);
  assert.equal(claim.body['fence'], '1');
  return {
    input: {
      order_id: s.order,
      owner_id: laneOwner,
      fence: '1',
      work_id: work,
      financial_key: randomUUID(),
    },
    later,
    fill,
    bytes: [
      { id: ackAttempt, raw: ackRaw },
      { id: fillAttempt, raw: fillRaw },
    ],
  };
}

void test('SIGKILL before PREPARE COMMIT rolls back payload, key, receipt and event while queued evidence survives', async () => {
  const s = await fixture();
  try {
    const h = await queuedRecoveryHead(s),
      key = randomUUID(),
      before = await durableFixSnapshot(s.id);
    assert.equal(before['fix_prepared']!.length, 0);
    const fill = before['fix_messages']!.find((r) => r['id'] === h.fill.body['message_id'])!;
    assert.match(String(fill['execution_id']), /^[a-f0-9-]{36}$/);
    assert.match(String(fill['source_event_id']), /^[a-f0-9-]{36}$/);
    assert.notEqual(fill['execution_id'], fill['source_event_id']);
    await crashBeforeCommit(s, 'PREPARE', h.input, key);
    assert.ok(
      JSON.stringify(await durableFixSnapshot(s.id)) === JSON.stringify(before),
      'PREPARE rollback changed durable evidence.',
    );
    const recovered = await s.fix('PREPARE', h.input, key);
    assert.equal(recovered.status, 201);
    assert.equal(recovered.replayed, false);
    assert.deepEqual(recovered.body['payload'], { order_id: s.order, expected_version: '1' });
    assert.equal(recovered.body['financial_key'], h.input.financial_key);
    const after = await durableFixSnapshot(s.id);
    assert.equal(after['fix_prepared']!.length, 1);
    const prepared = after['fix_prepared']![0]!;
    assert.equal(prepared['work_id'], h.input.work_id);
    assert.equal(prepared['financial_key'], h.input.financial_key);
    assert.equal(prepared['operation'], 'ACK_ORDER');
    assert.equal(prepared['prepared_fence'], 1);
    assert.equal(prepared['prepared_generation'], 1);
    assert.equal(
      prepared['request_hash'],
      createHash('sha256').update(String(prepared['payload_text'])).digest('hex'),
    );
    assert.deepEqual(
      after['command_keys']!.filter((r) => r['idempotency_key'] === h.input.financial_key).map(
        (r) => r['domain'],
      ),
      ['FIX_PREPARED'],
    );
    const receipt = after['fix_commands']!.filter((r) => r['idempotency_key'] === key);
    assert.equal(receipt.length, 1);
    assert.equal(receipt[0]!['operation'], 'PREPARE');
    assert.equal(receipt[0]!['http_status'], 201);
    assert.equal(
      after['fix_events']!.filter(
        (r) => r['command_seq'] === receipt[0]!['command_seq'] && r['event_type'] === 'PREPARE',
      ).length,
      1,
    );
    for (const table of [
      'fix_channels',
      'fix_bindings',
      'fix_lanes',
      'fix_messages',
      'fix_attempts',
      'fix_sequence_slots',
      'fix_work',
      'fix_outcomes',
      'fix_dealer_correlations',
      'fix_cancel_correlations',
      'fix_outbox',
      'fix_reservations',
      ...financialTables,
    ])
      assert.ok(
        JSON.stringify(after[table]) === JSON.stringify(before[table]),
        `PREPARE changed ${table}.`,
      );
    for (const expected of h.bytes) {
      const attempt = after['fix_attempts']!.find((r) => r['id'] === expected.id)!;
      assert.ok(
        Buffer.from(String(attempt['raw_bytes']).slice(2), 'hex').equals(expected.raw),
        'Original protocol bytes changed.',
      );
      assert.equal(attempt['raw_hash'], createHash('sha256').update(expected.raw).digest('hex'));
    }
    const later = await s.fix('PREPARE', {
      ...h.input,
      work_id: h.later,
      financial_key: randomUUID(),
    });
    assert.equal(later.status, 409);
    assert.equal((later.body['error'] as { code: string }).code, 'FIX_UNRESOLVED_HEAD');
    assert.ok(
      JSON.stringify(await durableFixSnapshot(s.id)) === JSON.stringify(after),
      'Blocked later work changed durable evidence.',
    );
  } finally {
    await s.close();
  }
});

for (const kind of ['inbound fill', 'outbound cancel', 'physical retransmission'] as const)
  void test(`SIGKILL before RECORD COMMIT rolls back ${kind} and original-key recovery retains exact bytes`, async () => {
    const s = await fixture();
    try {
      assert.equal((await s.bind()).status, 201);
      const base = await report(s);
      let fields: Record<string, string>, existingMessage: unknown;
      if (kind === 'inbound fill') {
        fields = await report(s, {
          '150': 'F',
          '39': '1',
          '14': '40.00',
          '151': '60.00',
          '32': '40.00',
          '31': base['44'],
          '6': base['44'],
        });
      } else {
        const first = await record(s, base);
        assert.equal(first.status, 201);
        existingMessage = first.body['message_id'];
        if (kind === 'physical retransmission')
          fields = { ...base, '43': 'Y', '122': base['52'], '52': '20261030-12:01:00.000' };
        else {
          fields = Object.fromEntries(
            (['35', '49', '56', '34', '52', '37', '55', '167', '54', '38', '60'] as const).map(
              (tag) => [tag, base[tag]],
            ),
          );
          Object.assign(fields, {
            '35': 'F',
            '49': 'TRADEFLOW',
            '56': 'ATLAS',
            '34': '2',
            '11': randomUUID(),
            '41': s.order,
          });
        }
      }
      const raw = encodeFix44(fields),
        input = { order_id: s.order, attempt_id: randomUUID(), raw_hex: raw.toString('hex') },
        key = randomUUID(),
        before = await durableFixSnapshot(s.id);
      await crashBeforeCommit(s, 'RECORD', input, key);
      assert.ok(
        JSON.stringify(await durableFixSnapshot(s.id)) === JSON.stringify(before),
        'RECORD rollback left partial durable evidence.',
      );
      const original = await s.fix('RECORD', input, key);
      assert.equal(original.status, 201);
      assert.equal(original.replayed, false);
      assert.equal(original.body['attempt_id'], input.attempt_id);
      assert.equal(original.body['raw_hash'], createHash('sha256').update(raw).digest('hex'));
      assert.equal(original.body['financial_applied'], false);
      const committed = await durableFixSnapshot(s.id),
        attempts = committed['fix_attempts']!.filter((r) => r['id'] === input.attempt_id),
        message = committed['fix_messages']!.find((r) => r['id'] === original.body['message_id'])!;
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]!['message_id'], message['id']);
      assert.equal(attempts[0]!['attempt_no'], kind === 'physical retransmission' ? 2 : 1);
      assert.equal(attempts[0]!['state'], kind === 'outbound cancel' ? 'STAGED' : 'RECEIVED');
      assert.ok(
        Buffer.from(String(attempts[0]!['raw_bytes']).slice(2), 'hex').equals(raw),
        'Recovered frame bytes differ.',
      );
      assert.equal(attempts[0]!['raw_hash'], createHash('sha256').update(raw).digest('hex'));
      assert.equal(message['identity_kind'], kind === 'outbound cancel' ? 'CANCEL' : 'EXEC_REPORT');
      assert.equal(message['identity_value'], fields[kind === 'outbound cancel' ? '11' : '17']);
      assert.equal(message['direction'], kind === 'outbound cancel' ? 'OUT' : 'IN');
      assert.equal(
        committed['fix_messages']!.length,
        before['fix_messages']!.length + (kind === 'physical retransmission' ? 0 : 1),
      );
      assert.equal(committed['fix_attempts']!.length, before['fix_attempts']!.length + 1);
      assert.equal(committed['fix_commands']!.length, before['fix_commands']!.length + 1);
      assert.equal(committed['fix_events']!.length, before['fix_events']!.length + 1);
      assert.equal(
        committed['command_keys']!.filter(
          (r) => r['idempotency_key'] === key && r['domain'] === 'FIX',
        ).length,
        1,
      );
      assert.equal(
        committed['fix_sequence_slots']!.filter((r) => r['message_id'] === message['id']).length,
        1,
      );
      if (kind === 'outbound cancel') {
        assert.equal(
          committed['fix_outbox']!.filter(
            (r) => r['message_id'] === message['id'] && r['delivery_state'] === 'NOT_IMPLEMENTED',
          ).length,
          1,
        );
        assert.equal(
          committed['fix_cancel_correlations']!.filter(
            (r) =>
              r['cl_ord_id'] === fields['11'] &&
              r['orig_cl_ord_id'] === s.order &&
              r['first_message_id'] === message['id'],
          ).length,
          1,
        );
      } else {
        assert.equal(committed['fix_outbox']!.length, 0);
        assert.equal(committed['fix_dealer_correlations']!.length, 1);
      }
      if (kind === 'physical retransmission') assert.equal(message['id'], existingMessage);
      if (kind === 'inbound fill') {
        assert.match(String(message['execution_id']), /^[a-f0-9-]{36}$/);
        assert.match(String(message['source_event_id']), /^[a-f0-9-]{36}$/);
        assert.notEqual(message['execution_id'], message['source_event_id']);
      }
      for (const table of financialTables)
        assert.ok(
          JSON.stringify(committed[table]) === JSON.stringify(before[table]),
          `RECORD changed ${table}.`,
        );
      const replay = await s.fix('RECORD', input, key);
      assert.equal(replay.status, 201);
      assert.equal(replay.replayed, true);
      assert.ok(
        JSON.stringify(replay.body) === JSON.stringify(original.body),
        'Original RECORD receipt changed.',
      );
      assert.ok(
        JSON.stringify(await durableFixSnapshot(s.id)) === JSON.stringify(committed),
        'RECORD replay added durable evidence.',
      );
    } finally {
      await s.close();
    }
  });

void test('lost PREPARE response is exactly OUTCOME_UNKNOWN; concurrent recovery and renewed fencing preserve original evidence', async () => {
  const s = await fixture(),
    cfg = await owner(),
    lost = new WorkflowDatabase(cfg.appUrl!, {
      afterCommit: () => {
        throw new Error('Lost PREPARE response.');
      },
    }),
    fresh = Array.from({ length: 3 }, () => new WorkflowDatabase(cfg.appUrl!));
  try {
    const h = await queuedRecoveryHead(s),
      key = randomUUID(),
      binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' },
      before = await durableFixSnapshot(s.id);
    await assert.rejects(
      new FixFoundationService(lost, true).command(
        binding,
        s.actor,
        'PREPARE',
        h.input,
        key,
        () => {},
      ),
      (error: unknown) =>
        error instanceof DomainError &&
        error.status === 503 &&
        error.code === 'OUTCOME_UNKNOWN' &&
        error.message === 'The commit outcome is unknown. Recover and retry the original key.',
    );
    const committed = await durableFixSnapshot(s.id);
    assert.equal(committed['fix_prepared']!.length, 1);
    const retained = committed['fix_prepared']![0]!;
    assert.equal(retained['financial_key'], h.input.financial_key);
    assert.equal(retained['work_id'], h.input.work_id);
    assert.equal(retained['operation'], 'ACK_ORDER');
    assert.deepEqual(retained['payload'], { order_id: s.order, expected_version: '1' });
    assert.equal(retained['prepared_fence'], 1);
    assert.equal(retained['prepared_generation'], 1);
    const candidate = committed['fix_messages']!.find(
      (r) => r['id'] === h.fill.body['message_id'],
    )!;
    assert.match(String(candidate['execution_id']), /^[a-f0-9-]{36}$/);
    assert.match(String(candidate['source_event_id']), /^[a-f0-9-]{36}$/);
    assert.notEqual(candidate['execution_id'], candidate['source_event_id']);
    for (const expected of h.bytes) {
      const attempt = committed['fix_attempts']!.find((r) => r['id'] === expected.id)!;
      assert.ok(
        Buffer.from(String(attempt['raw_bytes']).slice(2), 'hex').equals(expected.raw),
        'Lost-response recovery changed original bytes.',
      );
      assert.equal(attempt['raw_hash'], createHash('sha256').update(expected.raw).digest('hex'));
    }
    assert.equal(
      retained['request_hash'],
      createHash('sha256').update(String(retained['payload_text'])).digest('hex'),
    );
    const receipts = committed['fix_commands']!.filter((r) => r['idempotency_key'] === key);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!['operation'], 'PREPARE');
    assert.equal(receipts[0]!['http_status'], 201);
    assert.equal(committed['fix_commands']!.length, before['fix_commands']!.length + 1);
    assert.equal(committed['fix_events']!.length, before['fix_events']!.length + 1);
    assert.equal(
      committed['fix_events']!.filter(
        (r) => r['command_seq'] === receipts[0]!['command_seq'] && r['event_type'] === 'PREPARE',
      ).length,
      1,
    );
    assert.equal(
      committed['command_keys']!.filter(
        (r) => r['idempotency_key'] === key && r['domain'] === 'FIX',
      ).length,
      1,
    );
    assert.equal(
      committed['command_keys']!.filter(
        (r) => r['idempotency_key'] === h.input.financial_key && r['domain'] === 'FIX_PREPARED',
      ).length,
      1,
    );
    const recovered = await Promise.all(
      fresh.map((db) =>
        new FixFoundationService(db, true).command(
          binding,
          s.actor,
          'PREPARE',
          h.input,
          key,
          () => {},
        ),
      ),
    );
    for (const result of recovered) {
      assert.equal(result.status, 201);
      assert.equal(result.replayed, true);
      assert.ok(
        JSON.stringify(result.body) === JSON.stringify(receipts[0]!['response_body']),
        'Recovered PREPARE receipt differs.',
      );
    }
    assert.ok(
      JSON.stringify(await durableFixSnapshot(s.id)) === JSON.stringify(committed),
      'Concurrent recovery duplicated or replaced durable evidence.',
    );
    const service = new FixFoundationService(fresh[0]!, true);
    await assert.rejects(
      service.command({ ...binding, scope: 'read' }, s.actor, 'PREPARE', h.input, key, () => {}),
      (error: unknown) =>
        error instanceof DomainError && error.status === 403 && error.code === 'FORBIDDEN',
    );
    await assert.rejects(
      service.command(binding, s.actor, 'PREPARE', h.input, key, () => {
        throw new DomainError(401, 'UNAUTHORIZED', 'Session expired.');
      }),
      (error: unknown) =>
        error instanceof DomainError && error.status === 401 && error.code === 'UNAUTHORIZED',
    );
    const foreign = await service.command(
      { ...binding, digest: '0'.repeat(64) },
      s.actor,
      'PREPARE',
      h.input,
      key,
      () => {},
    );
    assert.equal(foreign.status, 404);
    assert.equal((foreign.body as { error: { code: string } }).error.code, 'SANDBOX_NOT_FOUND');
    assert.ok(
      JSON.stringify(await durableFixSnapshot(s.id)) === JSON.stringify(committed),
      'Denied recovery changed durable evidence.',
    );
    const renewed = await s.fix('CLAIM', { order_id: s.order, owner_id: h.input.owner_id });
    assert.equal(renewed.status, 200);
    assert.equal(renewed.body['fence'], '2');
    const fenced = await durableFixSnapshot(s.id),
      stale = await s.fix('PREPARE', h.input, randomUUID());
    assert.equal(stale.status, 409);
    assert.equal((stale.body['error'] as { code: string }).code, 'FIX_STALE_FENCE');
    const later = await s.fix('PREPARE', {
      ...h.input,
      fence: '2',
      work_id: h.later,
      financial_key: randomUUID(),
    });
    assert.equal(later.status, 409);
    assert.equal((later.body['error'] as { code: string }).code, 'FIX_UNRESOLVED_HEAD');
    const replacement = await s.fix('PREPARE', {
      ...h.input,
      fence: '2',
      financial_key: randomUUID(),
    });
    assert.equal(replacement.status, 409);
    assert.equal(
      (replacement.body['error'] as { code: string }).code,
      'FIX_ALREADY_PREPARED_RETAIN_ORIGINAL',
    );
    const original = await s.fix('PREPARE', h.input, key);
    assert.equal(original.status, 201);
    assert.equal(original.replayed, true);
    assert.ok(
      JSON.stringify(original.body) === JSON.stringify(receipts[0]!['response_body']),
      'Original-key replay after fencing changed retained preparation.',
    );
    assert.ok(
      JSON.stringify(await durableFixSnapshot(s.id)) === JSON.stringify(fenced),
      'Fencing checks mutated prepared evidence.',
    );
    for (const table of [
      'fix_prepared',
      'fix_messages',
      'fix_attempts',
      'fix_sequence_slots',
      'fix_work',
      'fix_outcomes',
      'fix_reservations',
      ...financialTables,
    ])
      assert.ok(
        JSON.stringify(fenced[table]) ===
          JSON.stringify(table === 'fix_prepared' ? committed[table] : before[table]),
        `Recovery changed ${table}.`,
      );
    assert.equal(fenced['executions']!.length, 0);
    assert.equal(fenced['positions']!.length, 0);
    assert.equal(fenced['cancellation_requests']!.length, 0);
    assert.equal(fenced['cancellation_outcomes']!.length, 0);
    // Rotation itself is financial control activity; compare recovery against
    // the post-rotation snapshot, not the pre-rotation financial counters.
    const proof = createHash('sha256').update(randomUUID()).digest('hex');
    const rotated = await s.app.query<{ result: { status: number } }>(
      'SELECT fi_control.rotate_capabilities($1,$2,1,1,$3,$4,$5,$6,$7) AS result',
      [
        s.id,
        s.proof,
        createHash('sha256').update(randomUUID()).digest('hex'),
        proof,
        createHash('sha256').update('recovery-rotation').digest('hex'),
        randomUUID(),
        s.actor,
      ],
    );
    assert.equal(rotated.rows[0]!.result.status, 200);
    const rotation = await durableFixSnapshot(s.id);
    assert.equal(rotation['sandboxes']![0]!['generation'], 2);
    const old = await service.command(binding, s.actor, 'PREPARE', h.input, key, () => {});
    assert.equal(old.status, 404);
    assert.equal((old.body as { error: { code: string } }).error.code, 'SANDBOX_NOT_FOUND');
    const currentBinding = { ...binding, digest: proof, generation: '2' };
    const current = await service.command(
      currentBinding,
      s.actor,
      'PREPARE',
      h.input,
      key,
      () => {},
    );
    assert.equal(current.status, 201);
    assert.equal(current.replayed, true);
    assert.ok(
      JSON.stringify(current.body) === JSON.stringify(receipts[0]!['response_body']),
      'Current generation must recover the original PREPARE receipt.',
    );
    const currentReceipt = await service.read(currentBinding, 'RECEIPT', key, () => {});
    assert.equal(currentReceipt.status, 200);
    assert.ok(
      JSON.stringify((currentReceipt.body as { body: unknown }).body) ===
        JSON.stringify(current.body),
      'Current generation receipt must match original-key replay.',
    );
    assert.ok(
      JSON.stringify(await durableFixSnapshot(s.id)) === JSON.stringify(rotation),
      'Generation recovery changed durable evidence.',
    );
    for (const table of ['fix_prepared', 'fix_attempts', 'fix_messages', 'fix_reservations'])
      assert.ok(
        JSON.stringify(rotation[table]) === JSON.stringify(fenced[table]),
        `Rotation changed ${table}.`,
      );
  } finally {
    await lost.close();
    await Promise.all(fresh.map((db) => db.close()));
    await s.close();
  }
});
