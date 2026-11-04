import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { applicationFixture } from './fix-application-fixture.js';
import { connection } from './harness.js';
void test('independent application SQL links FIX report, original key, kernel effect and actual execution cash without a delivery claim', async () => {
  const s = await applicationFixture();
  const db = await connection('reconciler'),
    admin = await connection('admin');
  try {
    await s.apply((await s.prepare()).work);
    const px = (
      await s.app.query<{ contract: Record<string, string> }>(
        'SELECT contract FROM fi.orders WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.contract['clean_price']!;
    const f = await s.prepare({
      '150': 'F',
      '39': '2',
      '14': '100.00',
      '151': '0.00',
      '32': '100.00',
      '31': px,
      '6': px,
    });
    await s.apply(f.work);
    const sql = await readFile('verification/sql/fix_application.sql', 'utf8');
    const before = (
      await db.query<{ total_findings: number; delivery_verified: boolean; profile: string }>(sql, [
        s.id,
      ])
    ).rows[0]!;
    assert.equal(before.total_findings, 0);
    assert.equal(before.profile, 'fix-application-v1');
    assert.equal(before.delivery_verified, false);
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      "UPDATE fi.fix_messages SET source_event_id=gen_random_uuid() WHERE sandbox_id=$1 AND fields->>'150'='F'",
      [s.id],
    );
    await admin.query('COMMIT');
    const broken = (
      await db.query<{ total_findings: number; findings: { code: string }[] }>(sql, [s.id])
    ).rows[0]!;
    assert.ok(broken.total_findings > 0);
    assert.ok(broken.findings.some((x) => x.code === 'EXECUTION_CORRELATION'));
  } finally {
    await db.end();
    await admin.end();
    await s.close();
  }
});
for (const mutation of [
  {
    sql: "UPDATE fi.fix_applications SET financial_request_hash=repeat('a',64) WHERE sandbox_id=$1",
    code: 'FINANCIAL_FINGERPRINT',
  },
  {
    sql: 'UPDATE fi.fix_consumptions SET events=3 WHERE sandbox_id=$1',
    code: 'APPLICATION_CAPACITY',
  },
  {
    sql: "UPDATE fi_control.command_keys SET domain='FIX_PREPARED' WHERE sandbox_id=$1 AND domain='FINANCIAL' AND idempotency_key IN (SELECT financial_key FROM fi.fix_prepared WHERE sandbox_id=$1)",
    code: 'PREPARED_FINGERPRINT',
  },
  {
    sql: "UPDATE fi.fix_events SET payload='{}' WHERE sandbox_id=$1 AND event_type='APPLY'",
    code: 'AUDIT_CORRESPONDENCE',
  },
])
  void test(`independent application SQL detects controlled ${mutation.code} defect without trusting application projections`, async () => {
    const s = await applicationFixture(),
      admin = await connection('admin'),
      db = await connection('reconciler');
    try {
      await s.apply((await s.prepare()).work);
      const sql = await readFile('verification/sql/fix_application.sql', 'utf8');
      assert.equal(
        (await db.query<{ total_findings: number }>(sql, [s.id])).rows[0]!.total_findings,
        0,
      );
      await admin.query('BEGIN');
      await admin.query("SET LOCAL session_replication_role='replica'");
      await admin.query(mutation.sql, [s.id]);
      await admin.query('COMMIT');
      assert.ok(
        (await db.query<{ findings: { code: string }[] }>(sql, [s.id])).rows[0]!.findings.some(
          (x) => x.code === mutation.code,
        ),
      );
    } finally {
      await admin.end();
      await db.end();
      await s.close();
    }
  });
void test('independent application SQL rejects matched raw/semantic corruption of original BUY/SELL direction on acknowledgment', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin'),
    db = await connection('reconciler');
  try {
    await s.apply((await s.prepare()).work);
    const sql = await readFile('verification/sql/fix_application.sql', 'utf8');
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      "UPDATE fi.fix_messages SET fields=jsonb_set(fields,'{54}','\"2\"'),semantic_hash=encode(sha256(convert_to((jsonb_set(fields,'{54}','\"2\"')-ARRAY['8','9','10','34','43','52','122'])::text,'UTF8')),'hex') WHERE sandbox_id=$1 AND message_type='8'",
      [s.id],
    );
    // Re-encode matching raw bytes independently of the application SQL verifier.
    const { encodeFix44 } = await import('../../app/protocol/fix44/index.js');
    const row = (
      await admin.query<{ fields: Record<string, string>; id: string }>(
        "SELECT fields,id FROM fi.fix_messages WHERE sandbox_id=$1 AND message_type='8'",
        [s.id],
      )
    ).rows[0]!;
    const f = { ...row.fields };
    for (const tag of ['8', '9', '10']) delete f[tag];
    const raw = encodeFix44(f);
    await admin.query(
      "UPDATE fi.fix_attempts SET raw_bytes=$2,raw_hash=encode(sha256($2),'hex') WHERE sandbox_id=$1 AND message_id=$3",
      [s.id, raw, row.id],
    );
    await admin.query('COMMIT');
    assert.ok(
      (await db.query<{ findings: { code: string }[] }>(sql, [s.id])).rows[0]!.findings.some(
        (x) => x.code === 'MESSAGE_CONTRACT',
      ),
    );
  } finally {
    await admin.end();
    await db.end();
    await s.close();
  }
});

import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { owner } from './harness.js';
import { durableFixSnapshot } from './fix-recovery-evidence.js';
import { verifyOwned } from '../../scripts/owned-postgres.js';
import { VerificationDatabase } from '../../app/server/reconciliation/database.js';
import { verifyFixApplication } from '../../app/server/fix/application-reconciliation.js';
import { DomainError } from '../../app/domain/errors.js';
import { encodeFix44 } from '../../app/protocol/fix44/index.js';

