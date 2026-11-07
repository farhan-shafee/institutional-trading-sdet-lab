/** Actual controller SIGKILL at commit/callback barriers; no fabricated engine event. */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { savePrivate } from '../../scripts/private-state.js';
import { readOwner } from '../../scripts/workflow-database.js';
import { LiveWorkflowDatabase } from '../../app/persistence/postgres/live-workflow.js';
import { LiveFixApplicationService } from '../../app/server/fix/live-application.js';
import { LiveJournal } from '../../app/server/fix/live-journal.js';
import { LiveVerificationDatabase } from '../../app/server/fix/live-verification-database.js';
import { verifyLiveApplication } from '../../app/server/fix/live-reconciliation.js';
import { recoverLiveRequest } from '../../app/server/fix/live-recovery.js';
import { DomainError } from '../../app/domain/errors.js';
import { fixture, report } from '../postgres/fix-fixture.js';
import { startLiveTestDatabase, removeLiveRuntime } from './runtime-fixture.js';

let database: Awaited<ReturnType<typeof startLiveTestDatabase>> | undefined;
before(async () => {
  database = await startLiveTestDatabase();
});
after(async () => {
  await database?.close();
});
const keyOf = z
  .object({ kind: z.literal('CHECKPOINT'), point: z.string(), key: z.uuid() })
  .strict();

