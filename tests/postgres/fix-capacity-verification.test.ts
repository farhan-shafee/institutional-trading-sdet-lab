import { encodeFix44 } from '../../app/protocol/fix44/index.js';
import { verifyFixFoundation } from '../../app/server/fix/reconciliation.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import {
  WorkflowService,
  capabilityDigest,
} from '../../app/server/fixed-income-workflow/service.js';
import { FixFoundationService } from '../../app/server/fix/foundation.js';
import { VerificationDatabase } from '../../app/server/reconciliation/database.js';
import { verifyFixApplication } from '../../app/server/fix/application-reconciliation.js';
import { recoveryState, recoveryTables } from './fix-application-recovery-support.js';
import { verifyOwned } from '../../scripts/owned-postgres.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { applicationFixture } from './fix-application-fixture.js';
import { connection } from './harness.js';
import { fixture, report } from './fix-fixture.js';
import { digest } from './rfq-fixture.js';
import { foundationVerificationSources } from '../../app/server/fix/reconciliation.js';
import { assertCleanCapacity, capacityEvidence } from './fix-capacity-oracle.js';

void test('schema8 active verifiers reject a missing owned reservation without changing financial evidence', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin'),
    reader = await connection('reconciler'),
    cfg = await verifyOwned(process.env.TF_DB_OWNER_FILE!),
    verification = new VerificationDatabase(cfg.reconcilerUrl!);
  try {
    assert.equal(
      (
        await admin.query<{ marker: string }>(
          "SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()",
        )
      ).rows[0]!.marker,
      'TradeFlow local owner ' + cfg.nonce,
    );
    assert.equal((await s.apply((await s.prepare()).work)).status, 200);
    const binding = { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' as const },
      baseline = await capacityEvidence(admin, s.id),
      healthy = await assertCleanCapacity(admin, binding),
      sources = await Promise.all(
        ['fix_foundation_v2', 'fix_application_v2'].map((name) =>
          readFile('verification/sql/' + name + '.sql', 'utf8'),
        ),
      );
    assert.equal(baseline.state['fi.fix_applications']!.length, 1);
    assert.equal(baseline.state['fi.fix_consumptions']!.length, 1);
    assert.equal(baseline.state['fi_control.fix_reservations']!.length, 1);
    assert.equal(healthy.assessment, 'OBSERVED_APPLICATION_CONSISTENT');
    for (const sql of sources) {
      const report = (
        await reader.query<{
          findings: { code: string; record_id: string }[];
          total_findings: number;
        }>(sql, [s.id])
      ).rows[0]!;
      assert.deepEqual(report.findings, []);
      assert.equal(report.total_findings, 0);
    }
    const remove = 'DELETE FROM fi_control.fix_reservations WHERE sandbox_id=$1 AND order_id=$2';
    for (const role of [s.app, reader])
      await assert.rejects(role.query(remove, [s.id, s.order]), { code: '42501' });
    assert.deepEqual(await recoveryState(admin, s.id), baseline.state);
    await admin.query('BEGIN');
    try {
      await admin.query("SET LOCAL session_replication_role='replica'");
      assert.equal((await admin.query(remove, [s.id, s.order])).rowCount, 1);
      await admin.query("SET LOCAL session_replication_role='origin'");
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    const damaged = await recoveryState(admin, s.id),
      expected = { code: 'CAPACITY_RESERVATION', record_id: s.order };
    assert.deepEqual(damaged['fi_control.fix_reservations'], []);
    for (const [table, rows] of Object.entries(baseline.state))
      if (table !== 'fi_control.fix_reservations')
        assert.deepEqual(
          damaged[table],
          rows,
          'Reservation corruption changed unrelated rows: ' + table,
        );
    for (const sql of sources) {
      const report = (
        await reader.query<{
          findings: { code: string; record_id: string }[];
          total_findings: number;
        }>(sql, [s.id])
      ).rows[0]!;
      assert.ok(report.total_findings > 0);
      assert.ok(
        report.findings.some(
          (finding) => finding.code === expected.code && finding.record_id === expected.record_id,
        ),
      );
    }
    const actual = await verifyFixApplication(verification, binding, () => {}, true);
    assert.equal(actual.assessment, 'APPLICATION_FINDINGS');
    assert.equal(actual.financial_application_verified, false);
    assert.equal(actual.observed_transcript_complete, false);
    assert.equal(actual.financial_findings, 0);
    for (const findings of [actual.findings, actual.foundation_coverage.findings])
      assert.ok(
        findings.some(
          (finding) => finding.code === expected.code && finding.record_id === expected.record_id,
        ),
      );
    assert.equal(actual.snapshot_id, actual.foundation_coverage.snapshot_id);
    for (const key of [
      'financial_watermark',
      'protocol_watermark',
      'protocol_ingest_watermark',
      'protocol_prepare_watermark',
      'protocol_application_watermark',
    ] as const)
      assert.equal(actual[key], healthy[key]);
    assert.deepEqual(
      await recoveryState(admin, s.id),
      damaged,
      'Verification changed retained damaged evidence.',
    );
  } finally {
    await admin.query('ROLLBACK');
    await verification.close();
    await reader.end();
    await s.close();
    await admin.end();
  }
});

void test('queued deferred application integrity rejects a missing transaction-local consumption at COMMIT and rolls back every effect', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin'),
    cfg = await verifyOwned(process.env.TF_DB_OWNER_FILE!);
  try {
    assert.equal(
      (
        await admin.query<{ marker: string }>(
          "SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()",
        )
      ).rows[0]!.marker,
      'TradeFlow local owner ' + cfg.nonce,
    );
    const prepared = await s.prepare(),
      key = randomUUID(),
      binding = { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' as const },
      before = await capacityEvidence(admin, s.id),
      remove = 'DELETE FROM fi.fix_consumptions WHERE sandbox_id=$1 AND work_id=$2';
    assert.equal(before.state['fi.fix_applications']!.length, 0);
    assert.equal(before.state['fi.fix_consumptions']!.length, 0);
    await assert.rejects(s.app.query(remove, [s.id, prepared.work]), { code: '42501' });
    assert.deepEqual(await recoveryState(admin, s.id), before.state);
    await assertCleanCapacity(admin, binding);
    await admin.query('BEGIN');
    try {
      assert.equal((await s.apply(prepared.work, key, admin)).status, 200);
      const pending = (
        await admin.query<{
          applications: number;
          consumptions: number;
          commands: number;
          audits: number;
        }>(
          'SELECT (SELECT count(*)::int FROM fi.fix_applications WHERE sandbox_id=$1 AND work_id=$2) applications,(SELECT count(*)::int FROM fi.fix_consumptions WHERE sandbox_id=$1 AND work_id=$2) consumptions,(SELECT count(*)::int FROM fi.commands WHERE sandbox_id=$1) commands,(SELECT count(*)::int FROM fi.audit_events WHERE sandbox_id=$1) audits',
          [s.id, prepared.work],
        )
      ).rows[0]!;
      assert.deepEqual(pending, {
        applications: 1,
        consumptions: 1,
        commands: before.state['fi.commands']!.length + 1,
        audits: before.state['fi.audit_events']!.length + 1,
      });
      // The real application INSERT has already queued its deferred integrity
      // trigger. Only this new consumption is removed; origin is restored before
      // COMMIT so the unchanged queued constraint checks the inconsistent graph.
      await admin.query("SET LOCAL session_replication_role='replica'");
      assert.equal((await admin.query(remove, [s.id, prepared.work])).rowCount, 1);
      await admin.query("SET LOCAL session_replication_role='origin'");
      assert.equal(
        (
          await admin.query<{ mode: string }>(
            "SELECT current_setting('session_replication_role') mode",
          )
        ).rows[0]!.mode,
        'origin',
      );
      await assert.rejects(
        admin.query('COMMIT'),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23514' &&
          'message' in error &&
          error.message === 'FIX application reference inconsistent',
      );
    } finally {
      await admin.query('ROLLBACK');
    }
    assert.deepEqual(
      await recoveryState(admin, s.id),
      before.state,
      'Authoritative full snapshot must prove all financial and protocol effects rolled back.',
    );
    await assertCleanCapacity(admin, binding);
    assert.deepEqual((await capacityEvidence(admin, s.id)).state, before.state);
  } finally {
    await admin.query('ROLLBACK');
    await s.close();
    await admin.end();
  }
});

// Secondary adversarial-verifier cases only. Primary admission tests construct
// every quota from real receipts/audits and never falsify financial counters.
for (const column of ['command_count', 'event_count'] as const)
  void test(`schema8 independent FIX queries detect controlled ${column} budget corruption`, async () => {
    const s = await applicationFixture(),
      admin = await connection('admin'),
      reader = await connection('reconciler');
    try {
      assert.equal((await s.apply((await s.prepare()).work)).status, 200);
      const queries = await Promise.all(
        ['fix_foundation_v2', 'fix_application_v2'].map((file) =>
          readFile(`verification/sql/${file}.sql`, 'utf8'),
        ),
      );
      for (const sql of queries) {
        const healthy = (
          await reader.query<{ findings: { code: string }[]; total_findings: number }>(sql, [s.id])
        ).rows[0]!;
        assert.equal(
          healthy.findings.some((f) => f.code === 'EFFECTIVE_CAPACITY'),
          false,
        );
        assert.deepEqual(
          healthy.findings,
          [],
          'Healthy applied state must have no unrelated findings.',
        );
        assert.equal(healthy.total_findings, 0);
      }
      await admin.query('BEGIN');
      await admin.query("SET LOCAL session_replication_role='replica'");
      await admin.query(
        `UPDATE fi.sandboxes SET ${column}=$2::integer${column === 'command_count' ? ',commit_seq=$2::integer' : ''} WHERE id=$1`,
        [s.id, column === 'command_count' ? 512 : 1024],
      );
      await admin.query('COMMIT');
      for (const sql of queries)
        assert.equal(
          (
            await reader.query<{ findings: { code: string }[] }>(sql, [s.id])
          ).rows[0]!.findings.some((f) => f.code === 'EFFECTIVE_CAPACITY'),
          true,
        );
    } finally {
      await admin.end();
      await reader.end();
      await s.close();
    }
  });

void test('retained BIND audit detects a forged capacity epoch that recreates already-spent rotation headroom', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin'),
    reader = await connection('reconciler'),
    cfg = await verifyOwned(process.env.TF_DB_OWNER_FILE!),
    database = new WorkflowDatabase(cfg.appUrl!),
    verification = new VerificationDatabase(cfg.reconcilerUrl!);
  try {
    assert.equal(
      (
        await admin.query<{ marker: string }>(
          "SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()",
        )
      ).rows[0]!.marker,
      'TradeFlow local owner ' + cfg.nonce,
    );
    const preparedAck = await s.prepare(),
      applicationPid = (await s.app.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!
        .pid;
    const observeAck = async (phase: string, error?: unknown) => {
      try {
        const state = (
          await admin.query<Record<string, unknown>>(
            `SELECT clock_timestamp()::text observed_at,
          (SELECT jsonb_build_object('status',status,'version',version::text,'decided_at',decided_at::text,'filled_par',filled_par::text,'executed_cents',executed_cents::text,'execution_count',execution_count,'pending_cancel_id',pending_cancel_id) FROM fi.order_states WHERE sandbox_id=$1 AND order_id=$2) current_order,
          (SELECT jsonb_build_object('owner_id',owner_id,'actor_id',actor_id,'fence',fence::text,'generation',capability_generation::text,'lease_expires_at',lease_expires_at::text) FROM fi.fix_lanes WHERE sandbox_id=$1 AND order_id=$2) lane,
          (SELECT jsonb_build_object('work_id',work_id,'financial_key',financial_key,'operation',operation,'expected_version',payload->>'expected_version','prepared_fence',prepared_fence::text,'prepared_generation',prepared_generation::text) FROM fi.fix_prepared WHERE sandbox_id=$1 AND work_id=$3) preparation,
          (SELECT jsonb_build_object('pid',pid,'backend_xid',backend_xid::text,'state',state,'wait_event_type',wait_event_type,'wait_event',wait_event,'blocking_pids',pg_blocking_pids(pid)) FROM pg_stat_activity WHERE pid=$4) backend`,
            [s.id, s.order, preparedAck.work, applicationPid],
          )
        ).rows[0];
        const failure = error as { code?: unknown; message?: unknown } | undefined;
        await mkdir('.local/verification', { recursive: true });
        await writeFile(
          '.local/verification/capacity-epoch-ack-' + s.id + '-' + phase + '.json',
          JSON.stringify(
            {
              phase,
              sandbox: s.id,
              order: s.order,
              work: preparedAck.work,
              financialKey: preparedAck.financialKey,
              applicationPid,
              state,
              error: failure
                ? {
                    code: typeof failure.code === 'string' ? failure.code : null,
                    message:
                      failure.message === 'Invalid lifecycle transition' ? failure.message : null,
                  }
                : null,
              limitation:
                'Separate read-only snapshot; private proposed NEW and actual guard predicate bits are not observable.',
            },
            null,
            2,
          ),
          { flag: 'wx' },
        );
      } catch {
        console.error(
          'Capacity epoch ACK observation unavailable. Private connection material omitted.',
        );
      }
    };
    await observeAck('before-apply');
    try {
      assert.equal((await s.apply(preparedAck.work)).status, 200);
    } catch (error) {
      await observeAck('rejected', error);
      throw error;
    }
    await observeAck('committed');
    const binding = { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' as const },
      trade = randomBytes(32).toString('base64url'),
      rotationKey = randomUUID();
    const rotated = await new WorkflowService(database).rotate(
      binding,
      {
        expected_generation: '1',
        read_capability: randomBytes(32).toString('base64url'),
        trade_capability: trade,
      },
      rotationKey,
      s.actor,
      () => {},
    );
    assert.equal(rotated.status, 200);
    const current = { ...binding, digest: capabilityDigest(s.id, 'trade', trade), generation: '2' };
    const claim = await new FixFoundationService(database, true).command(
      current,
      s.actor,
      'CLAIM',
      { order_id: s.order, owner_id: randomUUID() },
      randomUUID(),
      () => {},
    );
    assert.equal(claim.status, 200);
    const sources = await Promise.all(
      ['fix_foundation_v2', 'fix_application_v2'].map((name) =>
        readFile('verification/sql/' + name + '.sql', 'utf8'),
      ),
    );
    assert.equal(
      createHash('sha256').update(sources[0]!).digest('hex'),
      foundationVerificationSources.current.sha256,
    );
    const applicationPin = (
      await readFile('app/server/fix/application-reconciliation.ts', 'utf8')
    ).match(/const SQL_HASH = '([a-f0-9]{64})';/);
    assert.ok(applicationPin);
    assert.equal(createHash('sha256').update(sources[1]!).digest('hex'), applicationPin[1]);
    await mkdir('.local/verification', { recursive: true });
    const evidenceId = randomUUID();
    const functions = (
      await admin.query<Record<string, unknown>>(
        "SELECT p.oid::text,p.proname,pg_get_function_identity_arguments(p.oid) arguments,pg_get_userbyid(p.proowner) owner,p.prosecdef,p.provolatile,p.proconfig,p.proacl::text,pg_get_functiondef(p.oid) source FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fi_control' AND p.proname=ANY($1::text[]) ORDER BY p.proname",
        [
          [
            'fix_capacity_remaining',
            'protect_fix_capacity',
            'fix_command',
            'order_command',
            'rotate_capabilities',
            'apply_fix',
            'order_command_kernel',
            'fix_application_integrity',
          ],
        ],
      )
    ).rows;
    await writeFile(
      '.local/verification/installed-capacity-functions-' + evidenceId + '.json',
      JSON.stringify(functions, null, 2),
      { mode: 0o600, flag: 'wx' },
    );
    for (const role of ['tf_app', 'tf_reconciler', 'tf_maintenance'])
      assert.equal(
        (
          await admin.query<{ allowed: boolean }>(
            "SELECT has_function_privilege($1,'fi_control.fix_capacity_remaining(uuid)','EXECUTE') allowed",
            [role],
          )
        ).rows[0]!.allowed,
        false,
      );
    for (const ordinary of [s.app, reader])
      await assert.rejects(
        ordinary.query('UPDATE fi.fix_bindings SET created_at=created_at WHERE sandbox_id=$1', [
          s.id,
        ]),
        (e: unknown) => (e as { code?: string }).code === '42501',
      );
    const at = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
    async function independent() {
      const state = await recoveryState(admin, s.id);
      const times = (
        await admin.query<{ kind: string; id: string; at: string }>(
          "SELECT 'binding' kind,order_id::text id,to_char(created_at AT TIME ZONE 'UTC',$2) at FROM fi.fix_bindings WHERE sandbox_id=$1 UNION ALL " +
            "SELECT 'rotation',id::text,to_char(created_at AT TIME ZONE 'UTC',$2) FROM fi.commands WHERE sandbox_id=$1 AND operation='ROTATE_CAPABILITIES' UNION ALL " +
            "SELECT 'bind_audit',c.id::text,to_char(e.recorded_at AT TIME ZONE 'UTC',$2) FROM fi.fix_commands c JOIN fi.fix_events e USING(sandbox_id,command_seq) WHERE c.sandbox_id=$1 AND c.operation='BIND' AND e.event_type='BIND' UNION ALL " +
            "SELECT 'rotation_decided',c.id::text,to_char(e.decided_at AT TIME ZONE 'UTC',$2) FROM fi.commands c JOIN fi.audit_events e ON(e.sandbox_id,e.command_id,e.command_seq)=(c.sandbox_id,c.id,c.command_seq) WHERE c.sandbox_id=$1 AND c.operation='ROTATE_CAPABILITIES' UNION ALL " +
            "SELECT 'rotation_recorded',c.id::text,to_char(e.recorded_at AT TIME ZONE 'UTC',$2) FROM fi.commands c JOIN fi.audit_events e ON(e.sandbox_id,e.command_id,e.command_seq)=(c.sandbox_id,c.id,c.command_seq) WHERE c.sandbox_id=$1 AND c.operation='ROTATE_CAPABILITIES'",
          [s.id, at],
        )
      ).rows;
      assert.equal(times.filter((r) => r.kind === 'binding').length, 1);
      assert.equal(times.filter((r) => r.kind === 'rotation').length, 1);
      assert.equal(times.filter((r) => r.kind === 'bind_audit').length, 1);
      assert.equal(times.filter((r) => r.kind === 'rotation_decided').length, 1);
      assert.equal(times.filter((r) => r.kind === 'rotation_recorded').length, 1);
      const bindingEpoch = times.find((r) => r.kind === 'binding')!.at,
        auditEpoch = times.find((r) => r.kind === 'bind_audit')!.at,
        rotationDecidedEpoch = times.find((r) => r.kind === 'rotation_decided')!.at,
        rotationRecordedEpoch = times.find((r) => r.kind === 'rotation_recorded')!.at,
        rotations = times.filter((r) => r.kind === 'rotation');
      // Expected arithmetic uses committed rows and independently checked effects,
      // never the capacity helper or a production consumption function.
      for (const x of state['fi.fix_consumptions']!) {
        const a = state['fi.fix_applications']!.find((r) => r['work_id'] === x['work_id'])!,
          p = state['fi.fix_prepared']!.find((r) => r['work_id'] === x['work_id'])!;
        assert.ok(a);
        assert.ok(p);
        assert.equal(a['order_id'], x['order_id']);
        const c = state['fi.commands']!.find((r) => r['id'] === a['financial_command_id'])!;
        assert.ok(c);
        assert.equal(c['result_kind'], 'APPLIED');
        assert.equal(c['operation'], 'ACK_ORDER');
        assert.equal(c['idempotency_key'], p['financial_key']);
        assert.equal(c['request_hash'], a['financial_request_hash']);
        assert.equal(c['command_seq'], a['financial_command_seq']);
        const payload = p['payload'] as Record<string, string>;
        assert.equal(
          c['request_hash'],
          createHash('sha256')
            .update(
              JSON.stringify({
                version: 1,
                method: 'POST',
                operation: 'ACK_ORDER',
                sandbox_id: s.id,
                payload: {
                  order_id: payload['order_id'],
                  expected_version: payload['expected_version'],
                },
              }),
            )
            .digest('hex'),
        );
        assert.equal(
          p['request_hash'],
          createHash('sha256').update(String(p['_payload_text'])).digest('hex'),
        );
        const receipt = state['fi.fix_commands']!.find(
          (r) => r['command_seq'] === a['protocol_command_seq'],
        )!;
        assert.ok(receipt);
        assert.equal(receipt['operation'], 'APPLY');
        assert.equal(receipt['http_status'], 200);
        assert.deepEqual(receipt['response_body'], a['result']);
        const events = state['fi.audit_events']!.filter((r) => r['command_id'] === c['id']);
        assert.deepEqual(
          events.map((r) => r['event_type']),
          ['ORDER_ACKNOWLEDGED'],
        );
        assert.equal(
          state['fi_control.command_keys']!.find(
            (r) => r['idempotency_key'] === p['financial_key'],
          )!['domain'],
          'FINANCIAL',
        );
        assert.equal(
          state['fi.audit_events']!.filter((r) => r['command_id'] === c['id']).length,
          1,
        );
        assert.equal(
          state['fi.order_history']!.filter((r) => r['command_id'] === c['id']).length,
          1,
        );
        assert.equal(x['commands'], 1);
        assert.equal(x['events'], 1);
      }
      const active = state['fi_control.fix_reservations']!.filter((r) => r['released_at'] === null);
      const C = state['fi.commands']!.length,
        E = state['fi.audit_events']!.length,
        R = active.reduce(
          (n, r) =>
            n +
            Number(r['commands']) -
            state['fi.fix_consumptions']!.filter((x) => x['order_id'] === r['order_id']).reduce(
              (m, x) => m + Number(x['commands']),
              0,
            ),
          0,
        ),
        S = active.reduce(
          (n, r) =>
            n +
            Number(r['events']) -
            state['fi.fix_consumptions']!.filter((x) => x['order_id'] === r['order_id']).reduce(
              (m, x) => m + Number(x['events']),
              0,
            ),
          0,
        ),
        N = rotations.filter((r) => r.at >= bindingEpoch).length,
        witnessedN = rotations.filter((r) => r.at >= auditEpoch).length;
      assert.equal(C, state['financial_counters']![0]!['command_count']);
      assert.equal(E, state['financial_counters']![0]!['event_count']);
      assert.equal(R, 24);
      assert.equal(S, 42);
      const helper = (
        await admin.query<{ commands: number; events: number; security_headroom: number }>(
          'SELECT * FROM fi_control.fix_capacity_remaining($1)',
          [s.id],
        )
      ).rows[0]!;
      assert.equal(helper.commands, R);
      assert.equal(helper.events, S);
      return {
        state,
        C,
        E,
        R,
        S,
        N,
        H: Math.max(2 - N, 0),
        witnessedN,
        witnessedH: Math.max(2 - witnessedN, 0),
        bindingEpoch,
        auditEpoch,
        rotationDecidedEpoch,
        rotationRecordedEpoch,
        rotationEpoch: rotations[0]!.at,
        helper,
      };
    }
    async function assessments() {
      const raw = [];
      for (const sql of sources)
        raw.push((await reader.query<Record<string, unknown>>(sql, [s.id])).rows[0]!);
      const combined = await verifyFixApplication(verification, current, () => {}, true);
      return { foundation: raw[0]!, application: raw[1]!, combined };
    }
    const before = await independent(),
      healthy = await assessments();
    assert.equal(
      healthy.foundation['total_findings'],
      0,
      JSON.stringify(healthy.foundation['findings']),
    );
    assert.equal(
      healthy.application['total_findings'],
      0,
      JSON.stringify(healthy.application['findings']),
    );
    assert.equal(
      healthy.combined.assessment,
      'OBSERVED_APPLICATION_CONSISTENT',
      JSON.stringify(healthy.combined.findings),
    );
    assert.equal(healthy.combined.total_findings, 0);
    assert.equal(healthy.combined.financial_findings, 0);
    assert.ok(before.bindingEpoch <= before.auditEpoch && before.auditEpoch < before.rotationEpoch);
    assert.ok(before.rotationDecidedEpoch > before.auditEpoch);
    assert.equal(before.N, 1);
    assert.equal(before.H, 1);
    assert.equal(before.witnessedH, 1);
    assert.equal(before.helper.security_headroom, 1);
    // Existing privileged corruption mechanism, only on the nonce-verified
    // disposable database. No financial counter, effect, receipt or audit changes.
    await admin.query('BEGIN');
    try {
      await admin.query("SET LOCAL session_replication_role='replica'");
      await admin.query(
        "UPDATE fi.fix_bindings b SET created_at=c.created_at+interval '1 microsecond' FROM fi.commands c WHERE b.sandbox_id=$1 AND b.order_id=$2 AND c.sandbox_id=b.sandbox_id AND c.idempotency_key=$3",
        [s.id, s.order, rotationKey],
      );
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    const after = await independent(),
      corrupted = await assessments();
    for (const table of recoveryTables)
      if (table !== 'fi.fix_bindings')
        assert.deepEqual(after.state[table], before.state[table], table);
    assert.deepEqual(after.state['financial_counters'], before.state['financial_counters']);
    const withoutTime = (rows: Record<string, unknown>[]) =>
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(([key]) => !['created_at', '_exact_row'].includes(key)),
        ),
      );
    assert.deepEqual(
      withoutTime(after.state['fi.fix_bindings']!),
      withoutTime(before.state['fi.fix_bindings']!),
    );
    assert.ok(after.bindingEpoch > after.auditEpoch && after.bindingEpoch > after.rotationEpoch);
    assert.equal(after.N, 0);
    assert.equal(after.H, 2);
    assert.equal(after.witnessedN, 1);
    assert.equal(after.witnessedH, 1);
    assert.equal(after.helper.security_headroom, 2);
    const summarize = (value: Awaited<ReturnType<typeof independent>>) => ({
      C: value.C,
      E: value.E,
      R: value.R,
      S: value.S,
      N: value.N,
      H: value.H,
      witnessedN: value.witnessedN,
      witnessedH: value.witnessedH,
      bindingEpoch: value.bindingEpoch,
      bindAuditEpoch: value.auditEpoch,
      rotationDecidedEpoch: value.rotationDecidedEpoch,
      rotationRecordedEpoch: value.rotationRecordedEpoch,
      rotationEpoch: value.rotationEpoch,
      helper: value.helper,
    });
    const evidence = {
      scenario:
        'BIND timestamp moved after an already-post-binding rotation while immutable BIND audit and all economic evidence survive',
      sandbox: s.id,
      order: s.order,
      rotationKey,
      before: summarize(before),
      after: summarize(after),
      healthy,
      corrupted,
      allEconomicAndOtherProtocolRowsUnchanged: true,
      ordinaryRolesCannotMutate: true,
      classification: 'Controlled privileged corruption; not an ordinary application-role bypass',
    };
    await writeFile(
      '.local/verification/capacity-epoch-correspondence-' + evidenceId + '.json',
      JSON.stringify(evidence, null, 2),
      { mode: 0o600, flag: 'wx' },
    );
    console.log(
      'Capacity epoch correspondence evidence:',
      JSON.stringify({
        before: summarize(before),
        after: summarize(after),
        healthy: {
          foundation: healthy.foundation['total_findings'],
          application: healthy.application['total_findings'],
          combined: healthy.combined.assessment,
        },
        corrupted: {
          foundation: corrupted.foundation['total_findings'],
          application: corrupted.application['total_findings'],
          combined: corrupted.combined.assessment,
          findings: corrupted.combined.findings,
        },
      }),
    );
    const expected = [{ code: 'CAPACITY_EPOCH_PROVENANCE', record_id: s.id }];
    for (const report of [corrupted.foundation, corrupted.application]) {
      assert.deepEqual(report['findings'], expected);
      assert.equal(report['total_findings'], 1);
    }
    assert.deepEqual(corrupted.combined.findings, expected);
    assert.equal(corrupted.combined.total_findings, 1);
    assert.deepEqual(corrupted.combined.foundation_coverage.findings, expected);
    assert.equal(corrupted.combined.assessment, 'APPLICATION_FINDINGS');
    assert.equal(corrupted.combined.financial_findings, 0);
    assert.equal(
      corrupted.combined.snapshot_id,
      corrupted.combined.foundation_coverage.snapshot_id,
    );
    const watermarks = (report: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(report).filter(([key]) => key.endsWith('_watermark')));
    for (const name of ['foundation', 'application', 'combined'] as const)
      assert.deepEqual(watermarks(corrupted[name]), watermarks(healthy[name]), name);
    const repeated = await assessments();
    for (const name of ['foundation', 'application', 'combined'] as const) {
      assert.deepEqual(repeated[name]['findings'], corrupted[name]['findings'], name);
      assert.deepEqual(watermarks(repeated[name]), watermarks(corrupted[name]), name);
    }
    assert.deepEqual(await recoveryState(admin, s.id), after.state);
  } finally {
    try {
      await verification.close();
      await database.close();
      await reader.end();
    } finally {
      try {
        await s.close();
        const cleanup = (
          await admin.query<{ clean: boolean }>(
            'SELECT retained_count=0 AND(SELECT count(*) FROM fi.sandboxes)=0 AS clean FROM fi_control.service_capacity',
          )
        ).rows[0]!.clean;
        assert.equal(cleanup, true);
        console.log('Capacity diagnostic cleanup: retained capacity and sandbox count zero.');
      } finally {
        await admin.end();
      }
    }
  }
});

type EpochResult = {
  status: number;
  replayed: boolean;
  body: Record<string, unknown>;
};

// Actions and retained data only; assertions remain visible in each test.
async function capacityEpochFixture() {
  const s = await fixture(),
    admin = await connection('admin'),
    reader = await connection('reconciler'),
    cfg = await verifyOwned(process.env.TF_DB_OWNER_FILE!),
    verification = new VerificationDatabase(cfg.reconcilerUrl!),
    sources = await Promise.all(
      ['fix_foundation_v2', 'fix_application_v2'].map((name) =>
        readFile('verification/sql/' + name + '.sql', 'utf8'),
      ),
    );
  let proof = s.proof,
    generation = 1;
  const fix = async (action: string, payload: Record<string, unknown>, key = randomUUID()) =>
    (
      await s.app.query<{ r: EpochResult }>(
        'SELECT fi_control.fix_command($1,$2,$3,$4,$5,$6,$7) r',
        [s.id, proof, generation, action, JSON.stringify(payload), key, s.actor],
      )
    ).rows[0]!.r;
  const rotate = async (expected = generation, retainAuthentication = true) => {
    const trade = digest(randomUUID()),
      args = [
        s.id,
        proof,
        generation,
        expected,
        digest(randomUUID()),
        trade,
        digest(randomUUID()),
        randomUUID(),
        s.actor,
      ],
      r = (
        await s.app.query<{ r: EpochResult }>(
          'SELECT fi_control.rotate_capabilities($1,$2,$3,$4,$5,$6,$7,$8,$9) r',
          args,
        )
      ).rows[0]!.r;
    if (r.status === 200 && retainAuthentication) {
      proof = trade;
      generation++;
    }
    return { r, args };
  };
  const assessments = async () => {
    const raw = [];
    for (const sql of sources)
      raw.push((await reader.query<Record<string, unknown>>(sql, [s.id])).rows[0]!);
    const combined = await verifyFixApplication(
      verification,
      { sandboxId: s.id, digest: proof, generation: String(generation), scope: 'trade' },
      () => {},
      true,
    );
    return { foundation: raw[0]!, application: raw[1]!, combined };
  };
  const epochs = async () =>
    (
      await admin.query<{
        binding_epoch: string | null;
        bind_audit_epoch: string | null;
        rotations: number;
        witnessed_rotations: number;
        active: number;
      }>(
        "WITH first_bind AS (SELECT e.recorded_at FROM fi.fix_commands c JOIN fi.fix_events e USING(sandbox_id,command_seq) WHERE c.sandbox_id=$1 AND c.operation='BIND' ORDER BY c.command_seq LIMIT 1)," +
          'epoch AS (SELECT min(created_at) binding_epoch FROM fi.fix_bindings WHERE sandbox_id=$1)' +
          ' SELECT to_char(binding_epoch AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') binding_epoch,' +
          '(SELECT to_char(recorded_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') FROM first_bind) bind_audit_epoch,' +
          "(SELECT count(*)::int FROM fi.commands WHERE sandbox_id=$1 AND operation='ROTATE_CAPABILITIES' AND created_at>=epoch.binding_epoch) rotations," +
          "(SELECT count(*)::int FROM fi.commands WHERE sandbox_id=$1 AND operation='ROTATE_CAPABILITIES' AND created_at>=(SELECT recorded_at FROM first_bind)) witnessed_rotations," +
          '(SELECT count(*)::int FROM fi_control.fix_reservations WHERE sandbox_id=$1 AND released_at IS NULL) active FROM epoch',
        [s.id],
      )
    ).rows[0]!;
  return {
    ...s,
    admin,
    reader,
    verification,
    fix,
    rotate,
    assessments,
    epochs,
    get proof() {
      return proof;
    },
    get generation() {
      return generation;
    },
    async close() {
      await s.app.query('ROLLBACK');
      await admin.query('ROLLBACK');
      await verification.close();
      await reader.end();
      await admin.end();
      await s.close();
    },
  };
}