type Fixture = Awaited<ReturnType<typeof applicationFixture>>;
type CommandResult = Awaited<ReturnType<Fixture['apply']>>;
type Client = Awaited<ReturnType<typeof connection>>;
type Change = { sql: string; args: unknown[]; rows: number };
type Target = {
  s: Fixture;
  work: string;
  message: string;
  key: string;
  seq: number;
  financial: string;
};
type Scenario = { name: string; kind?: 'observation' | 'fill'; changes: (c: Target) => Change[] };
const update = (sql: string, args: unknown[], rows = 1): Change => ({ sql, args, rows });
const cases: Scenario[] = [
  ...[
    [
      'missing-application',
      'DELETE FROM fi.fix_applications WHERE sandbox_id=$1 AND work_id=$2',
      'work',
    ],
    [
      'missing-consumption',
      'DELETE FROM fi.fix_consumptions WHERE sandbox_id=$1 AND work_id=$2',
      'work',
    ],
    [
      'missing-financial-command',
      'DELETE FROM fi.commands WHERE sandbox_id=$1 AND id=$2',
      'financial',
    ],
    [
      'missing-financial-audit',
      'DELETE FROM fi.audit_events WHERE sandbox_id=$1 AND command_id=$2',
      'financial',
    ],
    [
      'missing-history',
      'DELETE FROM fi.order_history WHERE sandbox_id=$1 AND command_id=$2',
      'financial',
    ],
    [
      'missing-protocol-receipt',
      'DELETE FROM fi.fix_commands WHERE sandbox_id=$1 AND command_seq=$2',
      'seq',
    ],
    [
      'missing-protocol-event',
      'DELETE FROM fi.fix_events WHERE sandbox_id=$1 AND command_seq=$2',
      'seq',
    ],
    [
      'missing-financial-key',
      'DELETE FROM fi_control.command_keys WHERE sandbox_id=$1 AND idempotency_key=$2',
      'key',
    ],
  ].map(([name, sql, property]) => ({
    name: name!,
    changes: (c: Target) => [update(sql!, [c.s.id, c[property as keyof Target]])],
  })),
  {
    name: 'missing-financial-effect',
    kind: 'fill',
    changes: (c) => [
      update('DELETE FROM fi.executions WHERE sandbox_id=$1 AND command_id=$2', [
        c.s.id,
        c.financial,
      ]),
    ],
  },
  {
    name: 'observation-tail-receipt-and-audit',
    kind: 'observation',
    changes: (c) => [
      update('DELETE FROM fi.fix_events WHERE sandbox_id=$1 AND command_seq=$2', [c.s.id, c.seq]),
      update('DELETE FROM fi.fix_commands WHERE sandbox_id=$1 AND command_seq=$2', [c.s.id, c.seq]),
    ],
  },
  ...(['application', 'observation'] as const).flatMap((kind) =>
    (['applied_fence', 'applied_generation'] as const).flatMap((column) =>
      ['0', '999'].map((value) => ({
        name: kind + '-' + column + '-' + value,
        ...(kind === 'observation' ? { kind: 'observation' as const } : {}),
        changes: (c: Target) => [
          update(
            'UPDATE fi.' +
              (kind === 'application' ? 'fix_applications' : 'fix_protocol_observations') +
              ' SET ' +
              column +
              '=$3 WHERE sandbox_id=$1 AND work_id=$2',
            [c.s.id, c.work, value],
          ),
        ],
      })),
    ),
  ),
  {
    name: 'protocol-request-hash',
    changes: (c) => [
      update(
        "UPDATE fi.fix_commands SET request_hash=repeat('a',64) WHERE sandbox_id=$1 AND command_seq=$2",
        [c.s.id, c.seq],
      ),
    ],
  },
  {
    name: 'protocol-http-status',
    changes: (c) => [
      update('UPDATE fi.fix_commands SET http_status=201 WHERE sandbox_id=$1 AND command_seq=$2', [
        c.s.id,
        c.seq,
      ]),
    ],
  },
  ...[
    'order_id',
    'work_id',
    'financial_key',
    'financial_command_id',
    'financial_command_seq',
    'delivery_verified',
  ].map((field) => ({
    name: 'coherent-result-' + field,
    changes: (c: Target) => [
      update(
        'UPDATE fi.fix_applications SET result=jsonb_set(result,ARRAY[$3]::text[],$4::jsonb) WHERE sandbox_id=$1 AND work_id=$2',
        [
          c.s.id,
          c.work,
          field,
          JSON.stringify(
            field === 'delivery_verified'
              ? true
              : field === 'financial_command_seq'
                ? '999'
                : randomUUID(),
          ),
        ],
      ),
      update(
        'UPDATE fi.fix_commands c SET response_body=a.result FROM fi.fix_applications a WHERE c.sandbox_id=$1 AND a.sandbox_id=c.sandbox_id AND a.work_id=$2 AND c.command_seq=a.protocol_command_seq',
        [c.s.id, c.work],
      ),
      update(
        "UPDATE fi.fix_events e SET payload=jsonb_build_object('financial_applied',true,'record',c.response_body) FROM fi.fix_commands c WHERE e.sandbox_id=$1 AND c.sandbox_id=e.sandbox_id AND c.command_seq=$2 AND e.command_seq=c.command_seq",
        [c.s.id, c.seq],
      ),
    ],
  })),
  {
    name: 'malformed-prepared-version',
    changes: (c) => [
      update(
        "UPDATE fi.fix_prepared SET payload=jsonb_set(payload,'{expected_version}','\"not-a-version\"'),request_hash=encode(sha256(convert_to(jsonb_set(payload,'{expected_version}','\"not-a-version\"')::text,'UTF8')),'hex') WHERE sandbox_id=$1 AND work_id=$2",
        [c.s.id, c.work],
      ),
    ],
  },
  ...[
    ['numeric', '14', 'not-a-number'],
    ['date', '64', '20280230'],
  ].map(([label, tag, value]) => ({
    name: 'malformed-report-' + label,
    changes: (c: Target) => [
      update(
        "UPDATE fi.fix_messages SET fields=jsonb_set(fields,ARRAY[$3]::text[],$4::jsonb),semantic_hash=encode(sha256(convert_to((jsonb_set(fields,ARRAY[$3]::text[],$4::jsonb)-ARRAY['8','9','10','34','43','52','122'])::text,'UTF8')),'hex') WHERE sandbox_id=$1 AND id=$2",
        [c.s.id, c.message, tag, JSON.stringify(value)],
      ),
    ],
  })),
];

