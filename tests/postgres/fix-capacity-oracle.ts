import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Binding } from '../../app/server/fixed-income-workflow/bindings.js';
import { VerificationDatabase } from '../../app/server/reconciliation/database.js';
import { verifyFixApplication } from '../../app/server/fix/application-reconciliation.js';
import { verifyOwned } from '../../scripts/owned-postgres.js';
import { recoveryState } from './fix-application-recovery-support.js';

const expectedEvents: Record<string, string[]> = {
  ACK_ORDER: ['ORDER_ACKNOWLEDGED'],
  REJECT_ORDER: ['ORDER_REJECTED'],
  EXECUTE_ORDER: ['EXECUTION_RECORDED', 'ORDER_STATE_CHANGED', 'POSITION_UPDATED'],
  REQUEST_CANCEL: ['CANCEL_REQUESTED'],
  ACK_CANCEL: ['CANCEL_ACKNOWLEDGED'],
  REJECT_CANCEL: ['CANCEL_REJECTED'],
};
function micros(value: unknown) {
  assert.equal(typeof value, 'string');
  const text = String(value),
    ms = Date.parse(text);
  assert.ok(Number.isFinite(ms), 'Retained timestamp must be finite.');
  const fraction = /[.](\d{1,6})/.exec(text)?.[1]?.padEnd(6, '0') ?? '000000';
  return BigInt(ms) * 1000n + BigInt(fraction.slice(3));
}
// Expected accounting comes from committed row identities and independent
// arithmetic, never capacity_remaining(), admission SQL, or verifier findings.
// Call with an idle observer; recoveryState owns one read-only snapshot.
export async function capacityEvidence(admin: pg.Client, id: string) {
  const state = await recoveryState(admin, id),
    commands = state['fi.commands']!,
    audits = state['fi.audit_events']!,
    applications = state['fi.fix_applications']!,
    consumptions = state['fi.fix_consumptions']!,
    prepared = state['fi.fix_prepared']!,
    keys = state['fi_control.command_keys']!,
    reservations = state['fi_control.fix_reservations']!,
    bindings = state['fi.fix_bindings']!,
    receipts = state['fi.fix_commands']!,
    events = state['fi.fix_events']!,
    counters = state['financial_counters']![0]!;
  const C = commands.length,
    E = audits.length;
  assert.equal(counters['command_count'], C);
  assert.equal(counters['event_count'], E);
  assert.equal(Number(counters['commit_seq']), C);
  assert.equal(applications.length, consumptions.length);
  assert.equal(new Set(applications.map((a) => a['work_id'])).size, applications.length);
  for (const x of consumptions) {
    const matches = applications.filter((a) => a['work_id'] === x['work_id']);
    assert.equal(matches.length, 1);
    const a = matches[0]!,
      p = prepared.find((p) => p['work_id'] === x['work_id']);
    assert.ok(p);
    const c = commands.find((c) => c['id'] === a['financial_command_id']);
    assert.ok(c);
    const operation = String(p['operation']),
      payload = p['payload'] as Record<string, string>;
    assert.ok(
      expectedEvents[operation],
      'Only six documented financial operations consume reservations.',
    );
    assert.equal(a['order_id'], x['order_id']);
    assert.equal(a['order_id'], p['order_id']);
    assert.equal(c['idempotency_key'], p['financial_key']);
    assert.equal(a['financial_key'], p['financial_key']);
    assert.equal(c['operation'], operation);
    assert.equal(c['result_kind'], 'APPLIED');
    assert.equal(c['command_seq'], a['financial_command_seq']);
    assert.equal(c['request_hash'], a['financial_request_hash']);
    const request: Record<string, string> = {
      order_id: payload['order_id']!,
      expected_version: payload['expected_version']!,
    };
    if (operation === 'EXECUTE_ORDER')
      for (const field of ['execution_id', 'source_event_id', 'par_amount'])
        request[field] = payload[field]!;
    if (['REQUEST_CANCEL', 'ACK_CANCEL', 'REJECT_CANCEL'].includes(operation))
      request['cancel_id'] = payload['cancel_id']!;
    assert.equal(
      c['request_hash'],
      createHash('sha256')
        .update(
          JSON.stringify({
            version: 1,
            method: 'POST',
            operation,
            sandbox_id: id,
            payload: request,
          }),
        )
        .digest('hex'),
    );
    assert.equal(
      p['request_hash'],
      createHash('sha256').update(String(p['_payload_text'])).digest('hex'),
    );
    const economicEvents = audits.filter((e) => e['command_id'] === c['id']);
    assert.deepEqual(
      economicEvents.map((e) => e['event_type']).sort(),
      [...expectedEvents[operation]].sort(),
    );
    for (const e of economicEvents) assert.equal(e['command_seq'], c['command_seq']);
    const history = state['fi.order_history']!.filter((h) => h['command_id'] === c['id']);
    assert.equal(history.length, 1);
    assert.equal(history[0]!['operation'], operation);
    assert.equal(Number(history[0]!['version']), Number(payload['expected_version']) + 1);
    assert.equal(x['commands'], 1);
    assert.equal(x['events'], economicEvents.length);
    assert.equal(
      keys.find((k) => k['idempotency_key'] === p['financial_key'])!['domain'],
      'FINANCIAL',
    );
    const pc = receipts.find((c) => c['command_seq'] === a['protocol_command_seq']);
    assert.ok(pc);
    assert.equal(pc['operation'], 'APPLY');
    assert.equal(pc['http_status'], 200);
    assert.deepEqual(pc['response_body'], a['result']);
    assert.equal(
      keys.find((k) => k['idempotency_key'] === pc['idempotency_key'])!['domain'],
      'FIX',
    );
    const protocolEvents = events.filter((e) => e['command_seq'] === pc['command_seq']);
    assert.equal(protocolEvents.length, 1);
    assert.equal(protocolEvents[0]!['event_type'], 'APPLY');
    assert.deepEqual(protocolEvents[0]!['payload'], {
      financial_applied: true,
      record: pc['response_body'],
    });
    const work = state['fi.fix_work']!.find((w) => w['id'] === p['work_id']);
    assert.ok(work);
    assert.equal(work['message_id'], a['message_id']);
    assert.equal(work['order_id'], a['order_id']);
    if (operation === 'EXECUTE_ORDER') {
      const execution = state['fi.executions']!.filter((e) => e['command_id'] === c['id']);
      assert.equal(execution.length, 1);
      assert.equal(execution[0]!['id'], payload['execution_id']);
      assert.equal(execution[0]!['source_event_id'], payload['source_event_id']);
      assert.equal(execution[0]!['order_id'], a['order_id']);
    }
    if (operation === 'REQUEST_CANCEL')
      assert.equal(
        state['fi.cancellation_requests']!.filter(
          (e) => e['command_id'] === c['id'] && e['id'] === payload['cancel_id'],
        ).length,
        1,
      );
    if (['ACK_CANCEL', 'REJECT_CANCEL'].includes(operation))
      assert.equal(
        state['fi.cancellation_outcomes']!.filter(
          (e) => e['command_id'] === c['id'] && e['cancel_id'] === payload['cancel_id'],
        ).length,
        1,
      );
  }
  assert.equal(state['fi_control.fix_apply_context']!.length, 0);
  assert.equal(reservations.length, bindings.length);
  const witness: { seq: number; time: bigint }[] = [];
  for (const b of bindings) {
    const candidates = receipts.filter(
      (c) =>
        c['operation'] === 'BIND' &&
        (c['response_body'] as Record<string, unknown>)['order_id'] === b['order_id'],
    );
    assert.equal(candidates.length, 1);
    const c = candidates[0]!;
    assert.equal(c['http_status'], 201);
    assert.deepEqual(c['response_body'], {
      order_id: b['order_id'],
      cl_ord_id: b['order_id'],
      dealer_order_id: null,
      reserved_commands: 25,
      reserved_events: 43,
      financial_applied: false,
    });
    const expectedHash = (
      await admin.query<{ hash: string }>(
        "SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') hash",
        [
          JSON.stringify({
            version: 1,
            sandbox: id,
            operation: 'BIND',
            payload: {
              order_id: b['order_id'],
              dealer_id: b['dealer_id'],
              channel_id: b['channel_id'],
            },
          }),
        ],
      )
    ).rows[0]!.hash;
    assert.equal(c['request_hash'], expectedHash);
    const matchingEvents = events.filter((e) => e['command_seq'] === c['command_seq']);
    assert.equal(matchingEvents.length, 1);
    const e = matchingEvents[0]!;
    assert.equal(e['event_index'], 0);
    assert.equal(e['event_type'], 'BIND');
    assert.equal(e['order_id'], b['order_id']);
    assert.deepEqual(e['payload'], { financial_applied: false, record: c['response_body'] });
    witness.push({ seq: Number(c['command_seq']), time: micros(e['recorded_at']) });
    const rs = reservations.filter((r) => r['order_id'] === b['order_id']);
    assert.equal(rs.length, 1);
    assert.equal(rs[0]!['commands'], 25);
    assert.equal(rs[0]!['events'], 43);
  }
  const active = reservations.filter((r) => r['released_at'] === null);
  let R = 0,
    S = 0;
  for (const r of reservations) {
    const consumed = consumptions.filter((x) => x['order_id'] === r['order_id']),
      remainingCommands = 25 - consumed.reduce((n, x) => n + Number(x['commands']), 0),
      remainingEvents = 43 - consumed.reduce((n, x) => n + Number(x['events']), 0);
    assert.ok(remainingCommands >= 0 && remainingCommands <= 25);
    assert.ok(remainingEvents >= 2 && remainingEvents <= 43);
    if (r['released_at'] === null) {
      R += remainingCommands;
      S += remainingEvents;
    } else assert.equal(consumed.length, 0, 'Only pristine bindings can RELEASE.');
  }
  const storedEpoch = bindings.length
      ? bindings.map((b) => micros(b['created_at'])).reduce((a, b) => (a < b ? a : b))
      : null,
    auditEpoch = witness.sort((a, b) => a.seq - b.seq)[0]?.time ?? null,
    rotations = commands.filter((c) => c['operation'] === 'ROTATE_CAPABILITIES');
  let N = 0,
    definiteAuditN = 0,
    ambiguousRotations = 0;
  for (const c of rotations) {
    const es = audits.filter((e) => e['command_id'] === c['id']);
    assert.equal(es.length, 1);
    const e = es[0]!;
    assert.equal(e['command_seq'], c['command_seq']);
    assert.equal(e['event_index'], 0);
    if (c['result_kind'] === 'APPLIED') {
      const sandbox = (c['response_body'] as Record<string, unknown>)['sandbox'] as Record<
        string,
        unknown
      >;
      assert.equal(e['event_type'], 'CAPABILITIES_ROTATED');
      assert.equal(String(e['aggregate_version']), sandbox['generation']);
      assert.deepEqual(e['payload'], { generation: sandbox['generation'] });
    } else {
      const error = (c['response_body'] as Record<string, unknown>)['error'] as Record<
        string,
        unknown
      >;
      assert.equal(e['event_type'], 'COMMAND_REJECTED');
      assert.ok(
        ['GENERATION_CONFLICT', 'CAPABILITY_REUSE', 'GENERATION_LIMIT_REACHED'].includes(
          String(error['code']),
        ),
      );
      assert.deepEqual(e['payload'], { code: error['code'] });
    }
    if (storedEpoch !== null && auditEpoch !== null) {
      const Ctime = micros(c['created_at']),
        Dtime = micros(e['decided_at']),
        Rtime = micros(e['recorded_at']);
      assert.ok(Dtime <= Rtime && Rtime <= Ctime);
      const storedMember = Ctime >= storedEpoch;
      if (storedMember) N++;
      if (Ctime === storedEpoch || (Dtime <= auditEpoch && Rtime >= auditEpoch))
        ambiguousRotations++;
      else if (Dtime > auditEpoch) {
        definiteAuditN++;
        assert.equal(storedMember, true, 'Post-BIND audit evidence must agree with stored epoch.');
      } else {
        assert.ok(Rtime < auditEpoch);
        assert.equal(storedMember, false, 'Pre-BIND audit evidence must agree with stored epoch.');
      }
    }
  }
  if (ambiguousRotations === 0) assert.equal(N, definiteAuditN);
  return {
    C,
    E,
    R,
    S,
    N,
    H: Math.max(2 - N, 0),
    state,
    bindings: bindings.length,
    active: active.length,
    auditN: ambiguousRotations ? null : definiteAuditN,
    ambiguousRotations,
  };
}
export async function assertCleanCapacity(admin: pg.Client, binding: Binding) {
  await capacityEvidence(admin, binding.sandboxId);
  const cfg = await verifyOwned(process.env.TF_DB_OWNER_FILE!),
    database = new VerificationDatabase(cfg.reconcilerUrl!);
  try {
    const report = await verifyFixApplication(database, binding, () => {}, true);
    assert.deepEqual(report.findings, []);
    assert.equal(report.total_findings, 0);
    assert.deepEqual(report.foundation_coverage.findings, []);
    assert.equal(report.foundation_coverage.total_findings, 0);
    assert.equal(report.financial_findings, 0);
    assert.equal(report.financial_coverage.length, 4);
    for (const layer of report.financial_coverage) assert.equal(layer.findings, 0);
    assert.equal(report.snapshot_id, report.foundation_coverage.snapshot_id);
    assert.equal(report.physical_schema_revision, 8);
    assert.equal(report.profile, 'fix-application-v2');
    assert.equal(report.delivery_verified, false);
    assert.equal(report.external_completeness_verified, false);
    const complete = report.applied_work_count > 0 && report.unresolved_message_count === 0;
    assert.equal(report.assessment, complete ? 'OBSERVED_APPLICATION_CONSISTENT' : 'INCOMPLETE');
    assert.equal(report.financial_application_verified, complete);
    return report;
  } finally {
    await database.close();
  }
}