void test('capacity epoch controls preserve healthy no-binding, no-rotation and prebinding rotation states', async () => {
  const c = await capacityEpochFixture();
  try {
    const empty = await c.assessments();
    for (const report of [empty.foundation, empty.application]) {
      assert.deepEqual(report['findings'], []);
      assert.equal(report['total_findings'], 0);
    }
    assert.equal(empty.combined.assessment, 'INCOMPLETE');
    assert.equal(empty.combined.financial_findings, 0);
    assert.equal((await c.rotate()).r.status, 200);
    const prebinding = await c.assessments();
    for (const report of [prebinding.foundation, prebinding.application]) {
      assert.deepEqual(report['findings'], []);
      assert.equal(report['total_findings'], 0);
    }
    assert.equal(prebinding.combined.assessment, 'INCOMPLETE');
    assert.equal(
      (await c.fix('BIND', { order_id: c.order, dealer_id: 'ATLAS', channel_id: c.channel }))
        .status,
      201,
    );
    const bound = await c.assessments(),
      epoch = await c.epochs();
    for (const report of [bound.foundation, bound.application]) {
      assert.deepEqual(report['findings'], []);
      assert.equal(report['total_findings'], 0);
    }
    assert.equal(bound.combined.assessment, 'INCOMPLETE');
    assert.equal(bound.combined.total_findings, 0);
    assert.equal(epoch.rotations, 0);
    assert.equal(epoch.witnessed_rotations, 0);
    assert.equal(epoch.active, 1);
    const helper = (
      await c.admin.query<{ security_headroom: number }>(
        'SELECT security_headroom FROM fi_control.fix_capacity_remaining($1)',
        [c.id],
      )
    ).rows[0]!;
    assert.equal(helper.security_headroom, 2);
  } finally {
    await c.close();
  }
});

void test('capacity epoch controls retain successful and rejected rotations, authenticated replays and saturated headroom', async () => {
  const c = await capacityEpochFixture();
  try {
    const unbound = await c.createOrder();
    assert.equal((await c.bind()).status, 201);
    const noRotation = await c.assessments();
    assert.deepEqual(noRotation.foundation['findings'], []);
    assert.deepEqual(noRotation.application['findings'], []);
    assert.equal(noRotation.combined.total_findings, 0);
    const successful = await c.rotate();
    assert.equal(successful.r.status, 200);
    assert.equal(successful.r.replayed, false);
    const afterSuccess = await recoveryState(c.admin, c.id),
      replayArgs = [...successful.args];
    // Rotation replay still requires current authorization before receipt lookup.
    replayArgs[1] = c.proof;
    replayArgs[2] = c.generation;
    const successReplay = (
      await c.app.query<{ r: EpochResult }>(
        'SELECT fi_control.rotate_capabilities($1,$2,$3,$4,$5,$6,$7,$8,$9) r',
        replayArgs,
      )
    ).rows[0]!.r;
    assert.equal(successReplay.status, 200);
    assert.equal(successReplay.replayed, true);
    assert.deepEqual(successReplay.body, successful.r.body);
    assert.deepEqual(await recoveryState(c.admin, c.id), afterSuccess);
    // A retained ordinary financial rejection is spending, never a rotation.
    const payload = { order_id: unbound, expected_version: '999' },
      ordinary = (
        await c.app.query<{ r: EpochResult }>(
          'SELECT fi_control.order_command($1,$2,$3,$4,$5,$6,$7,$8) r',
          [
            c.id,
            c.proof,
            c.generation,
            'ACK_ORDER',
            JSON.stringify(payload),
            digest(JSON.stringify({ action: 'ACK_ORDER', payload })),
            randomUUID(),
            c.actor,
          ],
        )
      ).rows[0]!.r;
    assert.equal(ordinary.status, 409);
    assert.equal(
      (ordinary.body['error'] as Record<string, unknown>)['code'],
      'ORDER_VERSION_CONFLICT',
    );
    const afterOrdinary = await recoveryState(c.admin, c.id);
    assert.equal(afterOrdinary['fi.commands']!.length, afterSuccess['fi.commands']!.length + 1);
    assert.equal(
      afterOrdinary['fi.audit_events']!.length,
      afterSuccess['fi.audit_events']!.length + 1,
    );
    assert.deepEqual(afterOrdinary['fi.order_states'], afterSuccess['fi.order_states']);
    assert.equal((await c.epochs()).rotations, 1);
    const ordinaryReports = await c.assessments();
    assert.deepEqual(ordinaryReports.foundation['findings'], []);
    assert.deepEqual(ordinaryReports.application['findings'], []);
    assert.equal(ordinaryReports.combined.total_findings, 0);
    assert.equal(ordinaryReports.combined.financial_findings, 0);
    const rejected = await c.rotate(999);
    assert.equal(rejected.r.status, 409);
    assert.deepEqual(rejected.r.body, {
      error: {
        code: 'GENERATION_CONFLICT',
        message: 'The fixed-income workflow request could not be completed.',
      },
    });
    const afterRejected = await recoveryState(c.admin, c.id),
      rejectReplay = (
        await c.app.query<{ r: EpochResult }>(
          'SELECT fi_control.rotate_capabilities($1,$2,$3,$4,$5,$6,$7,$8,$9) r',
          rejected.args,
        )
      ).rows[0]!.r;
    assert.equal(rejectReplay.status, 409);
    assert.equal(rejectReplay.replayed, true);
    assert.deepEqual(rejectReplay.body, rejected.r.body);
    assert.deepEqual(await recoveryState(c.admin, c.id), afterRejected);
    assert.equal((await c.rotate()).r.status, 200);
    const epoch = await c.epochs(),
      reports = await c.assessments(),
      rotations = (
        await c.admin.query<{ result_kind: string; http_status: number; event_type: string }>(
          "SELECT c.result_kind,c.http_status,e.event_type FROM fi.commands c JOIN fi.audit_events e ON(e.sandbox_id,e.command_id,e.command_seq)=(c.sandbox_id,c.id,c.command_seq) WHERE c.sandbox_id=$1 AND c.operation='ROTATE_CAPABILITIES' ORDER BY c.command_seq",
          [c.id],
        )
      ).rows;
    assert.deepEqual(rotations, [
      { result_kind: 'APPLIED', http_status: 200, event_type: 'CAPABILITIES_ROTATED' },
      { result_kind: 'REJECTED', http_status: 409, event_type: 'COMMAND_REJECTED' },
      { result_kind: 'APPLIED', http_status: 200, event_type: 'CAPABILITIES_ROTATED' },
    ]);
    assert.equal(epoch.rotations, 3);
    assert.equal(epoch.witnessed_rotations, 3);
    const helper = (
      await c.admin.query<{ security_headroom: number }>(
        'SELECT security_headroom FROM fi_control.fix_capacity_remaining($1)',
        [c.id],
      )
    ).rows[0]!;
    assert.equal(helper.security_headroom, 0);
    for (const report of [reports.foundation, reports.application]) {
      assert.deepEqual(report['findings'], []);
      assert.equal(report['total_findings'], 0);
    }
    assert.equal(reports.combined.assessment, 'INCOMPLETE');
    assert.equal(reports.combined.total_findings, 0);
    assert.equal(reports.combined.financial_findings, 0);
  } finally {
    await c.close();
  }
});

