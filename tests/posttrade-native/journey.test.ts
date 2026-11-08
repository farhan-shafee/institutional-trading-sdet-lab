/** Actual selected native engines plus schema10. Source admission is mandatory even on direct invocation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { admitPostTradeNative } from '../../scripts/verify-posttrade-journey.js';
import { startOwnedPostgres } from '../../scripts/owned-postgres.js';
import { bootstrap, readOwner } from '../../scripts/workflow-database.js';
import { migratePostTrade } from '../../scripts/posttrade-workflow-database.js';
import { PostTradeWorkflowDatabase } from '../../app/persistence/postgres/post-trade-workflow.js';
import { PostTradeService } from '../../app/server/post-trade/service.js';
import { LiveFixApplicationService } from '../../app/server/fix/live-application.js';
import { LiveFixController } from '../../app/server/fix/live-controller.js';
import { LiveJournal } from '../../app/server/fix/live-journal.js';
import { runtime, body } from '../fix-live/runtime-fixture.js';
import { fixture, report } from '../postgres/fix-fixture.js';
import { connection } from '../postgres/harness.js';
import { durableFixSnapshot } from '../postgres/fix-recovery-evidence.js';
import { buildPostTradeReport } from '../../scripts/posttrade-report.js';

await test('source-admitted native D/8/F/9 receipts feed one immutable funded correction/bust/risk/FIFO book', async () => {
  admitPostTradeNative();
  const previous = process.env['TF_DB_OWNER_FILE'];
  const owned = await startOwnedPostgres(process.env['TF_PG_BIN'], {
    onAllocated: async (path) => {
      const pointer = process.env['TF_LIVE_OWNER_POINTER'];
      if (pointer) await writeFile(pointer, path + '\n', { mode: 0o600 });
    },
  });
  let s: Awaited<ReturnType<typeof fixture>> | undefined,
    database: PostTradeWorkflowDatabase | undefined,
    engine: Awaited<ReturnType<typeof runtime>> | undefined,
    journal: LiveJournal | undefined,
    controller: LiveFixController | undefined;
  let directory = '';
  let primary: Error | undefined;
  try {
    await bootstrap(owned.path);
    await migratePostTrade(owned.path);
    process.env['TF_DB_OWNER_FILE'] = owned.path;
    s = await fixture('100.00', 'BUY', 'SYN-UST-2031', '2030-01-15');
    const book = s,
      cfg = await readOwner(owned.path);
    assert.ok(cfg.appUrl);
    database = new PostTradeWorkflowDatabase(cfg.appUrl);
    const finance = new PostTradeService(database),
      binding = {
        sandboxId: book.id,
        digest: book.proof,
        scope: 'trade' as const,
        generation: '1',
      };
    const command = (
      op: Parameters<PostTradeService['command']>[1],
      payload: unknown,
      key = randomUUID(),
    ) => finance.command(binding, op, payload, key, book.actor, () => {});
    assert.equal((await command('INITIALIZE', { economic_start_date: '2030-01-15' })).status, 201);
    engine = await runtime();
    directory = join(process.cwd(), '.local', 'fix-live', engine.identity.run_id);
    journal = await LiveJournal.open(directory, {
      run_id: engine.identity.run_id,
      session_id: engine.identity.session_id,
      store_id: engine.identity.store_id,
      runtime_hash: engine.identity.runtime_hash,
    });
    controller = new LiveFixController({
      service: new LiveFixApplicationService(database, true),
      journal,
      process: engine.child,
      runtime: engine.identity,
      contexts: [
        {
          binding,
          actor_id: book.actor,
          order_id: book.order,
          channel_id: book.channel,
          owner_id: randomUUID(),
          verify: () => {},
        },
      ],
      enabled: true,
    });
    await controller.start();
    const terms = body(await report(book)),
      order: Record<string, string> = { ...terms, '35': 'D', '21': '1' };
    for (const tag of ['37', '17', '150', '39', '14', '151', '6']) delete order[tag];
    assert.equal((await controller.send(book.order, order)).status, 201);
    assert.equal((await controller.send(book.order, terms)).status, 200);
    const cancel = randomUUID(),
      stamp = new Date().toISOString().replaceAll('-', '').replace('T', '-').replace('Z', '');
    assert.equal(
      (
        await controller.send(book.order, {
          '35': 'F',
          '11': cancel,
          '41': book.order,
          '37': terms['37']!,
          '55': terms['55']!,
          '167': terms['167']!,
          '54': terms['54']!,
          '38': terms['38']!,
          '60': stamp,
          '58': 'SYNTHETIC_CANCEL_REQUEST',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await controller.send(book.order, {
          '35': '9',
          '11': cancel,
          '41': book.order,
          '37': terms['37']!,
          '39': '0',
          '434': '1',
          '102': '99',
          '60': stamp,
          '58': 'SYNTHETIC_CANCEL_REJECT',
        })
      ).status,
      200,
    );
    for (const [par, cum, leaves, status] of [
      ['40.00', '40.00', '60.00', '1'],
      ['60.00', '100.00', '0.00', '2'],
    ]) {
      assert.equal(
        (
          await controller.send(
            book.order,
            body(
              await report(book, {
                '150': 'F',
                '39': status!,
                '32': par!,
                '31': terms['44']!,
                '6': terms['44']!,
                '14': cum!,
                '151': leaves!,
              }),
            ),
          )
        ).status,
        200,
      );
    }
    const applies = (await journal.entries('request')).filter(
      (row) =>
        typeof row.value === 'object' &&
        row.value !== null &&
        'kind' in row.value &&
        row.value.kind === 'APPLY',
    );
    assert.equal(applies.length, 5);
    for (const apply of applies) {
      const replay = await controller.recoverKnown(apply.id);
      assert.equal(replay.status, 200);
      assert.equal(replay.replayed, true);
    }
    await controller.stop();
    const nativeRoots = (
      await book.app.query<{ id: string }>(
        'SELECT id FROM fi.executions WHERE sandbox_id=$1 AND order_id=$2 ORDER BY fill_sequence',
        [book.id, book.order],
      )
    ).rows;
    assert.equal(nativeRoots.length, 2);
    const sellOrder = await book.createOrder('40.00', 'SELL', 'SYN-UST-2031', '2030-01-15');
    assert.equal(
      (await book.command('ACK_ORDER', { order_id: sellOrder, expected_version: '1' })).status,
      200,
    );
    const sold = await book.command('EXECUTE_ORDER', {
      order_id: sellOrder,
      expected_version: '2',
      execution_id: randomUUID(),
      source_event_id: randomUUID(),
      par_amount: '40.00',
    });
    assert.equal(sold.status, 201);
    assert.ok(sold.body.execution);
    const sell = sold.body.execution.id,
      first = nativeRoots[0]!.id,
      second = nativeRoots[1]!.id;
    async function originals() {
      const graph = await durableFixSnapshot(book.id);
      graph['command_keys'] = graph['command_keys']!.filter((row) => row['domain'] !== 'POSTTRADE');
      const admin = await connection('admin');
      try {
        for (const table of [
          'fix_live_sessions',
          'fix_live_bindings',
          'fix_live_connections',
          'fix_live_observations',
          'fix_live_callbacks',
          'fix_live_sequence_slots',
          'fix_live_requests',
        ])
          graph[table] = (
            await admin.query<{ row: Record<string, unknown> }>(
              `SELECT to_jsonb(t) row FROM fi.${table} t WHERE sandbox_id=$1 ORDER BY to_jsonb(t)::text`,
              [book.id],
            )
          ).rows.map((r) => r.row);
      } finally {
        await admin.end();
      }
      return graph;
    }
    const before = await originals();
    for (const id of [first, second, sell])
      assert.equal((await command('REGISTER', { execution_id: id })).status, 201);
    assert.equal(
      (
        await command('CORRECT_PRICE', {
          execution_id: first,
          expected_revision: 0,
          clean_price: '100.880000000000',
        })
      ).status,
      201,
    );
    const due = (id: string, revision = 0) => ({
      execution_id: id,
      expected_revision: revision,
      processing_date: '2030-01-15',
    });
    const failedKey = randomUUID();
    assert.equal((await command('SETTLE', due(sell), failedKey)).status, 409);
    assert.equal((await command('SETTLE', due(first, 1))).status, 200);
    assert.equal((await command('SETTLE', due(second))).status, 200);
    assert.equal((await command('SETTLE', due(sell))).status, 200);
    const failedReplay = await command('SETTLE', due(sell), failedKey);
    assert.equal(failedReplay.status, 409);
    assert.equal(failedReplay.replayed, true);
    assert.equal(
      (
        await command('CORRECT_PRICE', {
          execution_id: first,
          expected_revision: 1,
          clean_price: '101.000000000000',
        })
      ).status,
      409,
    );
    assert.equal((await command('REVERSE', due(sell))).status, 200);
    assert.equal((await command('REVERSE', due(first, 1))).status, 200);
    assert.equal(
      (
        await command('CORRECT_PRICE', {
          execution_id: first,
          expected_revision: 1,
          clean_price: '101.000000000000',
        })
      ).status,
      201,
    );
    assert.equal(
      (await command('BUST', { execution_id: first, expected_revision: 2 })).status,
      201,
    );
    assert.equal((await command('REVERSE', due(second))).status, 200);
    assert.equal((await command('SETTLE', due(sell))).status, 409);
    assert.deepEqual(await originals(), before);
    const result = await buildPostTradeReport({
      version: 1,
      owner_file: owned.path,
      sandbox_id: book.id,
      proof: book.proof,
      scope: 'trade',
      generation: '1',
      fixture_id: 'BASE_UP_V1',
      as_of_date: '2030-01-15',
    });
    assert.equal(result.assessment.status, 'AVAILABLE');
    assert.equal(result.source.posttrade_command_seq, '14');
    const oracle = spawnSync('python3', ['verification/python/posttrade_reconstruct.py'], {
      input: JSON.stringify([result]),
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 262144,
    });
    assert.equal(oracle.status, 0, oracle.stderr);
    console.log(
      'POSTTRADE_NATIVE_RESULT ' +
        JSON.stringify({
          report_id: result.report_id,
          native_apply_receipts: applies.length,
          raw_executions: 3,
          financial_commands: result.source.posttrade_command_seq,
          financial_events: result.events.length,
          source_preserved: true,
          external_delivery_verified: false,
        }),
    );
  } catch (error) {
    primary =
      error instanceof Error ? error : new Error('Owned native journey failed.', { cause: error });
  } finally {
    const errors: unknown[] = [];
    for (const cleanup of [
      async () => {
        await controller?.stop();
      },
      async () => {
        await journal?.close();
      },
      async () => {
        await database?.close();
      },
      async () => {
        await engine?.remove();
      },
      async () => {
        await s?.close();
      },
      async () => {
        if (directory) await rm(directory, { recursive: true, force: true });
      },
      async () => {
        await owned.stop(true);
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (previous === undefined) delete process.env['TF_DB_OWNER_FILE'];
    else process.env['TF_DB_OWNER_FILE'] = previous;
    if (errors.length)
      primary = new AggregateError(
        primary ? [primary, ...errors] : errors,
        'Owned post-trade native cleanup failed.',
      );
  }
  if (primary) throw primary;
});