cases.push(
  ...(['request-hash', 'http-status'] as const).map((fault) => ({
    name: 'observation-' + fault,
    kind: 'observation' as const,
    changes: (c: Target) => [
      update(
        fault === 'request-hash'
          ? "UPDATE fi.fix_commands SET request_hash=repeat('a',64) WHERE sandbox_id=$1 AND command_seq=$2"
          : 'UPDATE fi.fix_commands SET http_status=201 WHERE sandbox_id=$1 AND command_seq=$2',
        [c.s.id, c.seq],
      ),
    ],
  })),
  ...(['status', 'scalar'] as const).map((fault) => ({
    name: 'malformed-result-' + fault,
    changes: (c: Target) => [
      update(
        fault === 'status'
          ? "UPDATE fi.fix_applications SET result=jsonb_set(result,'{financial_result,status}','\"not-a-status\"') WHERE sandbox_id=$1 AND work_id=$2"
          : "UPDATE fi.fix_applications SET result='null'::jsonb WHERE sandbox_id=$1 AND work_id=$2",
        [c.s.id, c.work],
      ),
      update(
        'UPDATE fi.fix_commands c SET response_body=a.result FROM fi.fix_applications a WHERE c.sandbox_id=$1 AND a.sandbox_id=c.sandbox_id AND a.work_id=$2 AND c.command_seq=a.protocol_command_seq',
        [c.s.id, c.work],
      ),
      update(
        "UPDATE fi.fix_events e SET payload=jsonb_build_object('financial_applied',true,'record',c.response_body) FROM fi.fix_commands c WHERE e.sandbox_id=$1 AND c.sandbox_id=e.sandbox_id AND c.command_seq=$2 AND e.command_seq=c.command_seq",
        [c.s.id, c.seq],
      ),
    ],
  })),
);
type EvidenceContext = {
  s: Fixture;
  admin: Client;
  reconciler: Client;
  database: VerificationDatabase;
  binding: { sandboxId: string; digest: string; scope: 'trade'; generation: string };
};
async function withApplicationEvidence(run: (context: EvidenceContext) => Promise<void>) {
  const path = process.env.TF_DB_OWNER_FILE;
  assert.ok(path, 'Application integrity tests require an owned private descriptor.');
  const owned = await verifyOwned(path),
    cfg = await owner();
  assert.equal(cfg.adminUrl, owned.adminUrl);
  const admin = await connection('admin');
  let s: Fixture | undefined,
    reconciler: Client | undefined,
    database: VerificationDatabase | undefined;
  try {
    assert.equal(
      (
        await admin.query<{ marker: string }>(
          "SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()",
        )
      ).rows[0]!.marker,
      'TradeFlow local owner ' + owned.nonce,
    );
    s = await applicationFixture();
    reconciler = await connection('reconciler');
    database = new VerificationDatabase(cfg.reconcilerUrl!);
    await run({
      s,
      admin,
      reconciler,
      database,
      binding: { sandboxId: s.id, digest: s.proof, scope: 'trade', generation: '1' },
    });
  } finally {
    try {
      await admin.query('ROLLBACK');
      await reconciler?.query('ROLLBACK');
      await database?.close();
      await reconciler?.end();
      await s?.close();
      if (s)
        assert.equal(
          (await admin.query('SELECT 1 FROM fi.sandboxes WHERE id=$1', [s.id])).rowCount,
          0,
          'Owned application fixture sandbox must be retired.',
        );
    } finally {
      await admin.end();
    }
  }
}
async function guardedApplicationChanges(context: EvidenceContext, changes: Change[]) {
  const before = await snapshot(context.s, context.admin);
  for (const change of changes)
    for (const role of [context.s.app, context.reconciler])
      await assert.rejects(role.query(change.sql, change.args), { code: '42501' });
  assert.deepEqual(
    await snapshot(context.s, context.admin),
    before,
    'Denied ordinary-role writes changed retained evidence.',
  );
  await context.admin.query('BEGIN');
  try {
    await context.admin.query("SET LOCAL session_replication_role='replica'");
    for (const change of changes)
      assert.equal((await context.admin.query(change.sql, change.args)).rowCount, change.rows);
    await context.admin.query('COMMIT');
  } catch (error) {
    await context.admin.query('ROLLBACK');
    throw error;
  }
  const damaged = await snapshot(context.s, context.admin),
    changed = new Set(
      changes.map(
        (change) => change.sql.match(/(?:UPDATE|DELETE FROM) fi(?:_control)?\.([a-z_]+)/)![1],
      ),
    );
  assert.notDeepEqual(damaged, before);
  for (const table of Object.keys(before))
    if (!changed.has(table))
      assert.deepEqual(
        damaged[table],
        before[table],
        'Unexpected corruption outside declared tables: ' + table,
      );
  return damaged;
}
function expectedApplicationFinding(
  name: string,
  c: Target,
  before: Awaited<ReturnType<typeof snapshot>>,
) {
  let code = 'APPLICATION_RECEIPT',
    record_id = c.work;
  if (name === 'missing-application') code = 'UNBACKED_CONSUMPTION';
  else if (name === 'missing-consumption' || name === 'missing-financial-audit')
    code = 'APPLICATION_CAPACITY';
  else if (name === 'missing-financial-key') code = 'PREPARED_FINGERPRINT';
  else if (name === 'missing-financial-effect') code = 'EXECUTION_CORRELATION';
  else if (name === 'missing-protocol-event') {
    code = 'PROTOCOL_AUDIT';
    record_id = String(before['fix_commands']!.find((row) => row['command_seq'] === c.seq)!['id']);
  } else if (name.startsWith('observation-')) code = 'PENDING_CANCEL_EVIDENCE';
  else if (name === 'malformed-prepared-version') code = 'PREPARED_VERSION';
  else if (name === 'malformed-report-numeric') code = 'APPLIED_REPORT_TOTALS';
  else if (name === 'malformed-report-date') {
    code = 'MESSAGE_CONTRACT';
    record_id = c.message;
  }
  return { code, record_id };
}
for (const scenario of cases)
  void test(
    'active application verifier rejects retained ' + scenario.name,
    { timeout: 30000 },
    async () => {
      await withApplicationEvidence(async (context) => {
        const { s, admin, database, binding } = context,
          c = await target(s, admin, scenario.kind);
        const baseline = await verifyFixApplication(database, binding, () => {}, true);
        assert.equal(
          baseline.assessment,
          'OBSERVED_APPLICATION_CONSISTENT',
          JSON.stringify(baseline.findings),
        );
        assert.equal(baseline.total_findings, 0);
        assert.equal(baseline.financial_findings, 0);
        assert.equal(baseline.foundation_coverage.total_findings, 0);
        const before = await snapshot(s, admin),
          damaged = await guardedApplicationChanges(context, scenario.changes(c));
        if (scenario.name === 'observation-tail-receipt-and-audit') {
          const seq = (
            await admin.query<{ command_seq: number }>(
              'SELECT command_seq FROM fi.fix_commands WHERE sandbox_id=$1 ORDER BY command_seq',
              [s.id],
            )
          ).rows.map((row) => row.command_seq);
          assert.deepEqual(
            seq,
            Array.from({ length: seq.length }, (_, i) => i + 1),
          );
          assert.equal(damaged['fix_protocol_observations']!.length, 1);
        }
        const expected = expectedApplicationFinding(scenario.name, c, before);
        let first: Awaited<ReturnType<typeof verifyFixApplication>> | undefined;
        for (let observation = 0; observation < 2; observation++) {
          const actual = await verifyFixApplication(database, binding, () => {}, true);
          assert.equal(actual.assessment, 'APPLICATION_FINDINGS');
          assert.equal(actual.financial_application_verified, false);
          assert.equal(actual.observed_transcript_complete, false);
          assert.equal(actual.delivery_verified, false);
          assert.equal(actual.external_completeness_verified, false);
          assert.ok(
            actual.findings.some(
              (finding) =>
                finding.code === expected.code && finding.record_id === expected.record_id,
            ),
            JSON.stringify({ expected, actual: actual.findings }),
          );
          assert.ok(actual.total_findings >= actual.findings.length);
          if (first) {
            assert.deepEqual(actual.findings, first.findings);
            assert.equal(actual.total_findings, first.total_findings);
            assert.equal(actual.financial_findings, first.financial_findings);
            assert.deepEqual(
              actual.foundation_coverage.findings,
              first.foundation_coverage.findings,
            );
          }
          first = actual;
        }
        assert.deepEqual(
          await snapshot(s, admin),
          damaged,
          'Verification changed retained corrupt evidence.',
        );
      });
    },
  );
async function snapshot(s: Pick<Fixture, 'id'>, admin: Client) {
  const result = await durableFixSnapshot(s.id);
  await admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    assert.deepEqual(
      (
        await admin.query<{ ro: string; isolation: string }>(
          "SELECT current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation",
        )
      ).rows[0],
      { ro: 'on', isolation: 'repeatable read' },
    );
    for (const t of [
      'fix_applications',
      'fix_consumptions',
      'fix_protocol_observations',
      'fix_unresolved_ingest',
    ])
      result[t] = (
        await admin.query<{ record: Record<string, unknown> }>(
          'SELECT to_jsonb(t) record FROM fi.' +
            t +
            ' t WHERE sandbox_id=$1 ORDER BY to_jsonb(t)::text',
          [s.id],
        )
      ).rows.map((r) => r.record);
    await admin.query('COMMIT');
    return result;
  } catch (e) {
    await admin.query('ROLLBACK');
    throw e;
  }
}
async function target(s: Fixture, admin: Client, kind?: Scenario['kind']): Promise<Target> {
  let p = await s.prepare();
  assert.equal((await s.apply(p.work)).status, 200);
  if (kind === 'fill') {
    const px = p.f['44']!;
    p = await s.prepare({
      '150': 'F',
      '39': '2',
      '14': '100.00',
      '151': '0.00',
      '32': '100.00',
      '31': px,
      '6': px,
    });
    assert.equal((await s.apply(p.work)).status, 200);
  }
  if (kind === 'observation') {
    const base = { '11': randomUUID(), '41': s.order };
    assert.equal(
      (
        await s.apply(
          (await s.prepare({ '35': 'F', '49': 'TRADEFLOW', '56': 'ATLAS', ...base })).work,
        )
      ).status,
      200,
    );
    p = await s.prepare({ ...base, '150': '6', '39': '6' });
    const a = await s.apply(p.work);
    assert.equal(a.status, 200);
    assert.equal(a.body['financial_applied'], false);
  }
  const seq = (
    await admin.query<{ command_seq: number }>(
      "SELECT command_seq FROM fi.fix_commands WHERE sandbox_id=$1 AND operation='APPLY' AND response_body->>'work_id'=$2",
      [s.id, p.work],
    )
  ).rows[0]!.command_seq;
  const a = (
    await admin.query<{ financial_command_id: string }>(
      'SELECT financial_command_id FROM fi.fix_applications WHERE sandbox_id=$1 AND work_id=$2',
      [s.id, p.work],
    )
  ).rows[0];
  return {
    s,
    work: p.work,
    message: p.message,
    key: p.financialKey,
    seq,
    financial: a?.financial_command_id ?? '',
  };
}