for (const point of [
  'observe-before',
  'observe-after',
  'callback-before-retain',
  'accept-after',
  'apply-before',
  'apply-after',
] as const)
  void test(`actual SIGKILL at ${point} preserves original fill intent and reports its real outcome`, async () => {
    assert.ok(database);
    const s = await fixture(),
      cfg = await readOwner(database.owned.path),
      db = new LiveWorkflowDatabase(cfg.appUrl!),
      reader = new LiveVerificationDatabase(cfg.reconcilerUrl!);
    const service = new LiveFixApplicationService(db, true),
      binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' };
    const identity = {
      run_id: randomUUID(),
      session_id: randomUUID(),
      store_id: randomUUID(),
      connection_id: randomUUID(),
      runtime_hash: (process.env['TF_FIX_LIVE_IMAGE'] ?? '').slice(7),
    };
    const temporary = await mkdtemp(join(tmpdir(), 'tradeflow-live-crash-')),
      directory = join(process.cwd(), '.local', 'fix-live', identity.run_id);
    const evidence = join(
      process.env['TF_LIVE_EVIDENCE_DIR'] ??
        join(process.cwd(), '.local', 'fix-live-crash-evidence'),
      identity.run_id,
    );
    let child: ReturnType<typeof spawn> | undefined, journal: LiveJournal | undefined;
    async function counters() {
      return (
        await s.app.query<{
          applications: number;
          consumptions: number;
          events: number;
          executions: number;
          observations: number;
          callbacks: number;
          filled_par: string;
          executed_cents: string;
        }>(
          `SELECT
 (SELECT count(*)::int FROM fi.fix_applications WHERE sandbox_id=$1) applications,
 (SELECT count(*)::int FROM fi.fix_consumptions WHERE sandbox_id=$1) consumptions,
 (SELECT COALESCE(sum(events),0)::int FROM fi.fix_consumptions WHERE sandbox_id=$1) events,
 (SELECT count(*)::int FROM fi.executions WHERE sandbox_id=$1) executions,
 (SELECT count(*)::int FROM fi.fix_live_observations WHERE sandbox_id=$1) observations,
 (SELECT count(*)::int FROM fi.fix_live_callbacks WHERE sandbox_id=$1) callbacks,
 filled_par::text,executed_cents::text FROM fi.order_states WHERE sandbox_id=$1 AND order_id=$2`,
          [s.id, s.order],
        )
      ).rows[0]!;
    }
    try {
      const context = join(temporary, 'context.json');
      await savePrivate(context, {
        owner_file: database.owned.path,
        sandbox_id: s.id,
        proof: s.proof,
        actor: s.actor,
        order: s.order,
        channel: s.channel,
        lane_owner: randomUUID(),
        point,
        fields: await report(s),
        runtime: identity,
      });
      child = spawn(
        process.execPath,
        ['--import', 'tsx', resolve('tests/fix-live/crash-worker.ts'), context],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      );
      const worker = child;
      let output = 0,
        diagnostic = '';
      for (const stream of [worker.stdout, worker.stderr])
        stream?.on('data', (chunk: Buffer) => {
          output += chunk.length;
          diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4000);
          if (output > 65536) worker.kill('SIGKILL');
        });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (yes, no) => {
          worker.once('error', no);
          worker.once('exit', (code, signal) => yes({ code, signal }));
        },
      );
      void exited.catch(() => undefined);
      const checkpoint = await new Promise<z.infer<typeof keyOf>>((yes, no) => {
        const timer = setTimeout(() => {
          worker.kill('SIGKILL');
          no(new Error('The owned crash checkpoint was not reached.'));
        }, 15000);
        worker.once('message', (message) => {
          clearTimeout(timer);
          try {
            const value = keyOf.parse(message);
            assert.equal(value.point, point);
            worker.kill('SIGKILL');
            yes(value);
          } catch (error) {
            no(
              error instanceof Error
                ? error
                : new Error('Owned checkpoint payload failed validation.', { cause: error }),
            );
          }
        });
        void exited.then(() => {
          clearTimeout(timer);
          no(new Error('Owned worker exited before its crash checkpoint. ' + diagnostic));
        }, no);
      });
      const exit = await exited;
      assert.equal(exit.signal, 'SIGKILL');
      assert.ok(worker.pid);
      await removeLiveRuntime(identity.run_id);
      journal = await LiveJournal.open(
        directory,
        {
          run_id: identity.run_id,
          session_id: identity.session_id,
          store_id: identity.store_id,
          runtime_hash: identity.runtime_hash,
        },
        { readOnly: true },
      );
      const before = await counters();
      const afterCommit = point === 'apply-after';
      assert.equal(before.executions, afterCommit ? 1 : 0);
      assert.equal(before.consumptions, afterCommit ? 2 : 1);
      assert.equal(before.events, afterCommit ? 4 : 1);
      assert.equal(
        before.callbacks,
        point === 'accept-after' || point.startsWith('apply-') ? 3 : 2,
      );
      assert.equal(before.observations, point === 'observe-before' ? 2 : 3);
      let recovered: unknown;
      if (point === 'callback-before-retain') {
        assert.equal(await journal.read('request', checkpoint.key), undefined);
        await assert.rejects(
          () =>
            recoverLiveRequest(service, binding, s.actor, journal!, checkpoint.key, () => {}, true),
          (e: unknown) =>
            e instanceof DomainError && e.code === 'FIX_LIVE_ORIGINAL_INTENT_REQUIRED',
        );
      } else {
        const original = await journal.read('request', checkpoint.key);
        assert.ok(original);
        if (point === 'apply-after') {
          await assert.rejects(
            () => recoverLiveRequest(service, binding, s.actor, journal!, checkpoint.key, () => {}),
            (e: unknown) => e instanceof DomainError && e.code === 'FIX_LIVE_RECOVERY_DISABLED',
          );
          await assert.rejects(
            () =>
              recoverLiveRequest(
                service,
                { ...binding, scope: 'read' },
                s.actor,
                journal!,
                checkpoint.key,
                () => {},
                true,
              ),
            (e: unknown) => e instanceof DomainError && e.code === 'FORBIDDEN',
          );
          await assert.rejects(
            () =>
              recoverLiveRequest(
                service,
                binding,
                randomUUID(),
                journal!,
                checkpoint.key,
                () => {},
                true,
              ),
            (e: unknown) => e instanceof DomainError && e.code === 'SANDBOX_NOT_FOUND',
          );
          assert.equal(
            (
              await recoverLiveRequest(
                service,
                { ...binding, digest: 'f'.repeat(64) },
                s.actor,
                journal,
                checkpoint.key,
                () => {},
                true,
              )
            ).status,
            404,
          );
          assert.equal(
            (
              await recoverLiveRequest(
                service,
                { ...binding, generation: '2' },
                s.actor,
                journal,
                checkpoint.key,
                () => {},
                true,
              )
            ).status,
            404,
          );
        }

        const result = await recoverLiveRequest(
          service,
          binding,
          s.actor,
          journal,
          checkpoint.key,
          () => {},
          true,
        );
        recovered = result;
        assert.equal(result.status, point.startsWith('apply-') ? 200 : 201);
        assert.equal(
          result.replayed,
          point === 'observe-after' || point === 'accept-after' || point === 'apply-after',
        );
        const repeated = await recoverLiveRequest(
          service,
          binding,
          s.actor,
          journal,
          checkpoint.key,
          () => {},
          true,
        );
        assert.equal(repeated.replayed, true);
        assert.deepEqual(await journal.read('request', checkpoint.key), original);
      }
      const after = await counters(),
        applied = point.startsWith('apply-');
      assert.equal(after.executions, applied ? 1 : 0);
      assert.equal(after.consumptions, applied ? 2 : 1);
      assert.equal(after.events, applied ? 4 : 1);
      assert.equal(after.filled_par, applied ? '100.00' : '0.00');
      const verified = await verifyLiveApplication(reader, binding, journal, () => {}, true);
      assert.equal(verified.total_findings, 0, JSON.stringify(verified.findings));
      assert.equal(verified.financial_application_verified, applied);
      assert.equal(
        verified.assessment,
        applied ? 'OBSERVED_LIVE_APPLICATION_CONSISTENT' : 'INCOMPLETE',
      );
      if (applied) {
        assert.ok(BigInt(after.executed_cents) > 0n);
        assert.equal(verified.oracle.cash_cents, after.executed_cents);
      }
      await mkdir(evidence, { recursive: true, mode: 0o700 });
      await savePrivate(join(evidence, 'outcome.json'), {
        version: 1,
        scope: 'synthetic-fix-live-crash',
        point,
        run_id: identity.run_id,
        image: process.env['TF_FIX_LIVE_IMAGE'],
        worker_pid: worker.pid,
        exit_signal: exit.signal,
        request_key: checkpoint.key,
        before,
        after,
        recovered: recovered ?? null,
        verification: verified,
      });
      await cp(directory, join(evidence, 'journal'), {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await journal?.close();
      await reader.close();
      await db.close();
      await removeLiveRuntime(identity.run_id);
      await s.close();
      await rm(temporary, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });
