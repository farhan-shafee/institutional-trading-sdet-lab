import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, report, record } from './fix-fixture.js';
import { connection, owner } from './harness.js';
import { VerificationDatabase } from '../../app/server/reconciliation/database.js';
import { verifyFixFoundation } from '../../app/server/fix/reconciliation.js';
void test('independent read-only SQL reconstructs protocol evidence and distinct watermarks without claiming financial application', async () => {
  const s = await fixture();
  const cfg = await owner(),
    db = new VerificationDatabase(cfg.reconcilerUrl!),
    admin = await connection('admin');
  try {
    await s.bind();
    await record(s, await report(s));
    const binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' };
    const r = await verifyFixFoundation(db, binding, () => {}, true);
    assert.equal(r['foundation_assessment'], 'FOUNDATION_CONSISTENT');
    assert.equal(r['financial_ledger_consistency'], 'NOT_EVALUATED');
    assert.equal(r['protocol_completeness'], 'NOT_IMPLEMENTED');
    assert.equal(r['delivery_verified'], false);
    assert.equal(r['financial_application_verified'], false);
    assert.equal(r['financial_watermark'], '4');
    assert.equal(r['protocol_watermark'], '2');
    assert.equal(r['protocol_ingest_watermark'], '2');
    assert.equal(r['protocol_application_watermark'], '0');
    assert.deepEqual(r['findings'], []);
    await admin.query<Record<string, unknown>>('BEGIN');
    await admin.query<Record<string, unknown>>("SET LOCAL session_replication_role='replica'");
    await admin.query<Record<string, unknown>>(
      "UPDATE fi.fix_messages SET fields=jsonb_set(fields,'{39}','\"8\"'),semantic_hash=encode(sha256(convert_to((jsonb_set(fields,'{39}','\"8\"')-ARRAY['8','9','10','34','43','52','122'])::text,'UTF8')),'hex') WHERE sandbox_id=$1",
      [s.id],
    );
    await admin.query<Record<string, unknown>>('COMMIT');
    const corrupted = await verifyFixFoundation(db, binding, () => {}, true);
    assert.equal(corrupted['foundation_assessment'], 'FOUNDATION_FINDINGS');
    assert.ok(
      (corrupted['findings'] as { code: string }[]).some((x) => x.code === 'WIRE_SEMANTICS'),
    );
  } finally {
    await db.close();
    await admin.end();
    await s.close();
  }
});
void test('protocol-only mutations do not alter existing financial reconstruction or historical manifests', async () => {
  const s = await fixture();
  const reader = await connection('reconciler');
  try {
    const before = (
      await reader.query<Record<string, unknown>>(
        'SELECT command_count,event_count,commit_seq FROM fi.sandboxes WHERE id=$1',
        [s.id],
      )
    ).rows;
    await s.bind();
    await record(s, await report(s));
    assert.deepEqual(
      (
        await reader.query<Record<string, unknown>>(
          'SELECT command_count,event_count,commit_seq FROM fi.sandboxes WHERE id=$1',
          [s.id],
        )
      ).rows,
      before,
    );
    const key = randomUUID();
    assert.equal(
      (await s.fix('CLAIM', { order_id: s.order, owner_id: randomUUID() }, key)).status,
      200,
    );
    const result = await s.app.query<{ r: { status: number; body: { operation: string } } }>(
      'SELECT fi_control.read_fix($1,$2,$3,1,$4,$5) r',
      [s.id, s.proof, 'trade', 'RECEIPT', key],
    );
    assert.equal(result.rows[0]!.r.status, 200);
    assert.equal(result.rows[0]!.r.body.operation, 'CLAIM');
    assert.equal(
      (
        await s.app.query<{ r: { status: number; body: { error: { code: string } } } }>(
          'SELECT fi_control.read_fix($1,$2,$3,1,$4,$5) r',
          [s.id, s.proof, 'trade', 'RECEIPT', randomUUID()],
        )
      ).rows[0]!.r.body.error.code,
      'FIX_OUTCOME_UNRESOLVED',
    );
  } finally {
    await reader.end();
    await s.close();
  }
});
void test('independent SQL detects a forged checksum even when raw SHA is recomputed to match the corrupted bytes', async () => {
  const s = await fixture(),
    cfg = await owner(),
    db = new VerificationDatabase(cfg.reconcilerUrl!),
    admin = await connection('admin');
  try {
    await s.bind();
    await record(s, await report(s));
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      "UPDATE fi.fix_attempts SET raw_bytes=set_byte(raw_bytes,octet_length(raw_bytes)-2,CASE WHEN get_byte(raw_bytes,octet_length(raw_bytes)-2)=48 THEN 49 ELSE 48 END),raw_hash=encode(sha256(set_byte(raw_bytes,octet_length(raw_bytes)-2,CASE WHEN get_byte(raw_bytes,octet_length(raw_bytes)-2)=48 THEN 49 ELSE 48 END)),'hex') WHERE sandbox_id=$1",
      [s.id],
    );
    await admin.query('COMMIT');
    const r = await verifyFixFoundation(
      db,
      { sandboxId: s.id, digest: s.proof, scope: 'trade', generation: '1' },
      () => {},
      true,
    );
    assert.equal(r['foundation_assessment'], 'FOUNDATION_FINDINGS');
    assert.ok((r['findings'] as { code: string }[]).some((x) => x.code === 'WIRE_FRAMING'));
  } finally {
    await db.close();
    await admin.end();
    await s.close();
  }
});
void test('review: independent verifier detects dealer, sequence, prepared and audit corruption despite matched hashes', async () => {
  const s = await fixture(),
    cfg = await owner(),
    db = new VerificationDatabase(cfg.reconcilerUrl!),
    admin = await connection('admin');
  try {
    await s.bind();
    const m = await record(s, await report(s)),
      work = randomUUID(),
      ownerId = randomUUID();
    await s.fix('QUEUE', { order_id: s.order, message_id: m.body['message_id'], work_id: work });
    const lease = await s.fix('CLAIM', { order_id: s.order, owner_id: ownerId });
    await s.fix('PREPARE', {
      order_id: s.order,
      work_id: work,
      owner_id: ownerId,
      fence: lease.body['fence'],
      financial_key: randomUUID(),
    });
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      "UPDATE fi.fix_dealer_correlations SET dealer_order_id='ATLAS-CORRUPTED' WHERE sandbox_id=$1",
      [s.id],
    );
    await admin.query('UPDATE fi.fix_sequence_slots SET message_seq=99 WHERE sandbox_id=$1', [
      s.id,
    ]);
    await admin.query(
      "UPDATE fi.fix_prepared SET payload=jsonb_set(payload,'{expected_version}','\"999\"'),request_hash=encode(sha256(convert_to(jsonb_set(payload,'{expected_version}','\"999\"')::text,'UTF8')),'hex') WHERE sandbox_id=$1",
      [s.id],
    );
    await admin.query("UPDATE fi.fix_events SET event_type='WRONG' WHERE sandbox_id=$1", [s.id]);
    await admin.query('COMMIT');
    const r = await verifyFixFoundation(
      db,
      { sandboxId: s.id, digest: s.proof, scope: 'trade', generation: '1' },
      () => {},
      true,
    );
    const codes = (r.findings as { code: string }[]).map((x) => x.code);
    for (const c of [
      'DEALER_CORRELATION',
      'SEQUENCE_CORRELATION',
      'PREPARED_REFERENCE',
      'AUDIT_CORRESPONDENCE',
    ])
      assert.ok(codes.includes(c), c);
  } finally {
    await db.close();
    await admin.end();
    await s.close();
  }
});