for (const ending of [
  'ACK_AND_FULL',
  'DEFINITIVE_REJECT',
  'CANCEL_ACK',
  'CANCEL_REJECT',
  'TOO_LATE',
] as const)
  void test(
    'active application verifier preserves healthy ' + ending,
    { timeout: 30000 },
    async () => {
      await withApplicationEvidence(async (context) => {
        const { s, admin, database, binding } = context;
        const metadataSnapshot = await snapshot(s, admin),
          metadata = await verifyFixApplication(database, binding, () => {}, true);
        assert.equal(metadata.assessment, 'INCOMPLETE');
        assert.equal(metadata.applied_work_count, 0);
        assert.equal(metadata.protocol_application_watermark, '0');
        assert.equal(metadata.total_findings, 0);
        assert.deepEqual(metadata.findings, []);
        assert.equal(metadata.financial_findings, 0);
        assert.equal(metadata.financial_ledger_consistency, 'CONSISTENT');
        assert.equal(metadata.foundation_coverage.total_findings, 0);
        assert.deepEqual(metadata.foundation_coverage.findings, []);
        assert.equal(metadata.foundation_coverage.foundation_assessment, 'FOUNDATION_CONSISTENT');
        assert.equal(metadata.financial_coverage.length, 4);
        assert.ok(metadata.financial_coverage.every((coverage) => coverage.findings === 0));
        assert.equal(metadata.financial_application_verified, false);
        assert.equal(metadata.observed_transcript_complete, false);
        assert.equal(metadata.delivery_verified, false);
        assert.equal(metadata.external_completeness_verified, false);
        assert.deepEqual(await snapshot(s, admin), metadataSnapshot);
        let applied = 0,
          observations = 0;
        const apply = async (changes: Record<string, string> = {}) => {
          const prepared = await s.prepare(changes),
            result = await s.apply(prepared.work);
          assert.equal(result.status, 200, JSON.stringify(result.body));
          if (result.body['financial_applied'] === true) applied++;
          else observations++;
          const retained = await snapshot(s, admin),
            actual = await verifyFixApplication(database, binding, () => {}, true);
          assert.equal(
            actual.assessment,
            'OBSERVED_APPLICATION_CONSISTENT',
            JSON.stringify(actual),
          );
          assert.equal(actual.total_findings, 0);
          assert.deepEqual(actual.findings, []);
          assert.equal(actual.financial_findings, 0);
          assert.equal(actual.foundation_coverage.total_findings, 0);
          assert.equal(actual.applied_work_count, applied);
          assert.equal(actual.unresolved_message_count, 0);
          assert.equal(actual.financial_application_verified, true);
          assert.equal(actual.observed_transcript_complete, true);
          assert.equal(actual.delivery_verified, false);
          assert.equal(actual.external_completeness_verified, false);
          assert.equal(actual.verified_scope, 'OBSERVED_PROTOCOL_AND_LEDGER');
          assert.equal(actual.protocol_completeness, 'OBSERVED_MESSAGES_ONLY');
          assert.equal(actual.foundation_coverage.financial_application_verified, false);
          assert.equal(actual.foundation_coverage.protocol_application_watermark, '0');
          assert.equal(actual.foundation_coverage.snapshot_id, actual.snapshot_id);
          for (const key of [
            'financial_watermark',
            'protocol_watermark',
            'protocol_ingest_watermark',
            'protocol_prepare_watermark',
          ] as const)
            assert.equal(actual.foundation_coverage[key], actual[key]);
          assert.equal(actual.foundation_coverage.physical_schema_revision, 8);
          assert.match(actual.foundation_coverage.sql_hash, /^[a-f0-9]{64}$/);
          assert.equal(actual.financial_coverage.length, 4);
          assert.ok(
            actual.financial_coverage.every(
              (coverage) => coverage.findings === 0 && /^[a-f0-9]{64}$/.test(coverage.hash),
            ),
          );
          assert.deepEqual(
            await snapshot(s, admin),
            retained,
            'Healthy verification changed durable evidence.',
          );
          return prepared;
        };
        if (ending === 'DEFINITIVE_REJECT') {
          await apply({
            '150': '8',
            '39': '8',
            '151': '0.00',
            '103': '99',
            '58': 'SYNTHETIC_REJECTION',
          });
          assert.equal(
            (
              await admin.query<{ status: string }>(
                'SELECT status FROM fi.order_states WHERE sandbox_id=$1',
                [s.id],
              )
            ).rows[0]!.status,
            'REJECTED',
          );
          return;
        }
        const ack = await apply(),
          px = ack.f['44']!;
        const fill = (quantity: string, total: string, left: string, status: string) =>
          apply({
            '150': 'F',
            '39': status,
            '14': total,
            '151': left,
            '32': quantity,
            '31': px,
            '6': px,
          });
        if (ending === 'ACK_AND_FULL') {
          await fill('40.00', '40.00', '60.00', '1');
          await fill('60.00', '100.00', '0.00', '2');
          assert.equal(
            (
              await admin.query<{ n: number }>(
                'SELECT count(*)::int n FROM fi.executions WHERE sandbox_id=$1',
                [s.id],
              )
            ).rows[0]!.n,
            2,
          );
        } else {
          if (ending === 'CANCEL_ACK') await fill('40.00', '40.00', '60.00', '1');
          const base = { '11': randomUUID(), '41': s.order };
          await apply({ '35': 'F', '49': 'TRADEFLOW', '56': 'ATLAS', ...base });
          if (ending !== 'CANCEL_REJECT') {
            await apply({
              ...base,
              '150': '6',
              '39': '6',
              ...(ending === 'CANCEL_ACK' ? { '14': '40.00', '151': '60.00', '6': px } : {}),
            });
            assert.equal(observations, 1);
          }
          if (ending === 'CANCEL_ACK') {
            await fill('20.00', '60.00', '40.00', '6');
            await apply({ ...base, '150': '4', '39': '4', '14': '60.00', '151': '0.00', '6': px });
            assert.equal(
              (
                await admin.query<{ status: string }>(
                  'SELECT status FROM fi.order_states WHERE sandbox_id=$1',
                  [s.id],
                )
              ).rows[0]!.status,
              'CANCELED',
            );
          } else {
            if (ending === 'TOO_LATE') await fill('100.00', '100.00', '0.00', '6');
            await apply({
              '35': '9',
              ...base,
              '39': ending === 'TOO_LATE' ? '2' : '0',
              '434': '1',
              '102': ending === 'TOO_LATE' ? '0' : '99',
            });
            assert.equal(
              (
                await admin.query<{ outcome: string }>(
                  'SELECT outcome FROM fi.cancellation_outcomes WHERE sandbox_id=$1',
                  [s.id],
                )
              ).rows[0]!.outcome,
              'REJECTED',
            );
          }
        }
      });
    },
  );
