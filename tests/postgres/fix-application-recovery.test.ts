import type pg from 'pg';
import {
  oracleEvidence,
  recoveryState,
  recoveryOracle,
  recoveryTables,
  dropOwnedCommitAcknowledgement,
  type RecoveryState,
} from './fix-application-recovery-support.js';
import { FixFoundationService } from '../../app/server/fix/foundation.js';
import {
  WorkflowService,
  capabilityDigest,
} from '../../app/server/fixed-income-workflow/service.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { applicationFixture } from './fix-application-fixture.js';
import { connection, owner } from './harness.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { FixApplicationService } from '../../app/server/fix/application.js';
import { DomainError } from '../../app/domain/errors.js';
for (const mode of [
  'BEFORE_PREPARE',
  'PREPARE_BEFORE_COMMIT',
  'PREPARE_AFTER_COMMIT',
  'APPLY_BEFORE_COMMIT',
  'APPLY_AFTER_COMMIT',
])
  void test(`SIGKILL ${mode}: original key/identity recover without another economic action`, async () => {
    const s = await applicationFixture(),
      admin = await connection('admin');
    let child: ReturnType<typeof spawn> | undefined;
    try {
      let work: string, financialKey: string, preparePayload: Record<string, string>;
      if (mode.startsWith('APPLY')) {
        const p = await s.prepare();
        work = p.work;
        financialKey = p.financialKey;
        preparePayload = {};
      } else {
        const p = await s.stage();
        work = randomUUID();
        financialKey = randomUUID();
        await s.fix('QUEUE', { order_id: s.order, message_id: p.message, work_id: work });
        preparePayload = {
          order_id: s.order,
          owner_id: s.owner,
          fence: s.fence,
          work_id: work,
          financial_key: financialKey,
        };
      }
      const key = randomUUID(),
        isApply = mode.startsWith('APPLY'),
        commit = mode.endsWith('AFTER_COMMIT');
      const applyPayload = { order_id: s.order, owner_id: s.owner, fence: s.fence, work_id: work };
      const beforeCrash = await recoveryState(admin, s.id);
      child = spawn(
        process.execPath,
        ['--import', 'tsx', 'tests/postgres/fix-application-crash-worker.ts'],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env },
      );
      const ready = once(child, 'message');
      child.send({
        mode: isApply ? 'APPLY' : 'PREPARE',
        args: isApply
          ? [s.id, s.proof, 1, JSON.stringify(applyPayload), key, s.actor]
          : [s.id, s.proof, 1, 'PREPARE', JSON.stringify(preparePayload), key, s.actor],
        commit,
        before: mode === 'BEFORE_PREPARE',
      });
      const [m] = (await ready) as [{ phase: string }];
      assert.equal(
        m.phase,
        mode === 'BEFORE_PREPARE' ? 'before' : commit ? 'committed' : 'uncommitted',
      );
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
      const afterCrash = await recoveryState(admin, s.id);
      if (!commit) assert.deepEqual(afterCrash, beforeCrash);
      else if (!isApply)
        for (const table of economicTables)
          assert.deepEqual(afterCrash[table], beforeCrash[table], table);
      if (!isApply) {
        const p = await s.fix('PREPARE', preparePayload, key);
        assert.equal(p.status, 201);
        assert.equal(p.replayed, commit);
        assert.equal((await s.apply(work)).status, 200);
      } else {
        const p = await s.apply(work, key);
        assert.equal(p.status, 200);
        assert.equal(p.replayed, commit);
      }
      const recoveredState = await recoveryState(admin, s.id);
      assert.equal(recoveredState['fi.commands']!.length, beforeCrash['fi.commands']!.length + 1);
      assert.equal(
        recoveredState['fi.audit_events']!.length,
        beforeCrash['fi.audit_events']!.length + 1,
      );
      assert.equal(
        recoveredState['fi.order_history']!.length,
        beforeCrash['fi.order_history']!.length + 1,
      );
      assert.deepEqual(recoveredState['fi.executions'], beforeCrash['fi.executions']);
      assert.deepEqual(recoveredState['fi.positions'], beforeCrash['fi.positions']);

      const receipt = assertFinancialEvidence(recoveredState, work, financialKey, 'ACK_ORDER');
      if (isApply && commit) assert.deepEqual(recoveredState, afterCrash);
      const originalReplay = await s.apply(
        work,
        receipt['idempotency_key'] as ReturnType<typeof randomUUID>,
      );
      assert.equal(originalReplay.status, 200);
      assert.equal(originalReplay.replayed, true);
      assert.deepEqual(originalReplay.body, receipt['response_body']);
      assert.deepEqual(await recoveryState(admin, s.id), recoveredState);
      assert.equal(
        (
          await s.app.query<{ n: number }>(
            'SELECT count(*)::int n FROM fi.fix_applications WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0]!.n,
        1,
      );
      assert.equal(
        (
          await s.app.query<{ financial_key: string }>(
            'SELECT financial_key FROM fi.fix_prepared WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0]!.financial_key,
        financialKey,
      );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit');
        child.kill('SIGKILL');
        await exit;
      }
      await admin.end();
      await s.close();
    }
  });
for (const after of [false, true])
  void test(`lost connection ${after ? 'after confirmed' : 'around'} financial COMMIT resolves authoritative original action`, async () => {
    const s = await applicationFixture(),
      cfg = await owner(),
      admin = await connection('admin');
    let pid = 0;
    const db = new WorkflowDatabase(
      cfg.appUrl!,
      after
        ? {
            afterCommit: async () => {
              await admin.query('SELECT pg_terminate_backend($1)', [pid]);
              throw new Error('Lost response.');
            },
          }
        : {
            beforeCommit: async () => {
              await admin.query('SELECT pg_terminate_backend($1)', [pid]);
            },
          },
    );
    try {
      const p = await s.prepare(),
        key = randomUUID(),
        input = { order_id: s.order, owner_id: s.owner, fence: s.fence, work_id: p.work },
        binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' };
      const beforeState = await recoveryState(admin, s.id);
      const client = await db.pool.connect();
      pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
      client.release();
      await assert.rejects(
        new FixApplicationService(db, true).apply(binding, s.actor, input, key, () => {}),
        (e: unknown) =>
          e instanceof DomainError && e.status === 503 && e.code === 'OUTCOME_UNKNOWN',
      );
      const faultState = await recoveryState(admin, s.id);
      if (!after) assert.deepEqual(faultState, beforeState);
      else assertOneFinancialEffect(beforeState, faultState, p.work, p.financialKey, 'ACK_ORDER');
      await db.close();
      const fresh = new WorkflowDatabase(cfg.appUrl!);
      try {
        const r = await new FixApplicationService(fresh, true).apply(
          binding,
          s.actor,
          input,
          key,
          () => {},
        );
        assert.equal(r.status, 200);
        assert.equal(r.replayed, after);
        const committed = await recoveryState(admin, s.id);
        if (after) assert.deepEqual(committed, faultState);
        else assertOneFinancialEffect(beforeState, committed, p.work, p.financialKey, 'ACK_ORDER');
        const replay = await new FixApplicationService(fresh, true).apply(
          binding,
          s.actor,
          input,
          key,
          () => {},
        );
        assert.equal(replay.status, 200);
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.body, r.body);
        assert.deepEqual(await recoveryState(admin, s.id), committed);
        console.log(
          'Connection-loss evidence:',
          JSON.stringify({
            afterConfirmedCommit: after,
            classification: 'OUTCOME_UNKNOWN',
            authoritativeCommittedBeforeRecovery: after,
            financialEffects: 1,
          }),
        );
      } finally {
        await fresh.close();
      }
      assert.equal(
        (
          await s.app.query<{ n: number }>(
            'SELECT count(*)::int n FROM fi.fix_applications WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0]!.n,
        1,
      );
    } finally {
      await db.close();
      await admin.end();
      await s.close();
    }
  });
void test('logout before COMMIT rolls financial effect, promotion, protocol receipt and capacity back to the exact prepared intent', async () => {
  const s = await applicationFixture(),
    cfg = await owner(),
    admin = await connection('admin');
  let valid = true;
  const db = new WorkflowDatabase(cfg.appUrl!, {
    beforeCommit: () => {
      valid = false;
    },
  });
  try {
    const p = await s.prepare(),
      key = randomUUID(),
      input = { order_id: s.order, owner_id: s.owner, fence: s.fence, work_id: p.work };
    const preparedState = await recoveryState(admin, s.id);
    await assert.rejects(
      new FixApplicationService(db, true).apply(
        { sandboxId: s.id, digest: s.proof, scope: 'trade', generation: '1' },
        s.actor,
        input,
        key,
        () => {
          if (!valid) throw new DomainError(401, 'UNAUTHORIZED', 'Session expired.');
        },
      ),
      (e: unknown) => e instanceof DomainError && e.status === 401,
    );
    assert.deepEqual(await recoveryState(admin, s.id), preparedState);
    assert.equal(
      (
        await s.app.query<{ status: string }>(
          'SELECT status FROM fi.order_states WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.status,
      'PENDING_ACK',
    );
    assert.equal(
      (
        await s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_consumptions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      0,
    );
    assert.equal((await s.apply(p.work, key)).status, 200);
    const committed = await recoveryState(admin, s.id);
    assertOneFinancialEffect(preparedState, committed, p.work, p.financialKey, 'ACK_ORDER');
    assert.equal((await s.apply(p.work, key)).replayed, true);
    assert.deepEqual(await recoveryState(admin, s.id), committed);
  } finally {
    await db.close();
    await admin.end();
    await s.close();
  }
});
void test('SIGKILL during execution insert rolls back every financial/protocol/key/capacity effect at a deterministic PostgreSQL barrier', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin');
  let child: ReturnType<typeof spawn> | undefined;
  const lock = 731032;
  try {
    await s.apply((await s.prepare()).work);
    const px = (
      await s.app.query<{ contract: Record<string, string> }>(
        'SELECT contract FROM fi.orders WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.contract['clean_price']!;
    const p = await s.prepare({
        '150': 'F',
        '39': '2',
        '14': '100.00',
        '151': '0.00',
        '32': '100.00',
        '31': px,
        '6': px,
      }),
      key = randomUUID();
    const preparedState = await recoveryState(admin, s.id);
    await admin.query(
      `CREATE FUNCTION public.tf_test_fix_barrier() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN PERFORM pg_advisory_xact_lock(${lock});RETURN NEW;END $body$`,
    );
    await admin.query(
      'CREATE TRIGGER tf_test_fix_barrier AFTER INSERT ON fi.executions FOR EACH ROW EXECUTE FUNCTION public.tf_test_fix_barrier()',
    );
    await admin.query('SELECT pg_advisory_lock($1)', [lock]);
    child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/postgres/fix-application-crash-worker.ts'],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env },
    );
    const ready = once(child, 'message');
    child.send({
      mode: 'APPLY',
      args: [
        s.id,
        s.proof,
        1,
        JSON.stringify({ order_id: s.order, owner_id: s.owner, fence: s.fence, work_id: p.work }),
        key,
        s.actor,
      ],
      commit: false,
      during: true,
    });
    const [m] = (await ready) as [{ phase: string; pid: number }];
    assert.equal(m.phase, 'applying');
    let blocked = false;
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      if (
        (await admin.query<{ b: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 b', [m.pid]))
          .rows[0]!.b
      ) {
        blocked = true;
        break;
      }
      await new Promise<void>((r) => setImmediate(r));
    }
    assert.equal(blocked, true);
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    await admin.query('SELECT pg_advisory_unlock($1)', [lock]);
    const end = performance.now() + 2000;
    while (performance.now() < end) {
      if (!(await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [m.pid])).rowCount)
        break;
      await new Promise<void>((r) => setImmediate(r));
    }
    assert.equal(
      (await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [m.pid])).rowCount,
      0,
    );
    assert.equal(
      (
        await s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.executions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      0,
    );
    assert.deepEqual(await recoveryState(admin, s.id), preparedState);
    await admin.query('DROP TRIGGER tf_test_fix_barrier ON fi.executions');
    await admin.query('DROP FUNCTION public.tf_test_fix_barrier()');
    assert.equal((await s.apply(p.work, key)).status, 200);
    const committed = await recoveryState(admin, s.id);
    assertOneFinancialEffect(preparedState, committed, p.work, p.financialKey, 'EXECUTE_ORDER');
    assert.equal((await s.apply(p.work, key)).replayed, true);
    assert.deepEqual(await recoveryState(admin, s.id), committed);
    const oracle = await recoveryOracle(admin, s.id);
    assert.equal(oracle.status, 0, oracle.stderr);
    assert.equal(oracleEvidence(oracle.stdout).executions, 1);
    assert.equal(oracleEvidence(oracle.stdout).frames, 3);
    assert.equal(
      (
        await s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.executions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      1,
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const e = once(child, 'exit');
      child.kill('SIGKILL');
      await e;
    }
    await admin.query('SELECT pg_advisory_unlock($1)', [lock]);
    await admin.query('DROP TRIGGER IF EXISTS tf_test_fix_barrier ON fi.executions');
    await admin.query('DROP FUNCTION IF EXISTS public.tf_test_fix_barrier()');
    await admin.end();
    await s.close();
  }
});

function objectBody(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const economicTables = [
  'fi.order_states',
  'fi.order_history',
  'fi.commands',
  'fi.audit_events',
  'fi.executions',
  'fi.positions',
  'fi.cancellation_requests',
  'fi.cancellation_outcomes',
  'financial_counters',
] as const;
const financialEvents: Record<string, string[]> = {
  ACK_ORDER: ['ORDER_ACKNOWLEDGED'],
  REJECT_ORDER: ['ORDER_REJECTED'],
  EXECUTE_ORDER: ['EXECUTION_RECORDED', 'ORDER_STATE_CHANGED', 'POSITION_UPDATED'],
  REQUEST_CANCEL: ['CANCEL_REQUESTED'],
  ACK_CANCEL: ['CANCEL_ACKNOWLEDGED'],
  REJECT_CANCEL: ['CANCEL_REJECTED'],
};
function assertFinancialEvidence(
  state: RecoveryState,
  work: string,
  financialKey: string,
  operation: string,
) {
  const applications = state['fi.fix_applications']!.filter((r) => r['work_id'] === work),
    consumptions = state['fi.fix_consumptions']!.filter((r) => r['work_id'] === work),
    commands = state['fi.commands']!.filter((r) => r['idempotency_key'] === financialKey),
    prepared = state['fi.fix_prepared']!.find((r) => r['work_id'] === work)!;
  assert.equal(applications.length, 1);
  assert.equal(consumptions.length, 1);
  assert.equal(commands.length, 1);
  assert.ok(prepared);
  const application = applications[0]!,
    financial = commands[0]!,
    payload = prepared['payload'] as Record<string, string>;
  assert.equal(prepared['financial_key'], financialKey);
  assert.equal(prepared['operation'], operation);
  assert.equal(application['financial_key'], financialKey);
  assert.equal(application['order_id'], prepared['order_id']);
  assert.equal(application['financial_command_id'], financial['id']);
  assert.equal(application['financial_command_seq'], financial['command_seq']);
  assert.equal(application['financial_request_hash'], financial['request_hash']);
  const request: Record<string, string> = {
    order_id: payload['order_id']!,
    expected_version: payload['expected_version']!,
  };
  if (operation === 'EXECUTE_ORDER')
    for (const f of ['execution_id', 'source_event_id', 'par_amount']) request[f] = payload[f]!;
  else if (['REQUEST_CANCEL', 'ACK_CANCEL', 'REJECT_CANCEL'].includes(operation))
    request['cancel_id'] = payload['cancel_id']!;
  assert.equal(
    financial['request_hash'],
    createHash('sha256')
      .update(
        JSON.stringify({
          version: 1,
          method: 'POST',
          operation,
          sandbox_id: prepared['sandbox_id'],
          payload: request,
        }),
      )
      .digest('hex'),
  );
  assert.equal(
    prepared['request_hash'],
    createHash('sha256').update(String(prepared['_payload_text'])).digest('hex'),
  );
  assert.equal(financial['operation'], operation);
  assert.equal(financial['result_kind'], 'APPLIED');
  assert.equal(
    financial['http_status'],
    ['EXECUTE_ORDER', 'REQUEST_CANCEL'].includes(operation) ? 201 : 200,
  );
  const audits = state['fi.audit_events']!.filter((r) => r['command_id'] === financial['id']);
  assert.deepEqual(
    audits.map((r) => r['event_type']).sort(),
    [...financialEvents[operation]!].sort(),
  );
  for (const audit of audits) assert.equal(audit['command_seq'], financial['command_seq']);
  const history = state['fi.order_history']!.filter((r) => r['command_id'] === financial['id']);
  assert.equal(history.length, 1);
  assert.equal(history[0]!['operation'], operation);
  assert.equal(Number(history[0]!['version']), Number(payload['expected_version']) + 1);
  assert.equal(consumptions[0]!['commands'], 1);
  assert.equal(consumptions[0]!['events'], audits.length);
  assert.equal(consumptions[0]!['order_id'], prepared['order_id']);
  const workRow = state['fi.fix_work']!.find((r) => r['id'] === work)!;
  assert.ok(workRow);
  assert.equal(workRow['message_id'], application['message_id']);
  assert.ok(state['fi.fix_messages']!.some((r) => r['id'] === workRow['message_id']));
  const receipt = state['fi.fix_commands']!.find(
    (r) => r['command_seq'] === application['protocol_command_seq'],
  )!;
  assert.ok(receipt);
  assert.equal(receipt['operation'], 'APPLY');
  assert.equal(receipt['http_status'], 200);
  assert.deepEqual(receipt['response_body'], application['result']);
  const result = application['result'] as Record<string, unknown>,
    inner = result['financial_result'] as Record<string, unknown>;
  assert.equal(result['financial_applied'], true);
  assert.equal(result['delivery_verified'], false);
  assert.equal(inner['status'], financial['http_status']);
  assert.deepEqual(inner['body'], financial['response_body']);
  const event = state['fi.fix_events']!.filter((r) => r['command_seq'] === receipt['command_seq']);
  assert.equal(event.length, 1);
  assert.equal(event[0]!['event_type'], 'APPLY');
  assert.deepEqual(event[0]!['payload'], {
    financial_applied: true,
    record: receipt['response_body'],
  });
  assert.equal(
    state['fi_control.command_keys']!.find((r) => r['idempotency_key'] === financialKey)!['domain'],
    'FINANCIAL',
  );
  assert.equal(
    state['fi_control.command_keys']!.find(
      (r) => r['idempotency_key'] === receipt['idempotency_key'],
    )!['domain'],
    'FIX',
  );
  assert.equal(state['fi_control.fix_apply_context']!.length, 0);
  const counters = state['financial_counters']![0]!;
  assert.equal(counters['command_count'], state['fi.commands']!.length);
  assert.equal(counters['event_count'], state['fi.audit_events']!.length);
  return receipt;
}
function assertOneFinancialEffect(
  before: RecoveryState,
  after: RecoveryState,
  work: string,
  key: string,
  operation: string,
) {
  const receipt = assertFinancialEvidence(after, work, key, operation);
  assert.equal(after['fi.commands']!.length, before['fi.commands']!.length + 1);
  assert.equal(
    after['fi.audit_events']!.length,
    before['fi.audit_events']!.length + financialEvents[operation]!.length,
  );
  assert.equal(after['fi.order_history']!.length, before['fi.order_history']!.length + 1);
  assert.equal(after['fi.fix_applications']!.length, before['fi.fix_applications']!.length + 1);
  assert.equal(after['fi.fix_consumptions']!.length, before['fi.fix_consumptions']!.length + 1);
  assert.equal(after['fi.fix_commands']!.length, before['fi.fix_commands']!.length + 1);
  assert.equal(after['fi.fix_events']!.length, before['fi.fix_events']!.length + 1);
  assert.deepEqual(after['fi.fix_prepared'], before['fi.fix_prepared']);
  assert.deepEqual(after['fi_control.fix_reservations'], before['fi_control.fix_reservations']);
  if (operation !== 'EXECUTE_ORDER') {
    assert.deepEqual(after['fi.executions'], before['fi.executions']);
    assert.deepEqual(after['fi.positions'], before['fi.positions']);
  } else {
    assert.equal(after['fi.executions']!.length, before['fi.executions']!.length + 1);
    const p = after['fi.fix_prepared']!.find((r) => r['work_id'] === work)!['payload'] as Record<
      string,
      string
    >;
    const execution = after['fi.executions']!.filter((r) => r['id'] === p['execution_id']);
    assert.equal(execution.length, 1);
    assert.equal(execution[0]!['source_event_id'], p['source_event_id']);
    assert.equal(Number(execution[0]!['par_amount']), Number(p['par_amount']));
  }

  const lifecycle = after['fi.order_states']![0]!;
  if (operation === 'ACK_ORDER') assert.equal(lifecycle['status'], 'NEW');
  if (operation === 'REJECT_ORDER') {
    assert.equal(lifecycle['status'], 'REJECTED');
    assert.equal(Number(lifecycle['remaining_par']), 0);
  }
  const prepared = after['fi.fix_prepared']!.find((r) => r['work_id'] === work)!;
  const payload = prepared['payload'] as Record<string, string>;
  if (operation === 'REQUEST_CANCEL') {
    assert.equal(lifecycle['pending_cancel_id'], payload['cancel_id']);
    assert.equal(
      after['fi.cancellation_requests']!.length,
      before['fi.cancellation_requests']!.length + 1,
    );
    assert.equal(
      after['fi.cancellation_requests']!.filter((r) => r['id'] === payload['cancel_id']).length,
      1,
    );
  }
  if (operation === 'ACK_CANCEL' || operation === 'REJECT_CANCEL') {
    assert.equal(lifecycle['pending_cancel_id'], null);
    const outcome = after['fi.cancellation_outcomes']!.filter(
      (r) => r['cancel_id'] === payload['cancel_id'],
    );
    assert.equal(outcome.length, 1);
    assert.equal(outcome[0]!['outcome'], operation === 'ACK_CANCEL' ? 'ACKNOWLEDGED' : 'REJECTED');
    assert.equal(
      outcome[0]!['reason'],
      operation === 'ACK_CANCEL' ? 'CANCELED_REMAINDER' : 'SIMULATED_REJECTION',
    );
    assert.equal(
      after['fi.cancellation_outcomes']!.length,
      before['fi.cancellation_outcomes']!.length + 1,
    );
  }
  return receipt;
}
async function protocolRequestHash(
  db: Awaited<ReturnType<typeof connection>>,
  id: string,
  input: Record<string, string>,
) {
  return (
    await db.query<{ hash: string }>(
      "SELECT encode(sha256(convert_to(jsonb_build_object('version',1,'sandbox',$1::uuid,'operation','APPLY','payload',jsonb_build_object('order_id',$2::uuid,'owner_id',$3::uuid,'fence',$4::text,'work_id',$5::uuid))::text,'UTF8')),'hex') hash",
      [id, input['order_id'], input['owner_id'], input['fence'], input['work_id']],
    )
  ).rows[0]!.hash;
}
async function preparedExecution(s: Awaited<ReturnType<typeof applicationFixture>>) {
  assert.equal((await s.apply((await s.prepare()).work)).status, 200);
  const c = (
    await s.app.query<{ contract: Record<string, string> }>(
      'SELECT contract FROM fi.orders WHERE sandbox_id=$1',
      [s.id],
    )
  ).rows[0]!.contract;
  return s.prepare({
    '150': 'F',
    '39': '2',
    '14': '100.00',
    '151': '0.00',
    '32': '100.00',
    '31': c['clean_price']!,
    '6': c['clean_price']!,
  });
}

for (const operation of [
  'ACK_ORDER',
  'REJECT_ORDER',
  'EXECUTE_ORDER',
  'REQUEST_CANCEL',
  'ACK_CANCEL',
  'REJECT_CANCEL',
  'PROTOCOL_ONLY',
] as const)
  void test(
    'committed ' +
      operation +
      ' retains exact original-key replay after rotation and distinguishes current-owner recovery',
    async () => {
      const s = await applicationFixture('100.00', operation === 'EXECUTE_ORDER' ? 'SELL' : 'BUY'),
        admin = await connection('admin'),
        cfg = await owner(),
        db = new WorkflowDatabase(cfg.appUrl!),
        service = new FixApplicationService(db, true),
        foundation = new FixFoundationService(db, true);
      try {
        const changes: Record<string, string> = {};
        const cancel = randomUUID();
        if (!['ACK_ORDER', 'REJECT_ORDER'].includes(operation))
          assert.equal((await s.apply((await s.prepare()).work)).status, 200);
        if (['ACK_CANCEL', 'REJECT_CANCEL', 'PROTOCOL_ONLY'].includes(operation))
          assert.equal(
            (
              await s.apply(
                (
                  await s.prepare({
                    '35': 'F',
                    '49': 'TRADEFLOW',
                    '56': 'ATLAS',
                    '11': cancel,
                    '41': s.order,
                  })
                ).work,
              )
            ).status,
            200,
          );
        if (operation === 'REJECT_ORDER')
          Object.assign(changes, {
            '150': '8',
            '39': '8',
            '151': '0.00',
            '103': '99',
            '58': 'SYNTHETIC_REJECTION',
          });
        if (operation === 'EXECUTE_ORDER') {
          const c = (
            await s.app.query<{ contract: Record<string, string> }>(
              'SELECT contract FROM fi.orders WHERE sandbox_id=$1',
              [s.id],
            )
          ).rows[0]!.contract;
          Object.assign(changes, {
            '150': 'F',
            '39': '2',
            '14': '100.00',
            '151': '0.00',
            '32': '100.00',
            '31': c['clean_price']!,
            '6': c['clean_price']!,
          });
        }
        if (operation === 'REQUEST_CANCEL')
          Object.assign(changes, {
            '35': 'F',
            '49': 'TRADEFLOW',
            '56': 'ATLAS',
            '11': cancel,
            '41': s.order,
          });
        if (operation === 'ACK_CANCEL')
          Object.assign(changes, {
            '150': '4',
            '39': '4',
            '151': '0.00',
            '11': cancel,
            '41': s.order,
          });
        if (operation === 'REJECT_CANCEL')
          Object.assign(changes, {
            '35': '9',
            '39': '0',
            '434': '1',
            '102': '99',
            '11': cancel,
            '41': s.order,
          });
        if (operation === 'PROTOCOL_ONLY')
          Object.assign(changes, { '150': '6', '39': '6', '11': cancel, '41': s.order });
        const p = await s.prepare(changes),
          key = randomUUID(),
          binding = { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' as const },
          input = { order_id: s.order, owner_id: s.owner, fence: s.fence, work_id: p.work },
          before = await recoveryState(admin, s.id);
        const applied = await service.apply(binding, s.actor, input, key, () => {});
        assert.equal(applied.status, 200);
        assert.equal(applied.replayed, false);
        const committed = await recoveryState(admin, s.id);
        const receipt = committed['fi.fix_commands']!.find((r) => r['idempotency_key'] === key)!;
        assert.ok(receipt);
        assert.equal(receipt['request_hash'], await protocolRequestHash(admin, s.id, input));

        assert.equal(objectBody(applied.body)['financial_applied'], operation !== 'PROTOCOL_ONLY');
        assert.equal(objectBody(applied.body)['delivery_verified'], false);
        assert.equal(receipt['operation'], 'APPLY');
        assert.equal(receipt['http_status'], 200);
        assert.deepEqual(receipt['response_body'], applied.body);
        if (operation === 'PROTOCOL_ONLY') {
          const observed = committed['fi.fix_protocol_observations']!.find(
            (r) => r['work_id'] === p.work,
          )!;
          const lifecycle = before['fi.order_states']![0]!;
          assert.ok(observed);
          assert.equal(observed['order_id'], s.order);
          assert.equal(observed['cancel_id'], cancel);
          assert.equal(Number(observed['financial_version']), Number(lifecycle['version']));
          assert.equal(Number(observed['filled_par']), Number(lifecycle['filled_par']));
          assert.equal(Number(observed['remaining_par']), Number(lifecycle['remaining_par']));
          assert.equal(observed['protocol_command_seq'], receipt['command_seq']);
          const event = committed['fi.fix_events']!.find(
            (r) => r['command_seq'] === receipt['command_seq'],
          )!;
          assert.equal(event['event_type'], 'APPLY');
          assert.deepEqual(event['payload'], { financial_applied: false, record: applied.body });
          for (const table of economicTables)
            assert.deepEqual(committed[table], before[table], table);
          assert.equal(
            committed['fi.fix_applications']!.length,
            before['fi.fix_applications']!.length,
          );
          assert.equal(
            committed['fi.fix_consumptions']!.length,
            before['fi.fix_consumptions']!.length,
          );
          assert.equal(
            committed['fi.fix_protocol_observations']!.filter((r) => r['work_id'] === p.work)
              .length,
            1,
          );
          assert.equal(
            committed['fi.fix_outcomes']!.filter(
              (r) => r['work_id'] === p.work && r['outcome'] === 'METADATA_ONLY',
            ).length,
            1,
          );
          assert.equal(
            committed['fi_control.command_keys']!.find(
              (r) => r['idempotency_key'] === p.financialKey,
            )!['domain'],
            'FIX_PREPARED',
          );
          assert.equal(objectBody(applied.body)['validated_pending_cancel'], true);
        } else assertOneFinancialEffect(before, committed, p.work, p.financialKey, operation);
        const trade = randomBytes(32).toString('base64url'),
          read = randomBytes(32).toString('base64url'),
          rotationKey = randomUUID();
        const rotated = await new WorkflowService(db).rotate(
          binding,
          { expected_generation: '1', read_capability: read, trade_capability: trade },
          rotationKey,
          s.actor,
          () => {},
        );
        assert.equal(rotated.status, 200);
        const current = {
          ...binding,
          digest: capabilityDigest(s.id, 'trade', trade),
          generation: '2',
        };
        const recoveredCapability = await new WorkflowService(db).recover(
          s.id,
          'trade',
          trade,
          () => {},
        );
        assert.equal(recoveredCapability.result.status, 200);
        assert.deepEqual(recoveredCapability.binding, current);
        const afterRotation = await recoveryState(admin, s.id);
        for (const table of recoveryTables)
          if (
            !['fi.commands', 'fi.audit_events', 'fi_control.command_keys', 'fi.fix_lanes'].includes(
              table,
            )
          )
            assert.deepEqual(afterRotation[table], committed[table], table);
        const rotationReceipt = afterRotation['fi.commands']!.filter(
          (r) => r['idempotency_key'] === rotationKey,
        );
        assert.equal(rotationReceipt.length, 1);
        assert.equal(rotationReceipt[0]!['operation'], 'ROTATE_CAPABILITIES');
        assert.deepEqual(
          afterRotation['fi.commands']!.filter((r) => r['idempotency_key'] !== rotationKey),
          committed['fi.commands'],
        );
        assert.deepEqual(
          afterRotation['fi.audit_events']!.filter(
            (r) => r['command_id'] !== rotationReceipt[0]!['id'],
          ),
          committed['fi.audit_events'],
        );
        assert.equal(
          afterRotation['fi.audit_events']!.length,
          committed['fi.audit_events']!.length + 1,
        );
        assert.deepEqual(
          afterRotation['fi_control.command_keys']!.filter(
            (r) => r['idempotency_key'] !== rotationKey,
          ),
          committed['fi_control.command_keys'],
        );
        for (const field of ['command_count', 'event_count', 'commit_seq', 'generation'])
          assert.equal(
            Number(afterRotation['financial_counters']![0]![field]),
            Number(committed['financial_counters']![0]![field]) + 1,
          );
        for (const stale of [
          binding,
          { ...binding, generation: '2' },
          { ...current, generation: '1' },
        ]) {
          const denied = await service.apply(stale, s.actor, input, key, () => {});
          assert.equal(denied.status, 404);
          assert.equal(
            (objectBody(denied.body)['error'] as { code: string }).code,
            'SANDBOX_NOT_FOUND',
          );
        }
        const replay = await service.apply(current, s.actor, input, key, () => {});
        assert.equal(replay.status, 200);
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.body, applied.body);
        for (const changedInput of [
          { ...input, owner_id: randomUUID() },
          { ...input, fence: String(Number(input.fence) + 1) },
          { ...input, work_id: randomUUID() },
        ]) {
          const changed = await service.apply(current, s.actor, changedInput, key, () => {});
          assert.equal(changed.status, 409);
          assert.equal(
            (objectBody(changed.body)['error'] as { code: string }).code,
            'IDEMPOTENCY_KEY_REUSED',
          );
        }
        assert.deepEqual(await recoveryState(admin, s.id), afterRotation);
        const nextOwner = randomUUID();
        const claim = await foundation.command(
          current,
          s.actor,
          'CLAIM',
          { order_id: s.order, owner_id: nextOwner },
          randomUUID(),
          () => {},
        );
        assert.equal(claim.status, 200);
        const fence = String(objectBody(claim.body)['fence']);
        assert.ok(Number(fence) > Number(input.fence));
        const afterClaim = await recoveryState(admin, s.id),
          freshKey = randomUUID();
        const recovered = await service.apply(
          current,
          s.actor,
          { ...input, owner_id: nextOwner, fence },
          freshKey,
          () => {},
        );
        if (operation === 'PROTOCOL_ONLY') {
          assert.equal(recovered.status, 409);
          assert.equal(
            (objectBody(recovered.body)['error'] as { code: string }).code,
            'FIX_UNRESOLVED_HEAD',
          );
        } else {
          assert.equal(recovered.status, 200);
          assert.equal(recovered.replayed, true);
          assert.deepEqual(recovered.body, applied.body);
        }
        assert.deepEqual(await recoveryState(admin, s.id), afterClaim);
        assert.equal(
          afterClaim['fi.fix_commands']!.some((r) => r['idempotency_key'] === freshKey),
          false,
        );
        assert.equal(
          afterClaim['fi_control.command_keys']!.some((r) => r['idempotency_key'] === freshKey),
          false,
        );
        assert.deepEqual(afterClaim['fi.fix_prepared'], before['fi.fix_prepared']);
        if (operation === 'EXECUTE_ORDER') {
          const oracle = await recoveryOracle(admin, s.id);
          assert.equal(oracle.status, 0, oracle.stderr);
          assert.equal(oracleEvidence(oracle.stdout).executions, 1);
          assert.equal(oracleEvidence(oracle.stdout).frames, 3);
          assert.equal(Number(afterClaim['fi.positions']![0]!['signed_par']), -100);
        }
        console.log(
          'Recovery rotation evidence:',
          JSON.stringify({
            operation,
            work: p.work,
            financialKey: p.financialKey,
            originalKey: key,
            generation: '1->2',
            preparedFence: p.prepared['fence'] ?? input.fence,
            currentFence: fence,
            exactReplay: true,
            economicDuplicate: false,
            freshKeyStored: false,
            financialApplied: operation !== 'PROTOCOL_ONLY',
          }),
        );
      } finally {
        await db.close();
        await admin.end();
        await s.close();
      }
    },
  );

void test('pre-dispatch failure through WorkflowDatabase restores the complete prepared execution graph before original-key recovery', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin'),
    cfg = await owner();
  let commits = 0;
  const failed = new WorkflowDatabase(cfg.appUrl!, {
    beforeCommit: () => {
      throw new Error('Controlled before COMMIT dispatch.');
    },
  });
  failed.pool.on('connect', (client) => {
    client.query = new Proxy(client.query.bind(client), {
      apply(target, receiver, args) {
        if (args[0] === 'COMMIT') commits++;
        return Reflect.apply(target, receiver, args) as unknown;
      },
    });
  });
  const fresh = new WorkflowDatabase(cfg.appUrl!);
  try {
    const p = await preparedExecution(s),
      key = randomUUID(),
      binding = { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' as const },
      input = { order_id: s.order, owner_id: s.owner, fence: s.fence, work_id: p.work },
      before = await recoveryState(admin, s.id);
    await assert.rejects(
      new FixApplicationService(failed, true).apply(binding, s.actor, input, key, () => {}),
      (e: unknown) =>
        e instanceof DomainError && e.status === 503 && e.code === 'DATABASE_UNAVAILABLE',
    );
    assert.equal(commits, 0);
    assert.deepEqual(await recoveryState(admin, s.id), before);
    const service = new FixApplicationService(fresh, true),
      applied = await service.apply(binding, s.actor, input, key, () => {});
    assert.equal(applied.status, 200);
    assert.equal(applied.replayed, false);
    const committed = await recoveryState(admin, s.id);
    assertOneFinancialEffect(before, committed, p.work, p.financialKey, 'EXECUTE_ORDER');
    assert.equal((await service.apply(binding, s.actor, input, key, () => {})).replayed, true);
    assert.deepEqual(await recoveryState(admin, s.id), committed);
    const oracle = await recoveryOracle(admin, s.id);
    assert.equal(oracle.status, 0, oracle.stderr);
    assert.equal(oracleEvidence(oracle.stdout).executions, 1);
    console.log(
      'Recovery boundary evidence:',
      JSON.stringify({
        boundary: 'before dispatch',
        classification: 'DATABASE_UNAVAILABLE',
        commitQueries: commits,
        authoritativeRollback: true,
        originalKey: key,
        financialEffects: 1,
      }),
    );
  } finally {
    await failed.close();
    await fresh.close();
    await admin.end();
    await s.close();
  }
});
void test('real deferred application rejection at COMMIT remains OUTCOME_UNKNOWN until authoritative rollback and current-owner original-key recovery', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin'),
    cfg = await owner();
  let active: pg.PoolClient | undefined,
    commits = 0,
    sqlstate: string | undefined,
    expired = false;
  const failed = new WorkflowDatabase(cfg.appUrl!, {
    beforeCommit: async () => {
      assert.ok(active);
      const role = (
        await active.query<{ role: string; visible: number }>(
          'SELECT current_user AS role,(SELECT count(*)::int FROM fi.fix_applications WHERE sandbox_id=$1) AS visible',
          [s.id],
        )
      ).rows[0]!;
      assert.equal(role.role, 'tf_app');
      assert.equal(
        role.visible,
        2,
        'ACK plus uncommitted execution must be visible inside the real transaction.',
      );
      const deadline = performance.now() + 3000;
      while (performance.now() < deadline) {
        expired = (
          await active.query<{ expired: boolean }>(
            'SELECT lease_expires_at<=clock_timestamp() AS expired FROM fi.fix_lanes WHERE sandbox_id=$1 AND order_id=$2',
            [s.id, s.order],
          )
        ).rows[0]!.expired;
        if (expired) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(
        expired,
        true,
        'The real lease-expiry condition must be reached within the unchanged transaction budget.',
      );
    },
  });
  failed.pool.on('acquire', (client) => {
    active = client;
  });
  failed.pool.on('connect', (client) => {
    client.query = new Proxy(client.query.bind(client), {
      apply(target, receiver, args) {
        const result: unknown = Reflect.apply(target, receiver, args);
        if (args[0] === 'COMMIT') {
          commits++;
          return (result as Promise<unknown>).catch((error: unknown) => {
            sqlstate = (error as { code?: string }).code;
            throw error;
          });
        }
        return result;
      },
    });
  });
  const fresh = new WorkflowDatabase(cfg.appUrl!);
  try {
    const p = await preparedExecution(s),
      key = randomUUID(),
      binding = { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' as const },
      input = { order_id: s.order, owner_id: s.owner, fence: s.fence, work_id: p.work };
    // Existing owned timestamp instrumentation; no trigger, grant or SQL body change.
    await admin.query(
      "UPDATE fi.fix_lanes SET lease_expires_at=clock_timestamp()+interval '2 seconds' WHERE sandbox_id=$1 AND order_id=$2",
      [s.id, s.order],
    );
    const before = await recoveryState(admin, s.id);
    await assert.rejects(
      new FixApplicationService(failed, true).apply(binding, s.actor, input, key, () => {}),
      (e: unknown) => e instanceof DomainError && e.status === 503 && e.code === 'OUTCOME_UNKNOWN',
    );
    assert.equal(commits, 1);
    assert.equal(sqlstate, '23514');
    assert.equal(expired, true);
    assert.deepEqual(
      await recoveryState(admin, s.id),
      before,
      'Separate authoritative inspection, not the exception, establishes rollback.',
    );
    const service = new FixApplicationService(fresh, true);
    const stale = await service.apply(binding, s.actor, input, key, () => {});
    assert.equal(stale.status, 409);
    assert.equal((objectBody(stale.body)['error'] as { code: string }).code, 'FIX_STALE_FENCE');
    assert.deepEqual(await recoveryState(admin, s.id), before);
    const nextOwner = randomUUID(),
      claim = await new FixFoundationService(fresh, true).command(
        binding,
        s.actor,
        'CLAIM',
        { order_id: s.order, owner_id: nextOwner },
        randomUUID(),
        () => {},
      );
    assert.equal(claim.status, 200);
    const currentInput = {
      ...input,
      owner_id: nextOwner,
      fence: String(objectBody(claim.body)['fence']),
    };
    assert.ok(Number(currentInput.fence) > Number(input.fence));
    const claimed = await recoveryState(admin, s.id);
    const result = await service.apply(binding, s.actor, currentInput, key, () => {});
    assert.equal(result.status, 200);
    assert.equal(result.replayed, false);
    const committed = await recoveryState(admin, s.id);
    const receipt = assertOneFinancialEffect(
      claimed,
      committed,
      p.work,
      p.financialKey,
      'EXECUTE_ORDER',
    );
    assert.equal(receipt['idempotency_key'], key);
    assert.equal(receipt['request_hash'], await protocolRequestHash(admin, s.id, currentInput));
    assert.deepEqual(committed['fi.fix_prepared'], before['fi.fix_prepared']);
    assert.equal(
      (await service.apply(binding, s.actor, currentInput, key, () => {})).replayed,
      true,
    );
    assert.deepEqual(await recoveryState(admin, s.id), committed);
    const oracle = await recoveryOracle(admin, s.id);
    assert.equal(oracle.status, 0, oracle.stderr);
    assert.equal(oracleEvidence(oracle.stdout).executions, 1);
    console.log(
      'Recovery boundary evidence:',
      JSON.stringify({
        boundary: 'real deferred COMMIT',
        role: 'tf_app',
        sqlstate,
        classification: 'OUTCOME_UNKNOWN',
        commitQueries: commits,
        authoritativeRollback: true,
        originalKey: key,
        financialEffects: 1,
      }),
    );
  } finally {
    await failed.close();
    await fresh.close();
    await admin.end();
    await s.close();
  }
});
void test('actual PostgreSQL COMMIT acknowledgement withheld from the client resolves committed execution by its original key without another ledger effect', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin'),
    cfg = await owner();
  let fault: Awaited<ReturnType<typeof dropOwnedCommitAcknowledgement>> | undefined,
    failed: WorkflowDatabase | undefined;
  const fresh = new WorkflowDatabase(cfg.appUrl!);
  try {
    const p = await preparedExecution(s),
      key = randomUUID(),
      binding = { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' as const },
      input = { order_id: s.order, owner_id: s.owner, fence: s.fence, work_id: p.work },
      before = await recoveryState(admin, s.id);
    fault = await dropOwnedCommitAcknowledgement();
    failed = new WorkflowDatabase(fault.appUrl);
    await assert.rejects(
      new FixApplicationService(failed, true).apply(binding, s.actor, input, key, () => {}),
      (e: unknown) => e instanceof DomainError && e.status === 503 && e.code === 'OUTCOME_UNKNOWN',
    );
    const transport = await fault.observation;
    assert.deepEqual(transport, {
      reason: 'COMMIT_ACK_WITHHELD',
      connections: 1,
      commitQueries: 1,
      commandCompleteSuppressed: true,
      readyForQuerySuppressed: true,
    });
    const committed = await recoveryState(admin, s.id);
    assertOneFinancialEffect(before, committed, p.work, p.financialKey, 'EXECUTE_ORDER');
    const recovered = await new FixApplicationService(fresh, true).apply(
      binding,
      s.actor,
      input,
      key,
      () => {},
    );
    assert.equal(recovered.status, 200);
    assert.equal(recovered.replayed, true);
    assert.deepEqual(
      recovered.body,
      committed['fi.fix_applications']!.find((r) => r['work_id'] === p.work)!['result'],
    );
    assert.deepEqual(await recoveryState(admin, s.id), committed);
    const oracle = await recoveryOracle(admin, s.id);
    assert.equal(oracle.status, 0, oracle.stderr);
    assert.equal(oracleEvidence(oracle.stdout).executions, 1);
    assert.equal(oracleEvidence(oracle.stdout).frames, 3);
    console.log(
      'Recovery boundary evidence:',
      JSON.stringify({
        boundary: 'actual PostgreSQL acknowledgement loss',
        transport,
        classification: 'OUTCOME_UNKNOWN',
        authoritativelyCommitted: true,
        originalKey: key,
        financialEffects: 1,
        oracle: oracleEvidence(oracle.stdout),
      }),
    );
  } finally {
    await fault?.close();
    await failed?.close();
    await fresh.close();
    await admin.end();
    await s.close();
  }
});