void test('capacity epoch controls ignore a rolled-back rotation and preserve the original authenticated graph', async () => {
  const c = await capacityEpochFixture();
  try {
    assert.equal((await c.bind()).status, 201);
    const before = await recoveryState(c.admin, c.id);
    await c.app.query('BEGIN');
    try {
      const transient = await c.rotate(c.generation, false);
      assert.equal(transient.r.status, 200);
      assert.equal(
        (
          await c.app.query<{ count: number }>(
            "SELECT count(*)::int count FROM fi.commands WHERE sandbox_id=$1 AND operation='ROTATE_CAPABILITIES'",
            [c.id],
          )
        ).rows[0]!.count,
        1,
      );
    } finally {
      await c.app.query('ROLLBACK');
    }
    assert.equal(c.generation, 1);
    assert.deepEqual(await recoveryState(c.admin, c.id), before);
    const epoch = await c.epochs(),
      reports = await c.assessments();
    assert.equal(epoch.rotations, 0);
    assert.equal(epoch.witnessed_rotations, 0);
    for (const report of [reports.foundation, reports.application]) {
      assert.deepEqual(report['findings'], []);
      assert.equal(report['total_findings'], 0);
    }
    assert.equal(reports.combined.total_findings, 0);
    assert.equal(reports.combined.financial_findings, 0);
    assert.deepEqual(await recoveryState(c.admin, c.id), before);
  } finally {
    await c.close();
  }
});