void test(
  'active application verifier accepts historical generations, reclaimed prepared work, replay and physical retransmission without another effect',
  { timeout: 30000 },
  async () => {
    await withApplicationEvidence(async (context) => {
      const { s, admin, database, binding } = context;
      const acknowledgment = await s.prepare(),
        ackKey = randomUUID(),
        ackResult = await s.apply(acknowledgment.work, ackKey);
      assert.equal(ackResult.status, 200);
      const px = acknowledgment.f['44']!,
        fill = await s.prepare({
          '150': 'F',
          '39': '2',
          '14': '100.00',
          '151': '0.00',
          '32': '100.00',
          '31': px,
          '6': px,
        });
      const original = (await snapshot(s, admin))['fix_prepared'],
        newProof = 'b'.repeat(64);
      const rotation = (
        await s.app.query<{ r: CommandResult }>(
          'SELECT fi_control.rotate_capabilities($1,$2,1,1,$3,$4,$5,$6,$7) r',
          [s.id, s.proof, 'a'.repeat(64), newProof, 'c'.repeat(64), randomUUID(), s.actor],
        )
      ).rows[0]!.r;
      assert.equal(rotation.status, 200);
      assert.equal((await s.apply(fill.work)).status, 404);
      binding.digest = newProof;
      binding.generation = '2';
      const ownerId = randomUUID();
      const lease = (
        await s.app.query<{ r: CommandResult }>(
          'SELECT fi_control.fix_command($1,$2,2,$3,$4,$5,$6) r',
          [
            s.id,
            newProof,
            'CLAIM',
            JSON.stringify({ order_id: s.order, owner_id: ownerId }),
            randomUUID(),
            s.actor,
          ],
        )
      ).rows[0]!.r;
      assert.equal(lease.status, 200);
      const input = {
          order_id: s.order,
          owner_id: ownerId,
          fence: lease.body.fence,
          work_id: fill.work,
        },
        applyKey = randomUUID();
      const apply = async (key: string) =>
        (
          await s.app.query<{ r: CommandResult }>(
            'SELECT fi_control.apply_fix($1,$2,2,$3,$4,$5) r',
            [s.id, newProof, JSON.stringify(input), key, s.actor],
          )
        ).rows[0]!.r;
      const result = await apply(applyKey);
      assert.equal(result.status, 200);
      const retained = await snapshot(s, admin);
      assert.deepEqual(retained['fix_prepared'], original);
      const replay = await apply(applyKey),
        recovered = await apply(randomUUID());
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.body, result.body);
      assert.equal(recovered.replayed, true);
      assert.deepEqual(recovered.body, result.body);
      const historical = await s.apply(acknowledgment.work, ackKey, s.app, '2', newProof);
      assert.equal(historical.replayed, true);
      assert.deepEqual(historical.body, ackResult.body);
      assert.deepEqual(await snapshot(s, admin), retained, 'Replays changed durable effects.');
      const fields = {
        ...fill.f,
        '34': '100',
        '43': 'Y',
        '122': fill.f['52']!,
        '52': '20261030-12:01:00.000',
      };
      const recorded = (
        await s.app.query<{ r: CommandResult }>(
          'SELECT fi_control.fix_command($1,$2,2,$3,$4,$5,$6) r',
          [
            s.id,
            newProof,
            'RECORD',
            JSON.stringify({
              order_id: s.order,
              raw_hex: encodeFix44(fields).toString('hex'),
              attempt_id: randomUUID(),
            }),
            randomUUID(),
            s.actor,
          ],
        )
      ).rows[0]!.r;
      assert.equal(recorded.status, 201);
      assert.equal(recorded.body.message_id, fill.message);
      const after = await snapshot(s, admin),
        actual = await verifyFixApplication(database, binding, () => {}, true);
      assert.equal(actual.assessment, 'OBSERVED_APPLICATION_CONSISTENT', JSON.stringify(actual));
      assert.equal(actual.applied_work_count, 2);
      assert.equal(after['executions']!.length, 1);
      assert.equal(after['fix_applications']!.length, 2);
      assert.equal(after['fix_consumptions']!.length, 2);
      for (const table of [
        'commands',
        'audit_events',
        'order_states',
        'order_history',
        'executions',
        'positions',
        'fix_prepared',
        'fix_applications',
        'fix_consumptions',
      ])
        assert.deepEqual(
          after[table],
          retained[table],
          'Retransmission changed economic evidence: ' + table,
        );
      assert.deepEqual(await snapshot(s, admin), after);
    });
  },
);
for (const layer of ['foundation', 'financial'] as const)
  void test(
    'application assessment rejects ' +
      layer +
      '-only findings without changing application finding ownership',
    { timeout: 30000 },
    async () => {
      await withApplicationEvidence(async (context) => {
        const { s, admin, database, binding } = context;
        await target(s, admin, 'fill');
        const baseline = await verifyFixApplication(database, binding, () => {}, true);
        assert.equal(baseline.assessment, 'OBSERVED_APPLICATION_CONSISTENT');
        const before = await snapshot(s, admin);
        const changes =
          layer === 'foundation'
            ? [update('DELETE FROM fi.fix_outbox WHERE sandbox_id=$1', [s.id])]
            : [update("UPDATE fi.positions SET signed_par='99.00' WHERE sandbox_id=$1", [s.id])];
        const damaged = await guardedApplicationChanges(context, changes);
        for (let repeat = 0; repeat < 2; repeat++) {
          const actual = await verifyFixApplication(database, binding, () => {}, true);
          assert.equal(actual.assessment, 'APPLICATION_FINDINGS');
          assert.equal(actual.financial_application_verified, false);
          assert.equal(actual.observed_transcript_complete, false);
          assert.equal(actual.total_findings, 0);
          assert.deepEqual(actual.findings, []);
          if (layer === 'foundation') {
            assert.ok(
              actual.foundation_coverage.findings.some(
                (f) =>
                  f.code === 'MISSING_OUTBOX' &&
                  f.record_id === String(before['fix_outbox']![0]!['message_id']),
              ),
            );
            assert.ok(actual.foundation_coverage.total_findings > 0);
            assert.equal(actual.financial_findings, 0);
          } else {
            assert.equal(actual.foundation_coverage.total_findings, 0);
            assert.ok(actual.financial_findings > 0);
            assert.ok(actual.financial_coverage.some((coverage) => coverage.findings > 0));
          }
        }
        assert.deepEqual(await snapshot(s, admin), damaged);
      });
    },
  );

