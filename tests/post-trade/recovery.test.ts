import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { savePrivate } from '../../scripts/private-state.js';
import { buildPostTradeReport } from '../../scripts/posttrade-report.js';
import { PostTradeWorkflowDatabase } from '../../app/persistence/postgres/post-trade-workflow.js';
import { PostTradeService } from '../../app/server/post-trade/service.js';
import { owner } from '../postgres/harness.js';
import { fundedBook, duePayload } from './settlement-fixture.js';

for (const point of ['before', 'after'] as const)
  await test(
    'real worker SIGKILL ' + point + ' settlement COMMIT recovers only the original financial key',
    async () => {
      const s = await fundedBook(),
        directory = await mkdtemp(join(tmpdir(), 'tradeflow-posttrade-crash-'));
      const key = randomUUID(),
        cfg = await owner();
      assert.ok(cfg.appUrl);
      const database = new PostTradeWorkflowDatabase(cfg.appUrl),
        service = new PostTradeService(database);
      let child: ReturnType<typeof spawn> | undefined;
      try {
        const reportInput = {
          version: 1,
          owner_file: process.env['TF_DB_OWNER_FILE'],
          sandbox_id: s.id,
          proof: s.proof,
          scope: 'trade',
          generation: '1',
          fixture_id: 'FLAT_V1',
          as_of_date: '2030-01-15',
        };
        const before = await buildPostTradeReport(reportInput);
        const context = join(directory, 'context.json');
        await savePrivate(context, {
          owner_file: process.env['TF_DB_OWNER_FILE'],
          sandbox_id: s.id,
          proof: s.proof,
          actor: s.actor,
          execution_id: s.raw.id,
          key,
          point,
        });
        child = spawn(
          process.execPath,
          ['--import', 'tsx', 'tests/post-trade/crash-worker.ts', context],
          { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
        );
        const worker = child,
          exited = once(worker, 'exit');
        let output = 0;
        for (const stream of [worker.stdout, worker.stderr])
          stream?.on('data', (chunk: Buffer) => {
            output += chunk.length;
            if (output > 65536) worker.kill('SIGKILL');
          });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            worker.kill('SIGKILL');
            reject(new Error('Post-trade worker missed controlled COMMIT barrier.'));
          }, 1000);
          worker.once('message', (message: unknown) => {
            clearTimeout(timer);
            try {
              const checkpoint = z
                .object({
                  kind: z.literal('CHECKPOINT'),
                  point: z.enum(['before', 'after']),
                  key: z.uuid(),
                })
                .strict()
                .parse(message);
              assert.equal(checkpoint.point, point);
              assert.equal(checkpoint.key, key);
              worker.kill('SIGKILL');
              resolve();
            } catch (error) {
              reject(
                error instanceof Error
                  ? error
                  : new Error('Invalid owned checkpoint.', { cause: error }),
              );
            }
          });
          void exited.then(() => {
            clearTimeout(timer);
            reject(new Error('Post-trade worker exited before checkpoint.'));
          }, reject);
        });
        const [, signal] = z
          .tuple([z.number().int().nullable(), z.string().nullable()])
          .parse(await exited);
        assert.equal(signal, 'SIGKILL');
        child = undefined;
        const binding = {
          sandboxId: s.id,
          digest: s.proof,
          scope: 'trade' as const,
          generation: '1',
        };
        const receipt = await service.receipt(binding, key, () => {});
        assert.equal(receipt.status, point === 'after' ? 200 : 404);
        const current = await buildPostTradeReport(reportInput);
        assert.equal(current.assessment.status, 'AVAILABLE');
        assert.equal(before.assessment.status, 'AVAILABLE');
        if (current.assessment.status === 'AVAILABLE' && before.assessment.status === 'AVAILABLE')
          assert.equal(current.assessment.pnl.total_pnl_usd, before.assessment.pnl.total_pnl_usd);
        assert.equal(
          current.source.roots[0]!.settlement_state,
          point === 'after' ? 'SETTLED' : 'PENDING',
        );
        const recovered = await service.command(
          binding,
          'SETTLE',
          duePayload(s.raw.id),
          key,
          s.actor,
          () => {},
        );
        assert.equal(recovered.status, 200);
        assert.equal(recovered.replayed, point === 'after');
        const replay = await service.command(
          binding,
          'SETTLE',
          duePayload(s.raw.id),
          key,
          s.actor,
          () => {},
        );
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.body, recovered.body);
        const final = await buildPostTradeReport(reportInput);
        assert.equal(final.source.posttrade_command_seq, '3');
        assert.equal(final.events.length, 4);
        assert.equal(final.history[0]!.settlement_outcomes.length, 1);
      } finally {
        if (child && child.exitCode === null) {
          child.kill('SIGKILL');
          await once(child, 'exit');
        }
        await database.close();
        await s.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