void test('capacity epoch controls retain the first lifetime BIND through earliest/all RELEASE and a later binding', async () => {
  const c = await capacityEpochFixture();
  try {
    const second = await c.createOrder(),
      later = await c.createOrder();
    assert.equal((await c.bind()).status, 201);
    const first = await c.epochs();
    assert.equal((await c.rotate()).r.status, 200);
    assert.equal(
      (await c.fix('BIND', { order_id: second, dealer_id: 'ATLAS', channel_id: randomUUID() }))
        .status,
      201,
    );
    assert.equal((await c.fix('RELEASE', { order_id: c.order })).status, 200);
    const afterEarliest = await c.epochs(),
      earliestReports = await c.assessments();
    assert.equal(afterEarliest.binding_epoch, first.binding_epoch);
    assert.equal(afterEarliest.bind_audit_epoch, first.bind_audit_epoch);
    assert.equal(afterEarliest.active, 1);
    assert.equal(afterEarliest.rotations, 1);
    for (const report of [earliestReports.foundation, earliestReports.application])
      assert.deepEqual(report['findings'], []);
    assert.equal(earliestReports.combined.total_findings, 0);
    assert.equal((await c.fix('RELEASE', { order_id: second })).status, 200);
    const afterAll = await c.epochs(),
      allReports = await c.assessments();
    assert.equal(afterAll.binding_epoch, first.binding_epoch);
    assert.equal(afterAll.bind_audit_epoch, first.bind_audit_epoch);
    assert.equal(afterAll.active, 0);
    assert.equal(afterAll.rotations, 1);
    for (const report of [allReports.foundation, allReports.application])
      assert.deepEqual(report['findings'], []);
    assert.equal(allReports.combined.total_findings, 0);
    assert.equal(
      (await c.fix('BIND', { order_id: later, dealer_id: 'ATLAS', channel_id: randomUUID() }))
        .status,
      201,
    );
    const afterLater = await c.epochs(),
      laterReports = await c.assessments();
    assert.equal(afterLater.binding_epoch, first.binding_epoch);
    assert.equal(afterLater.bind_audit_epoch, first.bind_audit_epoch);
    assert.equal(afterLater.active, 1);
    assert.equal(afterLater.rotations, 1);
    assert.equal(afterLater.witnessed_rotations, 1);
    for (const report of [laterReports.foundation, laterReports.application]) {
      assert.deepEqual(report['findings'], []);
      assert.equal(report['total_findings'], 0);
    }
    assert.equal(laterReports.combined.total_findings, 0);
    const retained = await recoveryState(c.admin, c.id);
    assert.equal(retained['fi.fix_bindings']!.length, 3);
    assert.equal(
      retained['fi_control.fix_reservations']!.filter((r) => r['released_at'] !== null).length,
      2,
    );
    const helper = (
      await c.admin.query<{ security_headroom: number }>(
        'SELECT security_headroom FROM fi_control.fix_capacity_remaining($1)',
        [c.id],
      )
    ).rows[0]!;
    assert.equal(helper.security_headroom, 1);
  } finally {
    await c.close();
  }
});