void test(
  'application assessment uses one authorized read-only snapshot and matching layer watermarks',
  { timeout: 30000 },
  async () => {
    await withApplicationEvidence(async (context) => {
      const { s, admin, binding } = context;
      await target(s, admin, 'fill');
      const cfg = await owner(),
        statements: string[] = [];
      let transactions = 0,
        authorizations = 0;
      class ObservedDatabase extends VerificationDatabase {
        override transaction<T>(
          readOnly: boolean,
          verify: () => void,
          work: (client: pg.PoolClient) => Promise<T>,
        ): Promise<T> {
          transactions++;
          assert.equal(readOnly, true);
          return super.transaction(readOnly, verify, async (client) => {
            assert.deepEqual(
              (
                await client.query<{ ro: string; isolation: string }>(
                  "SELECT current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation",
                )
              ).rows[0],
              { ro: 'on', isolation: 'repeatable read' },
            );
            const observed = new Proxy(client, {
              get(target, property) {
                if (property !== 'query') return Reflect.get(target, property) as unknown;
                return async (sql: string, parameters?: unknown[]) => {
                  statements.push(sql);
                  if (sql.includes('fi_control.fix_snapshot_access')) authorizations++;
                  return target.query<Record<string, unknown>>(sql, parameters);
                };
              },
            });
            return work(observed);
          });
        }
      }
      const database = new ObservedDatabase(cfg.reconcilerUrl!),
        before = await snapshot(s, admin);
      try {
        const actual = await verifyFixApplication(database, binding, () => {}, true);
        assert.equal(actual.assessment, 'OBSERVED_APPLICATION_CONSISTENT');
        assert.equal(transactions, 1);
        assert.equal(authorizations, 1);
        assert.equal(actual.foundation_coverage.snapshot_id, actual.snapshot_id);
        for (const key of [
          'financial_watermark',
          'protocol_watermark',
          'protocol_ingest_watermark',
          'protocol_prepare_watermark',
        ] as const)
          assert.equal(actual.foundation_coverage[key], actual[key]);
        assert.equal(actual.foundation_coverage.protocol_application_watermark, '0');
        assert.notEqual(actual.protocol_application_watermark, '0');
        assert.equal(
          actual.financial_watermark,
          String(Math.max(...before['commands']!.map((row) => Number(row['command_seq'])))),
        );
        assert.equal(
          actual.protocol_watermark,
          String(Math.max(...before['fix_commands']!.map((row) => Number(row['command_seq'])))),
        );
        assert.ok(statements.some((sql) => sql.includes("'fix-foundation-v2'")));
        assert.ok(statements.some((sql) => sql.includes("'fix-application-v2'")));
        assert.deepEqual(await snapshot(s, admin), before);
      } finally {
        await database.close();
      }
    });
  },
);
void test(
  'application verification rejects foreign proofs and keeps assessments within the authorized sandbox',
  { timeout: 30000 },
  async () => {
    await withApplicationEvidence(async (context) => {
      const { s, admin, database, binding } = context,
        other = await applicationFixture();
      try {
        await target(s, admin);
        const otherPrepared = await other.prepare();
        assert.equal((await other.apply(otherPrepared.work)).status, 200);
        const before = await snapshot(s, admin),
          otherBefore = await snapshot(other, admin);
        await assert.rejects(
          verifyFixApplication(database, { ...binding, digest: other.proof }, () => {}, true),
          (error: unknown) =>
            error instanceof DomainError &&
            error.status === 404 &&
            error.code === 'SANDBOX_NOT_FOUND',
        );
        const damaged = await guardedApplicationChanges(context, [
          update('DELETE FROM fi.fix_consumptions WHERE sandbox_id=$1 AND work_id=$2', [
            s.id,
            String(before['fix_applications']![0]!['work_id']),
          ]),
        ]);
        const foreign = await verifyFixApplication(
          database,
          { sandboxId: other.id, digest: other.proof, scope: 'trade', generation: '1' },
          () => {},
          true,
        );
        assert.equal(foreign.assessment, 'OBSERVED_APPLICATION_CONSISTENT');
        assert.equal(foreign.total_findings, 0);
        assert.equal(foreign.financial_findings, 0);
        assert.equal(foreign.foundation_coverage.total_findings, 0);
        assert.equal(foreign.applied_work_count, 1);
        const actual = await verifyFixApplication(database, binding, () => {}, true);
        assert.equal(actual.assessment, 'APPLICATION_FINDINGS');
        assert.ok(
          actual.findings.some(
            (f) =>
              f.code === 'APPLICATION_CAPACITY' &&
              f.record_id === String(before['fix_applications']![0]!['work_id']),
          ),
        );
        assert.deepEqual(await snapshot(s, admin), damaged);
        assert.deepEqual(await snapshot(other, admin), otherBefore);
      } finally {
        await other.close();
      }
    });
  },
);

import { fixture as metadataFixture, report } from './fix-fixture.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { FixApplicationService } from '../../app/server/fix/application.js';
import {
  verificationQueries,
  verificationSources,
} from '../../app/server/reconciliation/manifest.js';
type IngestFixture = Pick<Fixture, 'id' | 'order' | 'proof' | 'actor' | 'app'>;
const ingestBinding = (s: IngestFixture) => ({
  sandboxId: s.id,
  digest: s.proof,
  generation: '1',
  scope: 'trade' as const,
});
const rejectedInput = (s: IngestFixture) => ({
  order_id: s.order,
  attempt_id: randomUUID(),
  raw_hex: Buffer.from('synthetic-unsupported').toString('hex'),
});
async function controlledIngest(s: IngestFixture, input: unknown, key = randomUUID()) {
  const cfg = await owner(),
    database = new WorkflowDatabase(cfg.appUrl!);
  try {
    return await new FixApplicationService(database, true).ingest(
      ingestBinding(s),
      s.actor,
      input,
      key,
      () => {},
    );
  } finally {
    await database.close();
  }
}
async function ingestWatermarks(s: IngestFixture, reader: Client) {
  const foundation = await readFile('verification/sql/fix_foundation_v2.sql', 'utf8'),
    application = await readFile('verification/sql/fix_application_v2.sql', 'utf8');
  await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    assert.equal(
      (
        await reader.query<{ allowed: boolean }>(
          "SELECT fi_control.fix_snapshot_access($1,$2,'trade',1) allowed",
          [s.id, s.proof],
        )
      ).rows[0]!.allowed,
      true,
    );
    const f = (await reader.query<Record<string, unknown>>(foundation, [s.id])).rows[0]!,
      a = (await reader.query<Record<string, unknown>>(application, [s.id])).rows[0]!;
    assert.equal(f['snapshot_id'], a['snapshot_id']);
    assert.equal(f['physical_schema_revision'], 8);
    assert.equal(a['physical_schema_revision'], 8);
    await reader.query('COMMIT');
    return {
      foundation: String(f['protocol_ingest_watermark']),
      application: String(a['protocol_ingest_watermark']),
      protocol: String(a['protocol_watermark']),
    };
  } catch (error) {
    await reader.query('ROLLBACK');
    throw error;
  }
}
async function combinedIngestAssessment(s: IngestFixture) {
  const cfg = await owner(),
    statements: string[] = [],
    queries = await verificationQueries();
  let transactions = 0,
    authorizations = 0;
  class ObservedDatabase extends VerificationDatabase {
    override transaction<T>(
      readOnly: boolean,
      verify: () => void,
      work: (client: pg.PoolClient) => Promise<T>,
    ): Promise<T> {
      transactions++;
      assert.equal(readOnly, true);
      return super.transaction(readOnly, verify, async (client) => {
        assert.deepEqual(
          (
            await client.query(
              "SELECT current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation",
            )
          ).rows[0],
          { ro: 'on', isolation: 'repeatable read' },
        );
        return work(
          new Proxy(client, {
            get(target, property) {
              if (property !== 'query') return Reflect.get(target, property) as unknown;
              return async (sql: string, parameters?: unknown[]) => {
                statements.push(sql);
                if (sql.includes('fi_control.fix_snapshot_access')) authorizations++;
                return target.query<Record<string, unknown>>(sql, parameters);
              };
            },
          }),
        );
      });
    }
  }
  const database = new ObservedDatabase(cfg.reconcilerUrl!);
  try {
    const actual = await verifyFixApplication(database, ingestBinding(s), () => {}, true);
    assert.equal(transactions, 1);
    assert.equal(authorizations, 1);
    assert.equal(actual.foundation_coverage.snapshot_id, actual.snapshot_id);
    for (const field of [
      'financial_watermark',
      'protocol_watermark',
      'protocol_ingest_watermark',
      'protocol_prepare_watermark',
    ] as const)
      assert.equal(actual.foundation_coverage[field], actual[field]);
    assert.equal(actual.profile, 'fix-application-v2');
    assert.equal(actual.foundation_coverage.profile, 'fix-foundation-v2');
    assert.equal(actual.physical_schema_revision, 8);
    assert.equal(statements.filter((q) => q.includes("'fix-foundation-v2' AS profile")).length, 1);
    assert.equal(statements.filter((q) => q.includes("'fix-application-v2' AS profile")).length, 1);
    assert.deepEqual(
      actual.financial_coverage.map((x) => x.name),
      ['foundation', 'rfq', 'executions', 'comparisons'],
    );
    for (const name of ['foundation', 'rfq', 'executions', 'comparisons'] as const) {
      const expected =
        name === 'comparisons'
          ? queries[name]
          : `SELECT * FROM (${queries[name]}) v WHERE sandbox_id=$1`;
      assert.equal(statements.filter((q) => q === expected).length, 1);
      assert.equal(
        actual.financial_coverage.find((x) => x.name === name)!.hash,
        verificationSources[name].hash,
      );
    }
    assert.equal(actual.delivery_verified, false);
    assert.equal(actual.external_completeness_verified, false);
    assert.equal(actual.financial_findings, 0);
    assert.ok(actual.financial_coverage.every((x) => x.findings === 0));
    assert.ok(actual.findings.length <= 128);
    assert.ok(actual.total_findings >= actual.findings.length);
    return actual;
  } catch (error) {
    if (error instanceof DomainError)
      console.log(
        'Combined ingest verification error:',
        JSON.stringify({ status: error.status, code: error.code, transactions, authorizations }),
      );
    throw error;
  } finally {
    await database.close();
  }
}
function assertUnresolvedIngress(
  actual: Awaited<ReturnType<typeof verifyFixApplication>>,
  attempt: string,
  watermark: string,
) {
  assert.equal(actual.assessment, 'APPLICATION_FINDINGS');
  assert.equal(actual.foundation_coverage.total_findings, 0);
  assert.deepEqual(actual.foundation_coverage.findings, []);
  assert.equal(actual.protocol_ingest_watermark, watermark);
  assert.equal(actual.foundation_coverage.protocol_ingest_watermark, watermark);
  assert.ok(
    actual.findings.some((f) => f.code === 'UNRESOLVED_INGRESS' && f.record_id === attempt),
  );
  assert.equal(actual.financial_application_verified, false);
  assert.equal(actual.observed_transcript_complete, false);
  assert.equal(actual.delivery_verified, false);
  assert.equal(actual.external_completeness_verified, false);
}

