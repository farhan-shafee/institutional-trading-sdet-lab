import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
    const s = await applicationFixture();
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
      const client = await db.pool.connect();
      pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
      client.release();
      await assert.rejects(
        new FixApplicationService(db, true).apply(binding, s.actor, input, key, () => {}),
        (e: unknown) => e instanceof DomainError && e.status === 503,
      );
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
    cfg = await owner();
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
  } finally {
    await db.close();
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
    await admin.query('DROP TRIGGER tf_test_fix_barrier ON fi.executions');
    await admin.query('DROP FUNCTION public.tf_test_fix_barrier()');
    assert.equal((await s.apply(p.work, key)).status, 200);
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