void test('retained rotation audit detects a backdated capacity epoch that spends a prebinding rotation allowance', async () => {
  const c = await capacityEpochFixture();
  try {
    assert.equal((await c.rotate()).r.status, 200);
    assert.equal(
      (await c.fix('BIND', { order_id: c.order, dealer_id: 'ATLAS', channel_id: c.channel }))
        .status,
      201,
    );
    const before = await recoveryState(c.admin, c.id),
      beforeEpoch = await c.epochs(),
      healthy = await c.assessments(),
      strict = (
        await c.admin.query<{ before_binding: boolean }>(
          "SELECT e.recorded_at<(SELECT e.recorded_at FROM fi.fix_commands c JOIN fi.fix_events e USING(sandbox_id,command_seq) WHERE c.sandbox_id=$1 AND c.operation='BIND' ORDER BY c.command_seq LIMIT 1) before_binding FROM fi.commands c JOIN fi.audit_events e ON(e.sandbox_id,e.command_id,e.command_seq)=(c.sandbox_id,c.id,c.command_seq) WHERE c.sandbox_id=$1 AND c.operation='ROTATE_CAPABILITIES'",
          [c.id],
        )
      ).rows[0]!;
    assert.equal(strict.before_binding, true);
    assert.equal(beforeEpoch.rotations, 0);
    assert.equal(beforeEpoch.witnessed_rotations, 0);
    for (const report of [healthy.foundation, healthy.application]) {
      assert.deepEqual(report['findings'], []);
      assert.equal(report['total_findings'], 0);
    }
    assert.equal(healthy.combined.assessment, 'INCOMPLETE');
    assert.equal(healthy.combined.financial_findings, 0);
    const beforeHelper = (
      await c.admin.query<{ commands: number; events: number; security_headroom: number }>(
        'SELECT * FROM fi_control.fix_capacity_remaining($1)',
        [c.id],
      )
    ).rows[0]!;
    assert.deepEqual(beforeHelper, { commands: 25, events: 43, security_headroom: 2 });
    await c.admin.query('BEGIN');
    try {
      await c.admin.query("SET LOCAL session_replication_role='replica'");
      await c.admin.query(
        "UPDATE fi.fix_bindings b SET created_at=c.created_at-interval '1 microsecond' FROM fi.commands c WHERE b.sandbox_id=$1 AND c.sandbox_id=b.sandbox_id AND c.operation='ROTATE_CAPABILITIES'",
        [c.id],
      );
      await c.admin.query('COMMIT');
    } catch (error) {
      await c.admin.query('ROLLBACK');
      throw error;
    }
    const after = await recoveryState(c.admin, c.id),
      afterEpoch = await c.epochs(),
      corrupted = await c.assessments(),
      afterHelper = (
        await c.admin.query<{ commands: number; events: number; security_headroom: number }>(
          'SELECT * FROM fi_control.fix_capacity_remaining($1)',
          [c.id],
        )
      ).rows[0]!;
    assert.equal(afterEpoch.rotations, 1);
    assert.equal(afterEpoch.witnessed_rotations, 0);
    assert.equal(afterEpoch.bind_audit_epoch, beforeEpoch.bind_audit_epoch);
    assert.deepEqual(afterHelper, { commands: 25, events: 43, security_headroom: 1 });
    for (const table of recoveryTables)
      if (table !== 'fi.fix_bindings') assert.deepEqual(after[table], before[table], table);
    assert.deepEqual(after['financial_counters'], before['financial_counters']);
    const withoutTime = (rows: Record<string, unknown>[]) =>
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(([key]) => !['created_at', '_exact_row'].includes(key)),
        ),
      );
    assert.deepEqual(
      withoutTime(after['fi.fix_bindings']!),
      withoutTime(before['fi.fix_bindings']!),
    );
    const expected = [{ code: 'CAPACITY_EPOCH_PROVENANCE', record_id: c.id }];
    for (const report of [corrupted.foundation, corrupted.application]) {
      assert.deepEqual(report['findings'], expected);
      assert.equal(report['total_findings'], 1);
    }
    assert.deepEqual(corrupted.combined.findings, expected);
    assert.deepEqual(corrupted.combined.foundation_coverage.findings, expected);
    assert.equal(corrupted.combined.total_findings, 1);
    assert.equal(corrupted.combined.assessment, 'APPLICATION_FINDINGS');
    assert.equal(corrupted.combined.financial_findings, 0);
    assert.equal(
      corrupted.combined.snapshot_id,
      corrupted.combined.foundation_coverage.snapshot_id,
    );
    const watermarks = (report: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(report).filter(([key]) => key.endsWith('_watermark')));
    const repeated = await c.assessments();
    for (const name of ['foundation', 'application', 'combined'] as const) {
      assert.deepEqual(watermarks(corrupted[name]), watermarks(healthy[name]), name);
      assert.deepEqual(repeated[name]['findings'], corrupted[name]['findings'], name);
      assert.deepEqual(watermarks(repeated[name]), watermarks(corrupted[name]), name);
    }
    assert.deepEqual(await recoveryState(c.admin, c.id), after);
    await mkdir('.local/verification', { recursive: true });
    await writeFile(
      '.local/verification/capacity-epoch-backdated-' + randomUUID() + '.json',
      JSON.stringify(
        {
          scenario:
            'Backdated binding includes a prebinding rotation contradicted by its exact retained audit',
          sandbox: c.id,
          beforeEpoch,
          afterEpoch,
          beforeHelper,
          afterHelper,
          healthy,
          corrupted,
          allFinancialAndOtherProtocolRowsUnchanged: true,
        },
        null,
        2,
      ),
      { mode: 0o600, flag: 'wx' },
    );
  } finally {
    await c.close();
  }
});