function assertRejectedIngestOnly(
  before: Awaited<ReturnType<typeof snapshot>>,
  after: Awaited<ReturnType<typeof snapshot>>,
  input: { order_id: string; attempt_id: string; raw_hex: string },
  key: string,
) {
  const allowed = new Set(['fix_commands', 'fix_events', 'command_keys', 'fix_unresolved_ingest']);
  for (const table of Object.keys(before))
    if (!allowed.has(table))
      assert.deepEqual(after[table], before[table], 'Rejected ingress changed ' + table);
  const receipts = after['fix_commands']!,
    oldReceipts = before['fix_commands']!,
    receipt = receipts.find((r) => r['idempotency_key'] === key)!;
  assert.ok(receipt);
  assert.equal(receipt['operation'], 'INGEST_REJECTED');
  assert.equal(receipt['http_status'], 200);
  assert.equal(receipts.length, oldReceipts.length + 1);
  assert.deepEqual(
    receipts.filter((r) => r !== receipt),
    oldReceipts,
  );
  assert.equal(
    Number(receipt['command_seq']),
    Math.max(0, ...oldReceipts.map((r) => Number(r['command_seq']))) + 1,
  );
  const events = after['fix_events']!,
    event = events.find((e) => e['command_seq'] === receipt['command_seq'])!;
  assert.ok(event);
  assert.equal(event['event_type'], 'INGEST_REJECTED');
  assert.equal(events.length, before['fix_events']!.length + 1);
  assert.deepEqual(
    events.filter((e) => e !== event),
    before['fix_events'],
  );
  assert.deepEqual(event['payload'], {
    financial_applied: false,
    record: receipt['response_body'],
  });
  const keys = after['command_keys']!,
    registry = keys.find((k) => k['idempotency_key'] === key)!;
  assert.ok(registry);
  assert.equal(registry['domain'], 'FIX');
  assert.equal(keys.length, before['command_keys']!.length + 1);
  assert.deepEqual(
    keys.filter((k) => k !== registry),
    before['command_keys'],
  );
  const ingress = after['fix_unresolved_ingest']!,
    retained = ingress.find((r) => r['attempt_id'] === input.attempt_id)!;
  assert.ok(retained);
  assert.equal(ingress.length, before['fix_unresolved_ingest']!.length + 1);
  assert.deepEqual(
    ingress.filter((r) => r !== retained),
    before['fix_unresolved_ingest'],
  );
  assert.equal(retained['order_id'], input.order_id);
  assert.equal(retained['protocol_command_seq'], receipt['command_seq']);
  assert.equal(
    retained['raw_hash'],
    createHash('sha256').update(Buffer.from(input.raw_hex, 'hex')).digest('hex'),
  );
  assert.equal(retained['reason'], 'FIX_PROFILE_UNSUPPORTED');
  assert.deepEqual(
    Object.keys(retained).sort(),
    [
      'sandbox_id',
      'order_id',
      'attempt_id',
      'raw_hash',
      'reason',
      'protocol_command_seq',
      'recorded_at',
    ].sort(),
  );
}
void test('schema8 ingest watermark includes retained rejected ingress after RECORD in the combined snapshot', async () => {
  await withApplicationEvidence(async ({ s, admin, reconciler }) => {
    const baseline = await combinedIngestAssessment(s);
    assert.equal(baseline.assessment, 'INCOMPLETE');
    assert.equal(baseline.protocol_ingest_watermark, '3');
    const input = rejectedInput(s),
      key = randomUUID(),
      before = await snapshot(s, admin),
      result = await controlledIngest(s, input, key);
    assert.equal(result.status, 200);
    assert.equal((result.body as { accepted: boolean }).accepted, false);
    const retained = await snapshot(s, admin);
    assertRejectedIngestOnly(before, retained, input, key);
    assert.equal(retained['fix_applications']!.length, 0);
    assert.equal(retained['fix_consumptions']!.length, 0);
    assert.equal(retained['executions']!.length, 0);
    const watermarks = await ingestWatermarks(s, reconciler);
    console.log(
      'Retained ingest watermark observation:',
      JSON.stringify({
        foundation: watermarks.foundation,
        application: watermarks.application,
        protocol: watermarks.protocol,
        retainedOperations: retained['fix_commands']!.map((r) => ({
          operation: r['operation'],
          sequence: r['command_seq'],
        })),
      }),
    );
    const actual = await combinedIngestAssessment(s);
    assert.deepEqual(watermarks, { foundation: '4', application: '4', protocol: '4' });
    assertUnresolvedIngress(actual, input.attempt_id, '4');
    assert.deepEqual(
      await snapshot(s, admin),
      retained,
      'Read-only combined verification changed retained evidence.',
    );
  });
});

