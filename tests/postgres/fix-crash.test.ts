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
