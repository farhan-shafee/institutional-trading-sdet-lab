import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { reconciliationSandbox } from './reconciliation-fixture.js';
import { reconciliationHttp } from './reconciliation-http-fixture.js';
import { owner, connection } from './harness.js';
import { verificationManifest } from '../../app/server/reconciliation/manifest.js';
import { ReconciliationRunner } from '../../app/server/reconciliation/runner.js';
import { httpLab } from './http.js';
import {
  reconciliationDetailSchema,
  reconciliationReceiptSchema,
  reconciliationReferenceSchema,
} from '../../app/domain/workflow/reconciliation.js';
for (const stage of ['afterScan', 'beforeCommit', 'afterCommit'])
  await test(`SIGKILL ${stage}: only committed complete results survive; interrupted runs recover without a new scan`, async () => {
    const metadata = await verificationManifest(),
      s = await reconciliationSandbox(metadata),
      run = randomUUID(),
      key = randomUUID(),
      admin = await connection('admin');
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/postgres/reconciliation-crash-worker.ts'],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env },
    );
    try {
      await s.reconCommand('CREATE_RECONCILIATION', run, key);
      const ready = once(child, 'message');
      child.send({
        binding: { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
        run,
        metadata,
        stage,
      });
      assert.equal(((await ready)[0] as { phase: string }).phase, stage);
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
      const result = (
        await admin.query<{ state: string; report_hash: string | null }>(
          'SELECT state,report_hash FROM fi.reconciliation_runs WHERE sandbox_id=$1 AND id=$2',
          [s.id, run],
        )
      ).rows[0]!;
      assert.equal(result.state, stage === 'afterCommit' ? 'COMPLETED_CLEAN' : 'RUNNING');
      assert.equal(result.report_hash !== null, stage === 'afterCommit');
      assert.equal(
        (await admin.query('SELECT * FROM fi.reconciliation_findings WHERE sandbox_id=$1', [s.id]))
          .rowCount,
        0,
      );
      assert.equal((await s.reconCommand('CREATE_RECONCILIATION', run, key)).replayed, true);
      if (stage !== 'afterCommit') {
        await admin.query('BEGIN');
        await admin.query("SET LOCAL session_replication_role='replica'");
        await admin.query(
          "UPDATE fi.reconciliation_runs SET requested_at=requested_at-interval '1 minute',started_at=started_at-interval '1 minute',lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1",
          [s.id],
        );
        await admin.query('COMMIT');
        assert.equal((await s.reconCommand('RECOVER_RECONCILIATION', run)).status, 200);
        assert.equal(
          (
            await admin.query<{ state: string }>(
              'SELECT state FROM fi.reconciliation_runs WHERE sandbox_id=$1',
              [s.id],
            )
          ).rows[0]?.state,
          'INCOMPLETE',
        );
      } else {
        assert.equal((await s.reconCommand('RECOVER_RECONCILIATION', run)).status, 200);
        assert.deepEqual(
          (
            await admin.query(
              'SELECT state,report_hash FROM fi.reconciliation_runs WHERE sandbox_id=$1',
              [s.id],
            )
          ).rows[0],
          result,
        );
      }
      assert.equal(
        (await admin.query('SELECT * FROM fi.reconciliation_runs WHERE sandbox_id=$1', [s.id]))
          .rowCount,
        1,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await admin.end();
      await s.close();
    }
  });
await test('lost response after result COMMIT resolves through the same receipt after application restart', async () => {
  const f = await reconciliationHttp({
      afterResultCommit: () => {
        throw new Error('controlled lost response');
      },
    }),
    run = randomUUID(),
    key = randomUUID();
  let restarted: Awaited<ReturnType<typeof httpLab>> | undefined;
  try {
    assert.equal(
      (await f.lab.request(`${f.root}/reconciliation-runs`, f.token, 'POST', { run_id: run }, key))
        .status,
      503,
    );
    const before = reconciliationDetailSchema.parse(
      await (await f.lab.request(`${f.root}/reconciliation-runs/${run}`, f.token)).json(),
    );
    assert.equal(before.run.state, 'COMPLETED_CLEAN');
    const receipt = await f.lab.request(`${f.root}/reconciliation-commands/${key}`, f.token);
    assert.equal(receipt.status, 200);
    assert.equal(
      reconciliationReferenceSchema.parse(
        reconciliationReceiptSchema.parse(await receipt.json()).command.response_body,
      ).run_id,
      run,
    );
    await f.lab.close();
    restarted = await httpLab(f.config);
    const token = await restarted.login();
    assert.equal(
      (
        await restarted.request('/api/fixed-income/v1/sandboxes/recover', token, 'POST', {
          sandbox_id: f.keys.sandbox_id,
          capability: f.keys.trade_capability,
          scope: 'trade',
        })
      ).status,
      200,
    );
    const response = await restarted.request(
      `${f.root}/reconciliation-runs`,
      token,
      'POST',
      { run_id: run },
      key,
    );
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('Idempotency-Replayed'), 'true');
    assert.equal(((await response.json()) as { run_id: string }).run_id, run);
    assert.deepEqual(
      reconciliationDetailSchema.parse(
        await (await restarted.request(`${f.root}/reconciliation-runs/${run}`, token)).json(),
      ),
      before,
    );
  } finally {
    await restarted?.close();
    await f.close();
  }
});
await test('result transaction failure after inserting findings rolls back all metadata and cannot become clean', async () => {
  const metadata = await verificationManifest(),
    s = await reconciliationSandbox(metadata),
    admin = await connection('admin'),
    run = randomUUID();
  const runner = new ReconciliationRunner((await owner()).reconcilerUrl!, {
    beforeResultCommit: () => {
      throw new Error('controlled failure before result commit');
    },
  });
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    await s.fill('2', '100.00');
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      'UPDATE fi.positions SET execution_count=execution_count+1 WHERE sandbox_id=$1',
      [s.id],
    );
    await admin.query('COMMIT');
    await s.reconCommand('CREATE_RECONCILIATION', run);
    await assert.rejects(
      runner.execute(
        { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
        run,
        metadata,
        () => undefined,
      ),
    );
    assert.equal(
      (
        await admin.query<{ state: string }>(
          'SELECT state FROM fi.reconciliation_runs WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]?.state,
      'RUNNING',
    );
    assert.equal(
      (await admin.query('SELECT * FROM fi.reconciliation_findings WHERE sandbox_id=$1', [s.id]))
        .rowCount,
      0,
    );
    assert.equal(
      (await admin.query('SELECT * FROM fi.reconciliation_events WHERE sandbox_id=$1', [s.id]))
        .rowCount,
      2,
    );
  } finally {
    await runner.close();
    await admin.end();
    await s.close();
  }
});
for (const mode of ['logout', 'rotation'])
  await test(`authorization ${mode} between snapshot and persistence denies result recording`, async () => {
    let changed = false;
    const f = await reconciliationHttp({
      afterScan: async () => {
        changed = true;
        if (mode === 'logout')
          assert.equal((await f.lab.request('/api/session', f.token, 'DELETE')).status, 204);
        else
          assert.equal(
            (
              await f.lab.request(
                `${f.root}/recovery-keys/rotate`,
                f.token,
                'POST',
                {
                  expected_generation: '1',
                  read_capability: randomBytes(32).toString('base64url'),
                  trade_capability: randomBytes(32).toString('base64url'),
                },
                randomUUID(),
              )
            ).status,
            200,
          );
      },
    });
    const admin = await connection('admin');
    try {
      const result = await f.lab.request(
        `${f.root}/reconciliation-runs`,
        f.token,
        'POST',
        { run_id: randomUUID() },
        randomUUID(),
      );
      assert.ok(changed);
      assert.ok(
        [401, 403, 404].includes(result.status),
        JSON.stringify({ status: result.status, body: (await result.json()) as unknown }),
      );
      assert.equal(
        (
          await admin.query<{ state: string }>(
            'SELECT state FROM fi.reconciliation_runs WHERE sandbox_id=$1',
            [f.keys.sandbox_id],
          )
        ).rows[0]?.state,
        'RUNNING',
      );
    } finally {
      await admin.end();
      await f.close();
    }
  });

await test('independent review regression: completed original-key replay works with only app credentials after optional reconciler removal', async () => {
  const f = await reconciliationHttp();
  let restarted: Awaited<ReturnType<typeof httpLab>> | undefined;
  try {
    const run = randomUUID(),
      key = randomUUID(),
      path = `${f.root}/reconciliation-runs`,
      body = { run_id: run };
    const first = await f.lab.request(path, f.token, 'POST', body, key);
    assert.equal(first.status, 201);
    const reference: unknown = await first.json();
    await f.lab.close();
    restarted = await httpLab({
      ...f.config,
      workflow: { databaseUrl: f.config.workflow!.databaseUrl },
    });
    const token = await restarted.login();
    assert.equal(
      (
        await restarted.request('/api/fixed-income/v1/sandboxes/recover', token, 'POST', {
          sandbox_id: f.keys.sandbox_id,
          capability: f.keys.trade_capability,
          scope: 'trade',
        })
      ).status,
      200,
    );
    const replay = await restarted.request(path, token, 'POST', body, key);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(await replay.json(), reference);
    assert.equal(
      (await restarted.request(path, token, 'POST', { run_id: randomUUID() }, key)).status,
      409,
    );
    assert.equal(
      (await restarted.request(path, token, 'POST', { run_id: randomUUID() }, randomUUID())).status,
      503,
    );
  } finally {
    await restarted?.close();
    await f.close();
  }
});