void test('capacity epoch touching timestamps remain an explicitly ambiguous boundary rather than a strict contradiction', async () => {
  const c = await capacityEpochFixture();
  try {
    assert.equal((await c.rotate()).r.status, 200);
    assert.equal(
      (await c.fix('BIND', { order_id: c.order, dealer_id: 'ATLAS', channel_id: c.channel }))
        .status,
      201,
    );
    const before = await recoveryState(c.admin, c.id);
    await c.admin.query('BEGIN');
    try {
      await c.admin.query("SET LOCAL session_replication_role='replica'");
      await c.admin.query(
        "UPDATE fi.fix_bindings b SET created_at=c.created_at FROM fi.commands c WHERE b.sandbox_id=$1 AND c.sandbox_id=b.sandbox_id AND c.operation='ROTATE_CAPABILITIES'",
        [c.id],
      );
      await c.admin.query('COMMIT');
    } catch (error) {
      await c.admin.query('ROLLBACK');
      throw error;
    }
    // Deliberate equality-boundary fixture, not a claim of provable historical order.
    const reports = await c.assessments();
    assert.deepEqual(reports.foundation['findings'], []);
    assert.deepEqual(reports.application['findings'], []);
    assert.equal(reports.combined.total_findings, 0);
    assert.equal(reports.combined.assessment, 'INCOMPLETE');
    const after = await recoveryState(c.admin, c.id);
    for (const table of recoveryTables)
      if (table !== 'fi.fix_bindings') assert.deepEqual(after[table], before[table], table);
    assert.deepEqual(after['financial_counters'], before['financial_counters']);
    const epoch = await c.epochs();
    assert.equal(epoch.rotations, 1); // Inclusive writer policy is intentionally unchanged.
    assert.equal(epoch.witnessed_rotations, 0);
  } finally {
    await c.close();
  }
});