void test('schema8 ingest watermark remains the maximum RECORD sequence through noningest commands', async () => {
  await withApplicationEvidence(async ({ s, admin, reconciler }) => {
    const before = await snapshot(s, admin);
    assert.equal(before['fix_commands']!.filter((r) => r['operation'] === 'RECORD').length, 1);
    assert.deepEqual(await ingestWatermarks(s, reconciler), {
      foundation: '3',
      application: '3',
      protocol: '3',
    });
    const claim = await s.claim();
    assert.match(claim, /^[1-9][0-9]*$/);
    const after = await snapshot(s, admin);
    assert.equal(after['fix_commands']!.length, before['fix_commands']!.length + 1);
    assert.deepEqual(await ingestWatermarks(s, reconciler), {
      foundation: '3',
      application: '3',
      protocol: '4',
    });
    const actual = await combinedIngestAssessment(s);
    assert.equal(actual.assessment, 'INCOMPLETE');
    assert.equal(actual.total_findings, 0);
    assert.equal(actual.foundation_coverage.total_findings, 0);
    assert.equal(actual.protocol_ingest_watermark, '3');
    assert.equal(actual.protocol_watermark, '4');
    assert.equal(actual.applied_work_count, 0);
    assert.equal(actual.financial_application_verified, false);
    assert.deepEqual(await snapshot(s, admin), after);
  });
});
void test('schema8 rejected ingress advances a zero ingest watermark without a preceding RECORD', async () => {
  const cfg = await owner(),
    owned = await verifyOwned(process.env['TF_DB_OWNER_FILE']!);
  assert.equal(cfg.adminUrl, owned.adminUrl);
  const admin = await connection('admin'),
    reader = await connection('reconciler');
  let s: Awaited<ReturnType<typeof metadataFixture>> | undefined;
  try {
    assert.equal(
      (
        await admin.query<{ comment: string }>(
          "SELECT shobj_description(oid,'pg_database') comment FROM pg_database WHERE datname=current_database()",
        )
      ).rows[0]!.comment,
      'TradeFlow local owner ' + owned.nonce,
    );
    s = await metadataFixture();
    assert.equal((await s.bind()).status, 201);
    assert.equal((await s.fix('CLAIM', { order_id: s.order, owner_id: randomUUID() })).status, 200);
    assert.deepEqual(await ingestWatermarks(s, reader), {
      foundation: '0',
      application: '0',
      protocol: '2',
    });
    const baseline = await combinedIngestAssessment(s);
    assert.equal(baseline.assessment, 'INCOMPLETE');
    assert.equal(baseline.total_findings, 0);
    assert.equal(baseline.foundation_coverage.total_findings, 0);
    const before = await snapshot(s, admin),
      input = rejectedInput(s),
      key = randomUUID(),
      result = await controlledIngest(s, input, key);
    assert.equal(result.status, 200);
    assert.equal((result.body as { unresolved: boolean }).unresolved, true);
    const after = await snapshot(s, admin);
    assertRejectedIngestOnly(before, after, input, key);
    assert.equal(after['fix_messages']!.length, 0);
    assert.deepEqual(await ingestWatermarks(s, reader), {
      foundation: '3',
      application: '3',
      protocol: '3',
    });
    assertUnresolvedIngress(await combinedIngestAssessment(s), input.attempt_id, '3');
    assert.deepEqual(await snapshot(s, admin), after);
  } finally {
    await reader.end();
    await s?.close();
    if (s)
      assert.equal(
        (await admin.query('SELECT 1 FROM fi.sandboxes WHERE id=$1', [s.id])).rowCount,
        0,
      );
    await admin.end();
  }
});
void test('schema8 later accepted RECORD advances ingest while retaining earlier unresolved evidence', async () => {
  await withApplicationEvidence(async ({ s, admin, reconciler }) => {
    const input = rejectedInput(s);
    assert.equal((await controlledIngest(s, input)).status, 200);
    const before = await snapshot(s, admin),
      fields = await report(s),
      accepted = {
        order_id: s.order,
        attempt_id: randomUUID(),
        raw_hex: encodeFix44(fields).toString('hex'),
      },
      key = randomUUID();
    const result = await controlledIngest(s, accepted, key);
    assert.equal(result.status, 201);
    const after = await snapshot(s, admin),
      receipt = after['fix_commands']!.find((r) => r['idempotency_key'] === key)!;
    assert.equal(receipt['operation'], 'RECORD');
    assert.equal(receipt['command_seq'], 5);
    assert.equal(after['fix_commands']!.length, before['fix_commands']!.length + 1);
    assert.deepEqual(after['fix_unresolved_ingest'], before['fix_unresolved_ingest']);
    for (const table of [
      'fix_applications',
      'fix_consumptions',
      'commands',
      'audit_events',
      'order_states',
      'order_history',
      'executions',
      'positions',
      'sandboxes',
    ])
      assert.deepEqual(after[table], before[table]);
    assert.deepEqual(await ingestWatermarks(s, reconciler), {
      foundation: '5',
      application: '5',
      protocol: '5',
    });
    assertUnresolvedIngress(await combinedIngestAssessment(s), input.attempt_id, '5');
    assert.deepEqual(await snapshot(s, admin), after);
  });
});

void test('schema8 rejected ingress original-key replay preserves receipt sequence and rejects changed input', async () => {
  await withApplicationEvidence(async ({ s, admin, reconciler }) => {
    const input = rejectedInput(s),
      key = randomUUID(),
      first = await controlledIngest(s, input, key);
    assert.equal(first.status, 200);
    assert.equal(first.replayed, false);
    const before = await snapshot(s, admin),
      replayed = await controlledIngest(s, input, key);
    assert.equal(replayed.status, 200);
    assert.equal(replayed.replayed, true);
    assert.deepEqual(replayed.body, first.body);
    assert.deepEqual(await snapshot(s, admin), before);
    const conflict = await controlledIngest(s, { ...input, raw_hex: '62' }, key);
    assert.equal(conflict.status, 409);
    assert.equal(
      (conflict.body as { error: { code: string } }).error.code,
      'IDEMPOTENCY_KEY_REUSED',
    );
    assert.deepEqual(await snapshot(s, admin), before);
    assert.deepEqual(await ingestWatermarks(s, reconciler), {
      foundation: '4',
      application: '4',
      protocol: '4',
    });
    assertUnresolvedIngress(await combinedIngestAssessment(s), input.attempt_id, '4');
    assert.deepEqual(await snapshot(s, admin), before);
  });
});
void test('schema8 unsuccessful input without a retained ingress receipt leaves every watermark unchanged', async () => {
  await withApplicationEvidence(async ({ s, admin, reconciler }) => {
    const before = await snapshot(s, admin);
    await assert.rejects(
      controlledIngest(s, { order_id: s.order, attempt_id: randomUUID(), raw_hex: 'zz' }),
      { status: 400, code: 'VALIDATION_ERROR' },
    );
    assert.deepEqual(await snapshot(s, admin), before);
    const unbound = await controlledIngest(s, {
      order_id: randomUUID(),
      attempt_id: randomUUID(),
      raw_hex: '61',
    });
    assert.equal(unbound.status, 404);
    assert.equal((unbound.body as { error: { code: string } }).error.code, 'FIX_BINDING_NOT_FOUND');
    assert.deepEqual(await snapshot(s, admin), before);
    assert.deepEqual(await ingestWatermarks(s, reconciler), {
      foundation: '3',
      application: '3',
      protocol: '3',
    });
    const actual = await combinedIngestAssessment(s);
    assert.equal(actual.assessment, 'INCOMPLETE');
    assert.equal(actual.total_findings, 0);
    assert.equal(actual.foundation_coverage.total_findings, 0);
    assert.equal(actual.protocol_ingest_watermark, '3');
    assert.equal(actual.financial_application_verified, false);
  });
});
void test('schema8 rejected ingress preserves existing financial execution and effect-backed consumption', async () => {
  await withApplicationEvidence(async ({ s, admin, reconciler }) => {
    await target(s, admin, 'fill');
    const baseline = await combinedIngestAssessment(s);
    assert.equal(baseline.assessment, 'OBSERVED_APPLICATION_CONSISTENT');
    assert.equal(baseline.applied_work_count, 2);
    const before = await snapshot(s, admin);
    assert.equal(before['fix_applications']!.length, 2);
    assert.equal(before['fix_consumptions']!.length, 2);
    assert.equal(before['executions']!.length, 1);
    const input = rejectedInput(s),
      key = randomUUID(),
      result = await controlledIngest(s, input, key);
    assert.equal(result.status, 200);
    assert.equal((result.body as { financial_applied: boolean }).financial_applied, false);
    const after = await snapshot(s, admin);
    assertRejectedIngestOnly(before, after, input, key);
    assert.deepEqual(await ingestWatermarks(s, reconciler), {
      foundation: '12',
      application: '12',
      protocol: '12',
    });
    const actual = await combinedIngestAssessment(s);
    assertUnresolvedIngress(actual, input.attempt_id, '12');
    assert.equal(actual.applied_work_count, 2);
    assert.equal(actual.financial_ledger_consistency, 'CONSISTENT');
    assert.equal(actual.foundation_coverage.total_findings, 0);
    assert.deepEqual(await snapshot(s, admin), after);
  });
});
