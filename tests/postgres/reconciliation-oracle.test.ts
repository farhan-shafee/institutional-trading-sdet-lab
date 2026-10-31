import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { owner, connection } from './harness.js';
import { reconciliationSandbox } from './reconciliation-fixture.js';
import { verificationManifest } from '../../app/server/reconciliation/manifest.js';
import { ReconciliationRunner } from '../../app/server/reconciliation/runner.js';
await test('independent read-only scan records complete clean with exact historical watermark and hashes', async () => {
  const metadata = await verificationManifest();
  const s = await reconciliationSandbox(metadata);
  const owned = await owner();
  const runner = new ReconciliationRunner(owned.reconcilerUrl!);
  const reader = await connection('reconciler');
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    await s.fill('2', '100.00');
    const run = randomUUID();
    assert.equal((await s.reconCommand('CREATE_RECONCILIATION', run)).status, 201);
    await runner.execute(
      { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
      run,
      metadata,
      () => undefined,
    );
    const r = (
      await reader.query<{
        state: string;
        source_watermark: string;
        complete: boolean;
        coverage: unknown[];
      }>(
        'SELECT state,source_watermark::text,complete,coverage FROM fi.reconciliation_runs WHERE sandbox_id=$1 AND id=$2',
        [s.id, run],
      )
    ).rows[0]!;
    assert.equal(r.state, 'COMPLETED_CLEAN');
    assert.equal(r.complete, true);
    assert.equal(r.source_watermark, '6');
    assert.equal(r.coverage.length, 4);
    assert.equal(
      (await reader.query('SELECT * FROM fi.reconciliation_findings WHERE sandbox_id=$1', [s.id]))
        .rowCount,
      0,
    );
  } finally {
    await runner.close();
    await reader.end();
    await s.close();
  }
});
const defects = [
  [
    'filled',
    'ORDER_FILLED_PAR',
    'UPDATE fi.order_states SET filled_par=filled_par-1 WHERE sandbox_id=$1',
  ],
  [
    'remaining',
    'ORDER_REMAINING_PAR',
    'UPDATE fi.order_states SET remaining_par=1 WHERE sandbox_id=$1',
  ],
  ['missing-position', 'POSITION_MISSING', 'DELETE FROM fi.positions WHERE sandbox_id=$1'],
  [
    'signed-cash',
    'POSITION_TOTALS',
    'UPDATE fi.positions SET signed_cash_cents=signed_cash_cents+1 WHERE sandbox_id=$1',
  ],
  [
    'execution-count',
    'POSITION_TOTALS',
    'UPDATE fi.positions SET execution_count=execution_count+1 WHERE sandbox_id=$1',
  ],
  [
    'consideration',
    'EXECUTION_CONSIDERATION',
    'UPDATE fi.executions SET consideration_cents=consideration_cents+1 WHERE sandbox_id=$1',
  ],
  [
    'audit',
    'EXECUTION_AUDIT',
    'DELETE FROM fi.audit_events WHERE sandbox_id=$1 AND command_seq=6 AND event_index=0',
  ],
  ['history', 'ORDER_HISTORY', 'DELETE FROM fi.order_history WHERE sandbox_id=$1 AND version=3'],
] as const;
for (const [name, expectedCode, sql] of defects)
  await test(`actual persisted reconciliation detects ${name} with independently reproducible values`, async () => {
    const metadata = await verificationManifest(),
      s = await reconciliationSandbox(metadata),
      owned = await owner();
    const runner = new ReconciliationRunner(owned.reconcilerUrl!),
      admin = await connection('admin'),
      reader = await connection('reconciler');
    try {
      await s.command('ACK_ORDER', { expected_version: '1' });
      await s.fill('2', '100.00');
      await admin.query('BEGIN');
      await admin.query("SET LOCAL session_replication_role='replica'");
      await admin.query(sql, [s.id]);
      await admin.query('COMMIT');
      const run = randomUUID();
      assert.equal((await s.reconCommand('CREATE_RECONCILIATION', run)).status, 201);
      await runner.execute(
        { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
        run,
        metadata,
        () => undefined,
      );
      const r = (
        await reader.query<{ state: string; complete: boolean }>(
          'SELECT state,complete FROM fi.reconciliation_runs WHERE sandbox_id=$1 AND id=$2',
          [s.id, run],
        )
      ).rows[0]!;
      assert.equal(r.state, 'COMPLETED_WITH_FINDINGS');
      assert.equal(r.complete, true);
      const findings = (
        await reader.query<{ expected: unknown; observed: unknown; record_id: string }>(
          'SELECT expected,observed,record_id FROM fi.reconciliation_findings WHERE sandbox_id=$1 AND run_id=$2 AND code=$3',
          [s.id, run, expectedCode],
        )
      ).rows;
      assert.ok(findings.length > 0, expectedCode);
      assert.notDeepEqual(findings[0]?.expected, findings[0]?.observed);
      assert.ok(findings[0]?.record_id);
    } finally {
      await runner.close();
      await reader.end();
      await admin.end();
      await s.close();
    }
  });
await test('matching ledger/state/position/history/receipt cash corruption still fails independent rational consideration', async () => {
  const metadata = await verificationManifest(),
    s = await reconciliationSandbox(metadata),
    owned = await owner();
  const runner = new ReconciliationRunner(owned.reconcilerUrl!),
    admin = await connection('admin'),
    reader = await connection('reconciler');
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    await s.fill('2', '100.00');
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      'UPDATE fi.executions SET consideration_cents=consideration_cents+1 WHERE sandbox_id=$1',
      [s.id],
    );
    await admin.query(
      'UPDATE fi.order_states SET executed_cents=executed_cents+1 WHERE sandbox_id=$1',
      [s.id],
    );
    await admin.query(
      'UPDATE fi.positions SET signed_cash_cents=signed_cash_cents-1 WHERE sandbox_id=$1',
      [s.id],
    );
    await admin.query(
      "UPDATE fi.order_history SET state=jsonb_set(state,'{executed_cents}',to_jsonb(((state->>'executed_cents')::bigint+1)::text)) WHERE sandbox_id=$1 AND operation='EXECUTE_ORDER'",
      [s.id],
    );
    await admin.query(
      "UPDATE fi.commands SET response_body=jsonb_set(jsonb_set(response_body,'{lifecycle,executed_cents}',to_jsonb(((response_body->'lifecycle'->>'executed_cents')::bigint+1)::text)),'{execution,consideration_cents}',to_jsonb(((response_body->'execution'->>'consideration_cents')::bigint+1)::text)) WHERE sandbox_id=$1 AND operation='EXECUTE_ORDER' AND http_status=201",
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
    const finding = (
      await reader.query<{
        expected: { consideration_cents: string };
        observed: { consideration_cents: string };
      }>(
        "SELECT expected,observed FROM fi.reconciliation_findings WHERE sandbox_id=$1 AND code='EXECUTION_CONSIDERATION'",
        [s.id],
      )
    ).rows[0]!;
    assert.equal(
      BigInt(finding.observed.consideration_cents) - BigInt(finding.expected.consideration_cents),
      1n,
    );
  } finally {
    await runner.close();
    await reader.end();
    await admin.end();
    await s.close();
  }
});
await test('broken cancellation outcomes persist as typed historical findings and later clean runs cannot erase them', async () => {
  const metadata = await verificationManifest(),
    s = await reconciliationSandbox(metadata),
    owned = await owner();
  const runner = new ReconciliationRunner(owned.reconcilerUrl!),
    admin = await connection('admin'),
    reader = await connection('reconciler');
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    const cid = randomUUID();
    await s.command('REQUEST_CANCEL', { expected_version: '2', cancel_id: cid });
    await s.fill('3', '100.00');
    await s.command('ACK_CANCEL', { expected_version: '4', cancel_id: cid });
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      "UPDATE fi.cancellation_outcomes SET outcome='ACKNOWLEDGED',reason='CANCELED_REMAINDER' WHERE sandbox_id=$1",
      [s.id],
    );
    await admin.query('COMMIT');
    const old = randomUUID();
    await s.reconCommand('CREATE_RECONCILIATION', old);
    await runner.execute(
      { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
      old,
      metadata,
      () => undefined,
    );
    const before = (
      await reader.query<Record<string, unknown>>(
        'SELECT * FROM fi.reconciliation_findings WHERE sandbox_id=$1 AND run_id=$2 ORDER BY ordinal',
        [s.id, old],
      )
    ).rows;
    assert.ok(before.length > 0);
    assert.ok(before.some((r) => r.code === 'CANCELLATION_STATE'));
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      "UPDATE fi.cancellation_outcomes SET outcome='REJECTED',reason='TOO_LATE' WHERE sandbox_id=$1",
      [s.id],
    );
    await admin.query('COMMIT');
    const next = randomUUID();
    await s.reconCommand('CREATE_RECONCILIATION', next);
    await runner.execute(
      { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
      next,
      metadata,
      () => undefined,
    );
    assert.equal(
      (
        await reader.query<{ state: string }>(
          'SELECT state FROM fi.reconciliation_runs WHERE sandbox_id=$1 AND id=$2',
          [s.id, next],
        )
      ).rows[0]?.state,
      'COMPLETED_CLEAN',
    );
    assert.deepEqual(
      (
        await reader.query(
          'SELECT * FROM fi.reconciliation_findings WHERE sandbox_id=$1 AND run_id=$2 ORDER BY ordinal',
          [s.id, old],
        )
      ).rows,
      before,
    );
    await assert.rejects(
      admin.query("UPDATE fi.reconciliation_findings SET observed='{}' WHERE sandbox_id=$1", [
        s.id,
      ]),
      { code: '42501' },
    );
  } finally {
    await runner.close();
    await reader.end();
    await admin.end();
    await s.close();
  }
});
await test('matched quotation/order bid corruption reports the independent exact original dealer price', async () => {
  const metadata = await verificationManifest(),
    s = await reconciliationSandbox(metadata),
    owned = await owner();
  const runner = new ReconciliationRunner(owned.reconcilerUrl!),
    admin = await connection('admin'),
    reader = await connection('reconciler');
  try {
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      "UPDATE fi.quotes SET bid_clean_price='97.000000000123',snapshot=jsonb_set(snapshot,'{bid_clean_price}','\"97.000000000123\"') WHERE sandbox_id=$1",
      [s.id],
    );
    await admin.query(
      "UPDATE fi.orders SET contract=jsonb_set(contract,'{bid_clean_price}','\"97.000000000123\"') WHERE sandbox_id=$1",
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
    const f = (
      await reader.query<{ expected: { bid: string }; observed: { bid: string } }>(
        "SELECT expected,observed FROM fi.reconciliation_findings WHERE sandbox_id=$1 AND code='QUOTE_GRID'",
        [s.id],
      )
    ).rows[0];
    assert.ok(f);
    assert.equal(f.expected.bid, '99.950000000123');
    assert.equal(f.observed.bid, '97.000000000123');
  } finally {
    await runner.close();
    await reader.end();
    await admin.end();
    await s.close();
  }
});
