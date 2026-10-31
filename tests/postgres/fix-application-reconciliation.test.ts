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
