import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { reconciliationSandbox } from './reconciliation-fixture.js';
import { connection, owner } from './harness.js';
import { verificationManifest } from '../../app/server/reconciliation/manifest.js';
import { ReconciliationRunner } from '../../app/server/reconciliation/runner.js';
const cancellationDefects = [
  [
    'reason/outcome pair',
    'CANCELLATION_TERMS',
    "UPDATE fi.cancellation_outcomes SET reason='CANCELED_REMAINDER' WHERE sandbox_id=$1",
  ],
  [
    'request receipt link',
    'CANCELLATION_REQUEST_REFERENCE',
    "UPDATE fi.cancellation_requests SET command_id=(SELECT id FROM fi.commands WHERE sandbox_id=$1 AND operation='ACK_ORDER'),command_seq=5 WHERE sandbox_id=$1",
  ],
  [
    'outcome receipt link',
    'CANCELLATION_OUTCOME_REFERENCE',
    "UPDATE fi.cancellation_outcomes SET command_id=(SELECT id FROM fi.commands WHERE sandbox_id=$1 AND operation='ACK_ORDER'),command_seq=5 WHERE sandbox_id=$1",
  ],
  [
    'outcome audit identity',
    'CANCELLATION_OUTCOME_REFERENCE',
    "UPDATE fi.audit_events SET payload=jsonb_set(payload,'{cancel_id}',to_jsonb(gen_random_uuid()::text)) WHERE sandbox_id=$1 AND event_type='CANCEL_REJECTED'",
  ],
  [
    'request sequence',
    'CANCELLATION_REQUEST_REFERENCE',
    'UPDATE fi.cancellation_requests SET request_sequence=2 WHERE sandbox_id=$1',
  ],
] as const;
for (const [name, code, sql] of cancellationDefects)
  await test(`independent review regression: detects cancellation ${name} instead of false clean`, async () => {
    const metadata = await verificationManifest(),
      s = await reconciliationSandbox(metadata),
      admin = await connection('admin'),
      reader = await connection('reconciler'),
      runner = new ReconciliationRunner((await owner()).reconcilerUrl!);
    try {
      await s.command('ACK_ORDER', { expected_version: '1' });
      const cancel = randomUUID();
      await s.command('REQUEST_CANCEL', { expected_version: '2', cancel_id: cancel });
      await s.command('REJECT_CANCEL', { expected_version: '3', cancel_id: cancel });
      await admin.query('BEGIN');
      await admin.query("SET LOCAL session_replication_role='replica'");
      await admin.query(sql, [s.id]);
      await admin.query('COMMIT');
      const run = randomUUID();
      await s.reconCommand('CREATE_RECONCILIATION', run);
      await runner.execute(
        { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
        run,
        metadata,
        () => undefined,
      );
      const result = (
        await reader.query<{ state: string }>(
          'SELECT state FROM fi.reconciliation_runs WHERE sandbox_id=$1 AND id=$2',
          [s.id, run],
        )
      ).rows[0];
      assert.equal(result?.state, 'COMPLETED_WITH_FINDINGS');
      const findings = (
        await reader.query<{ code: string; expected: unknown; observed: unknown }>(
          'SELECT code,expected,observed FROM fi.reconciliation_findings WHERE sandbox_id=$1 AND run_id=$2',
          [s.id, run],
        )
      ).rows;
      assert.ok(
        findings.some((f) => f.code === code),
        JSON.stringify(findings),
      );
      assert.notDeepEqual(
        findings.find((f) => f.code === code)?.expected,
        findings.find((f) => f.code === code)?.observed,
      );
    } finally {
      await runner.close();
      await admin.end();
      await reader.end();
      await s.close();
    }
  });
const lifecycleDefects = [
  [
    'initial contract history',
    'INITIAL_ORDER_HISTORY',
    [
      "UPDATE fi.order_history SET state=jsonb_set(state,'{status}','\"FILLED\"') WHERE sandbox_id=$1 AND version=1",
    ],
  ],
  [
    'acknowledgment audit type',
    'LIFECYCLE_AUDIT',
    [
      "UPDATE fi.audit_events SET event_type='ORDER_REJECTED' WHERE sandbox_id=$1 AND event_type='ORDER_ACKNOWLEDGED'",
    ],
  ],
  [
    'matched illegal acknowledgment transition',
    'LIFECYCLE_TRANSITION',
    [
      "UPDATE fi.order_states SET status='CANCELED',remaining_par=0 WHERE sandbox_id=$1",
      "UPDATE fi.order_history SET state=jsonb_set(jsonb_set(state,'{status}','\"CANCELED\"'),'{remaining_par}','\"0.00\"') WHERE sandbox_id=$1 AND version=2",
      "UPDATE fi.commands SET response_body=jsonb_set(jsonb_set(response_body,'{lifecycle,status}','\"CANCELED\"'),'{lifecycle,remaining_par}','\"0.00\"') WHERE sandbox_id=$1 AND operation='ACK_ORDER'",
    ],
  ],
] as const;
for (const [name, code, sqls] of lifecycleDefects)
  await test(`independent review regression: detects ${name} instead of false clean`, async () => {
    const metadata = await verificationManifest(),
      s = await reconciliationSandbox(metadata),
      admin = await connection('admin'),
      reader = await connection('reconciler'),
      runner = new ReconciliationRunner((await owner()).reconcilerUrl!);
    try {
      await s.command('ACK_ORDER', { expected_version: '1' });
      await admin.query('BEGIN');
      await admin.query("SET LOCAL session_replication_role='replica'");
      for (const sql of sqls) await admin.query(sql, [s.id]);
      await admin.query('COMMIT');
      const run = randomUUID();
      await s.reconCommand('CREATE_RECONCILIATION', run);
      await runner.execute(
        { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
        run,
        metadata,
        () => undefined,
      );
      assert.equal(
        (
          await reader.query<{ state: string }>(
            'SELECT state FROM fi.reconciliation_runs WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0]?.state,
        'COMPLETED_WITH_FINDINGS',
      );
      assert.ok(
        (
          await reader.query<{ code: string }>(
            'SELECT code FROM fi.reconciliation_findings WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows.some((f) => f.code === code),
      );
    } finally {
      await runner.close();
      await reader.end();
      await admin.end();
      await s.close();
    }
  });

await test('independent review regression: matched historical remaining quantity and receipt corruption is detected after a later full fill', async () => {
  const metadata = await verificationManifest(),
    s = await reconciliationSandbox(metadata),
    admin = await connection('admin'),
    reader = await connection('reconciler'),
    runner = new ReconciliationRunner((await owner()).reconcilerUrl!);
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    await s.fill('2', '40.00');
    await s.fill('3', '60.00');
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      "UPDATE fi.order_history SET state=jsonb_set(state,'{remaining_par}','\"59.00\"') WHERE sandbox_id=$1 AND version=3",
      [s.id],
    );
    await admin.query(
      "UPDATE fi.commands SET response_body=jsonb_set(response_body,'{lifecycle,remaining_par}','\"59.00\"') WHERE sandbox_id=$1 AND operation='EXECUTE_ORDER' AND response_body->'lifecycle'->>'version'='3'",
      [s.id],
    );
    await admin.query('COMMIT');
    const run = randomUUID();
    await s.reconCommand('CREATE_RECONCILIATION', run);
    await runner.execute(
      { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
      run,
      metadata,
      () => undefined,
    );
    assert.equal(
      (
        await reader.query<{ state: string }>(
          'SELECT state FROM fi.reconciliation_runs WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]?.state,
      'COMPLETED_WITH_FINDINGS',
    );
    const f = (
      await reader.query<{
        expected: { remaining_par: string };
        observed: { remaining_par: string };
      }>(
        "SELECT expected,observed FROM fi.reconciliation_findings WHERE sandbox_id=$1 AND code='HISTORICAL_EXECUTION_TOTALS'",
        [s.id],
      )
    ).rows[0];
    assert.equal(f?.expected.remaining_par, '60.00');
    assert.equal(f?.observed.remaining_par, '59.00');
  } finally {
    await runner.close();
    await reader.end();
    await admin.end();
    await s.close();
  }
});

await test('independent review regression: position audit instrument identity is independently tied to the immutable order', async () => {
  const metadata = await verificationManifest(),
    s = await reconciliationSandbox(metadata),
    admin = await connection('admin'),
    reader = await connection('reconciler'),
    runner = new ReconciliationRunner((await owner()).reconcilerUrl!);
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    await s.fill('2', '100.00');
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      "UPDATE fi.audit_events SET payload=jsonb_set(payload,'{instrument_revision}','\"phase1-corp-1\"') WHERE sandbox_id=$1 AND event_type='POSITION_UPDATED'",
      [s.id],
    );
    await admin.query('COMMIT');
    const run = randomUUID();
    await s.reconCommand('CREATE_RECONCILIATION', run);
    await runner.execute(
      { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
      run,
      metadata,
      () => undefined,
    );
    assert.equal(
      (
        await reader.query<{ state: string }>(
          'SELECT state FROM fi.reconciliation_runs WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]?.state,
      'COMPLETED_WITH_FINDINGS',
    );
    const f = (
      await reader.query<{
        expected: { instrument_revision: string };
        observed: { instrument_revision: string };
      }>(
        "SELECT expected,observed FROM fi.reconciliation_findings WHERE sandbox_id=$1 AND code='LIFECYCLE_AUDIT'",
        [s.id],
      )
    ).rows[0];
    assert.equal(f?.expected.instrument_revision, 'phase1-ust-1');
    assert.equal(f?.observed.instrument_revision, 'phase1-corp-1');
  } finally {
    await runner.close();
    await reader.end();
    await admin.end();
    await s.close();
  }
});