for (const missing of ['bind-audit', 'rotation-audit'] as const)
  void test('capacity epoch requires its exact retained ' + missing + ' witness', async () => {
    const c = await capacityEpochFixture();
    try {
      assert.equal((await c.bind()).status, 201);
      assert.equal((await c.rotate()).r.status, 200);
      const healthy = await c.assessments();
      assert.deepEqual(healthy.foundation['findings'], []);
      assert.deepEqual(healthy.application['findings'], []);
      await c.admin.query('BEGIN');
      try {
        await c.admin.query("SET LOCAL session_replication_role='replica'");
        if (missing === 'bind-audit')
          await c.admin.query(
            "DELETE FROM fi.fix_events WHERE sandbox_id=$1 AND event_type='BIND'",
            [c.id],
          );
        else
          await c.admin.query(
            "DELETE FROM fi.audit_events e USING fi.commands c WHERE (e.sandbox_id,e.command_id,e.command_seq)=(c.sandbox_id,c.id,c.command_seq) AND c.sandbox_id=$1 AND c.operation='ROTATE_CAPABILITIES'",
            [c.id],
          );
        await c.admin.query('COMMIT');
      } catch (error) {
        await c.admin.query('ROLLBACK');
        throw error;
      }
      const corrupted = await c.assessments();
      for (const result of [corrupted.foundation, corrupted.application])
        assert.ok(
          (result['findings'] as { code: string; record_id: string }[]).some(
            (f) => f.code === 'CAPACITY_EPOCH_PROVENANCE' && f.record_id === c.id,
          ),
        );
      assert.equal(corrupted.combined.assessment, 'APPLICATION_FINDINGS');
      assert.ok(
        corrupted.combined.foundation_coverage.findings.some(
          (f) => f.code === 'CAPACITY_EPOCH_PROVENANCE' && f.record_id === c.id,
        ),
      );
    } finally {
      await c.close();
    }
  });

void test('capacity epoch sources remain bounded on the maximum admitted 1024-receipt wire graph', async () => {
  const c = await capacityEpochFixture();
  try {
    const orders = [c.order];
    for (let i = 0; i < 3; i++) orders.push(await c.createOrder());
    for (const order of orders) {
      assert.equal(
        (await c.fix('BIND', { order_id: order, dealer_id: 'ATLAS', channel_id: randomUUID() }))
          .status,
        201,
      );
      for (let sequence = 1; sequence <= 40; sequence++) {
        const fields = await report({ ...c, order }, { '34': String(sequence) }),
          raw = encodeFix44(fields).toString('hex');
        for (let observation = 0; observation < 4; observation++) {
          const recorded = await c.fix('RECORD', {
            order_id: order,
            attempt_id: randomUUID(),
            raw_hex: raw,
          });
          assert.equal(recorded.status, 201);
          assert.equal(recorded.body['logical_duplicate'], observation > 0);
          assert.equal(recorded.body['physical_duplicate'], false);
          assert.equal(recorded.body['financial_applied'], false);
        }
      }
    }
    const owner = randomUUID();
    for (let fence = 1; fence <= 380; fence++) {
      const claimed = await c.fix('CLAIM', { order_id: c.order, owner_id: owner });
      assert.equal(claimed.status, 200);
      assert.equal(claimed.body['fence'], String(fence));
    }
    // Reach the financial command ceiling permitted by four outstanding reservations.
    // Real successful rotation receipts exercise the bounded provenance scan.
    for (let i = 0; i < 399; i++) assert.equal((await c.rotate()).r.status, 200);
    const before = await recoveryState(c.admin, c.id);
    assert.equal(before['fi.fix_bindings']!.length, 4);
    assert.equal(before['fi.fix_messages']!.length, 160);
    assert.equal(before['fi.fix_attempts']!.length, 640);
    assert.equal(before['fi.fix_sequence_slots']!.length, 160);
    assert.equal(before['fi.fix_commands']!.length, 1024);
    assert.equal(before['fi.fix_events']!.length, 1024);
    assert.equal(before['fi.commands']!.length, 412);
    const binding = {
      sandboxId: c.id,
      digest: c.proof,
      generation: String(c.generation),
      scope: 'trade' as const,
    };
    const start = performance.now();
    const foundation = await verifyFixFoundation(c.verification, binding, () => {}, true);
    const foundationMs = performance.now() - start;
    const applicationStart = performance.now();
    const application = await verifyFixApplication(c.verification, binding, () => {}, true);
    const applicationMs = performance.now() - applicationStart;
    assert.deepEqual(foundation.findings, []);
    assert.equal(foundation.foundation_assessment, 'FOUNDATION_CONSISTENT');
    assert.deepEqual(application.findings, []);
    assert.deepEqual(application.foundation_coverage.findings, []);
    assert.equal(application.financial_findings, 0);
    assert.equal(application.assessment, 'INCOMPLETE');
    assert.equal(application.observed_transcript_complete, false);
    assert.equal(application.financial_application_verified, false);
    assert.equal(application.delivery_verified, false);
    assert.equal(application.snapshot_id, application.foundation_coverage.snapshot_id);
    assert.deepEqual(await recoveryState(c.admin, c.id), before);
    console.log(
      'Capacity epoch maximum graph:',
      JSON.stringify({
        bindings: 4,
        messages: 160,
        attempts: 640,
        receipts: 1024,
        rotations: 399,
        financialReceipts: 412,
        foundationMs,
        applicationMs,
        unchangedVerifierLimits: true,
      }),
    );
  } finally {
    await c.close();
  }
});
