import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { durableFixSnapshot } from './fix-recovery-evidence.js';
import { encodeFix44 } from '../../app/protocol/fix44/index.js';
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

function outboundFields(base: Awaited<ReturnType<typeof report>>) {
  const fields = Object.fromEntries(
    (
      [
        '35',
        '49',
        '56',
        '34',
        '52',
        '11',
        '55',
        '167',
        '54',
        '854',
        '38',
        '40',
        '59',
        '423',
        '44',
        '15',
        '64',
        '60',
      ] as const
    ).map((tag) => [tag, base[tag]]),
  );
  return { ...fields, '35': 'D', '49': 'TRADEFLOW', '56': 'ATLAS' };
}
void test('independent verifier detects a missing outbound intent without losing logical or physical evidence', async () => {
  const s = await fixture(),
    cfg = await owner(),
    db = new VerificationDatabase(cfg.reconcilerUrl!),
    admin = await connection('admin');
  const binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' };
  try {
    assert.equal((await s.bind()).status, 201);
    const fields = outboundFields(await report(s)),
      raw = encodeFix44(fields),
      attempt = randomUUID(),
      recorded = await record(s, fields, randomUUID(), attempt);
    assert.equal(recorded.status, 201);
    assert.equal(recorded.body['financial_applied'], false);
    const message = recorded.body['message_id'];
    assert.equal(typeof message, 'string');
    const original = await durableFixSnapshot(s.id);
    assert.equal(original['fix_messages']!.length, 1);
    assert.equal(original['fix_attempts']!.length, 1);
    assert.equal(original['fix_outbox']!.length, 1);
    assert.equal(original['fix_messages']![0]!['id'], message);
    assert.equal(original['fix_messages']![0]!['direction'], 'OUT');
    assert.equal(original['fix_attempts']![0]!['id'], attempt);
    assert.equal(original['fix_attempts']![0]!['message_id'], message);
    assert.equal(original['fix_attempts']![0]!['raw_bytes'], '\\x' + raw.toString('hex'));
    assert.equal(
      original['fix_attempts']![0]!['raw_hash'],
      createHash('sha256').update(raw).digest('hex'),
    );
    assert.deepEqual(original['fix_outbox'], [
      {
        sandbox_id: s.id,
        message_id: message,
        order_id: s.order,
        delivery_state: 'NOT_IMPLEMENTED',
      },
    ]);
    const healthy = await verifyFixFoundation(db, binding, () => {}, true);
    assert.equal(healthy.foundation_assessment, 'FOUNDATION_CONSISTENT');
    assert.deepEqual(healthy.findings, []);
    assert.equal(healthy.financial_watermark, '4');
    assert.equal(healthy.protocol_watermark, '2');
    await assert.rejects(
      s.app.query('DELETE FROM fi.fix_outbox WHERE sandbox_id=$1 AND message_id=$2', [
        s.id,
        message,
      ]),
      { code: '42501' },
    );
    assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), original));
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    const removed = await admin.query(
      'DELETE FROM fi.fix_outbox WHERE sandbox_id=$1 AND message_id=$2',
      [s.id, message],
    );
    assert.equal(removed.rowCount, 1);
    await admin.query('COMMIT');
    const damaged = await durableFixSnapshot(s.id);
    assert.ok(
      isDeepStrictEqual(damaged, { ...original, fix_outbox: [] }),
      'Corruption must remove only the outbound intent.',
    );
    const assessment = await verifyFixFoundation(db, binding, () => {}, true);
    console.log(
      'Outbox missing-intent assessment:',
      JSON.stringify({
        message,
        healthy: healthy.foundation_assessment,
        corrupted: assessment.foundation_assessment,
        findings: assessment.findings,
        logicalMessages: damaged['fix_messages']!.length,
        physicalAttempts: damaged['fix_attempts']!.length,
        outboxIntents: damaged['fix_outbox']!.length,
        appDeletionDenied: true,
        financialWatermark: assessment.financial_watermark,
        protocolWatermark: assessment.protocol_watermark,
      }),
    );
    assert.equal(assessment.foundation_assessment, 'FOUNDATION_FINDINGS');
    assert.deepEqual(assessment.findings, [{ code: 'MISSING_OUTBOX', record_id: message }]);
    assert.equal(assessment.total_findings, 1);
    assert.equal(assessment.financial_watermark, healthy.financial_watermark);
    assert.equal(assessment.protocol_watermark, healthy.protocol_watermark);
    assert.equal(assessment.protocol_ingest_watermark, healthy.protocol_ingest_watermark);
    assert.equal(assessment.protocol_prepare_watermark, healthy.protocol_prepare_watermark);
    assert.equal(assessment.protocol_application_watermark, '0');
    assert.equal(assessment.delivery_verified, false);
    assert.equal(assessment.financial_application_verified, false);
    assert.ok(
      isDeepStrictEqual(await durableFixSnapshot(s.id), damaged),
      'Verifier mutated evidence.',
    );
  } finally {
    await admin.query('ROLLBACK');
    await db.close();
    await admin.end();
    await s.close();
  }
});

type FixAssessment = Awaited<ReturnType<typeof verifyFixFoundation>>;
function scopeEvidence(result: FixAssessment) {
  return Object.fromEntries(
    (
      [
        'financial_watermark',
        'protocol_watermark',
        'protocol_ingest_watermark',
        'protocol_prepare_watermark',
        'protocol_application_watermark',
        'unresolved_work_count',
        'financial_ledger_consistency',
        'protocol_completeness',
        'delivery_verified',
        'financial_application_verified',
        'complete',
        'verified_scope',
      ] as const
    ).map((name) => [name, result[name]]),
  );
}
async function corruptOutbox(
  admin: Awaited<ReturnType<typeof connection>>,
  sql: string,
  parameters: unknown[],
) {
  await admin.query('BEGIN');
  try {
    await admin.query("SET LOCAL session_replication_role='replica'");
    const result = await admin.query(sql, parameters);
    assert.equal(result.rowCount, 1);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}
void test('healthy incoming reports and outgoing D/F intents remain consistent without delivery or financial application', async () => {
  const s = await fixture(),
    cfg = await owner(),
    db = new VerificationDatabase(cfg.reconcilerUrl!),
    admin = await connection('admin'),
    reconciler = await connection('reconciler');
  const binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' };
  try {
    assert.equal((await s.bind()).status, 201);
    const base = await report(s),
      d = outboundFields(base),
      cancel = randomUUID();
    const cancellation = Object.fromEntries(
      (['35', '49', '56', '34', '52', '37', '55', '167', '54', '38', '60'] as const).map((tag) => [
        tag,
        base[tag],
      ]),
    );
    Object.assign(cancellation, {
      '35': 'F',
      '49': 'TRADEFLOW',
      '56': 'ATLAS',
      '34': '2',
      '11': cancel,
      '41': s.order,
    });
    const rejection = Object.fromEntries(
      (['35', '49', '56', '34', '52', '37', '60'] as const).map((tag) => [tag, base[tag]]),
    );
    Object.assign(rejection, {
      '35': '9',
      '34': '2',
      '11': cancel,
      '41': s.order,
      '39': '0',
      '434': '1',
      '102': '99',
    });
    for (const fields of [
      base,
      d,
      cancellation,
      rejection,
      { ...d, '43': 'Y', '122': base['52'], '52': '20261030-12:01:00.000' },
    ])
      assert.equal((await record(s, fields)).status, 201);
    const before = await durableFixSnapshot(s.id);
    assert.equal(before['fix_messages']!.length, 4);
    assert.equal(before['fix_attempts']!.length, 5);
    assert.equal(before['fix_outbox']!.length, 2);
    const outgoing = before['fix_messages']!.filter((m) => m['direction'] === 'OUT');
    assert.deepEqual(outgoing.map((m) => m['message_type']).sort(), ['D', 'F']);
    for (const message of before['fix_messages']!) {
      const intents = before['fix_outbox']!.filter((o) => o['message_id'] === message['id']);
      assert.equal(intents.length, message['direction'] === 'OUT' ? 1 : 0);
      for (const intent of intents) {
        assert.equal(intent['sandbox_id'], message['sandbox_id']);
        assert.equal(intent['order_id'], message['order_id']);
        assert.equal(intent['delivery_state'], 'NOT_IMPLEMENTED');
      }
    }
    const role = await db.transaction(
      true,
      () => {},
      async (client) =>
        (
          await client.query<{ role: string; readonly: string }>(
            "SELECT current_user AS role,current_setting('transaction_read_only') AS readonly",
          )
        ).rows[0]!,
    );
    assert.deepEqual(role, { role: 'tf_reconciler', readonly: 'on' });
    await assert.rejects(
      reconciler.query('DELETE FROM fi.fix_outbox WHERE sandbox_id=$1', [s.id]),
      { code: '42501' },
    );
    await assert.rejects(
      admin.query('INSERT INTO fi.fix_outbox(sandbox_id,message_id,order_id) VALUES($1,$2,$3)', [
        s.id,
        outgoing[0]!['id'],
        s.order,
      ]),
      { code: '23505' },
    );
    // Existing CHECK remains enforced even inside the approved corruption fixture.
    await assert.rejects(
      corruptOutbox(
        admin,
        "UPDATE fi.fix_outbox SET delivery_state='DELIVERED' WHERE sandbox_id=$1 AND message_id=$2",
        [s.id, outgoing[0]!['id']],
      ),
      { code: '23514' },
    );
    const assessment = await verifyFixFoundation(db, binding, () => {}, true);
    assert.equal(assessment.foundation_assessment, 'FOUNDATION_CONSISTENT');
    assert.deepEqual(assessment.findings, []);
    assert.deepEqual(scopeEvidence(assessment), {
      financial_watermark: '4',
      protocol_watermark: '6',
      protocol_ingest_watermark: '6',
      protocol_prepare_watermark: '0',
      protocol_application_watermark: '0',
      unresolved_work_count: 0,
      financial_ledger_consistency: 'NOT_EVALUATED',
      protocol_completeness: 'NOT_IMPLEMENTED',
      delivery_verified: false,
      financial_application_verified: false,
      complete: false,
      verified_scope: 'PROTOCOL_METADATA_ONLY',
    });
    assert.ok(
      isDeepStrictEqual(await durableFixSnapshot(s.id), before),
      'Read-only verification, rejected writes or retransmission changed persisted evidence.',
    );
    console.log(
      'Healthy outbox verification evidence:',
      JSON.stringify({
        messageTypes: ['D', 'F', '8', '9'],
        logicalMessages: 4,
        physicalAttempts: 5,
        outboxIntents: 2,
        duplicateIntentDenied: true,
        unsupportedDeliveryStateDenied: true,
        reconcilerReadOnly: true,
        scope: scopeEvidence(assessment),
      }),
    );
  } finally {
    await db.close();
    await reconciler.end();
    await admin.end();
    await s.close();
  }
});
for (const corruption of ['inbound', 'order', 'orphan', 'sandbox'] as const)
  void test(
    'independent verifier detects outbox ' +
      corruption +
      ' correspondence corruption with exact scoped identities',
    async () => {
      const s = await fixture(),
        cfg = await owner(),
        db = new VerificationDatabase(cfg.reconcilerUrl!),
        admin = await connection('admin');
      let other: Awaited<ReturnType<typeof fixture>> | undefined;
      const binding = {
        sandboxId: s.id,
        digest: s.proof,
        scope: 'trade' as const,
        generation: '1',
      };
      try {
        const differentOrder = corruption === 'order' ? await s.createOrder() : undefined;
        if (corruption === 'sandbox') other = await fixture();
        assert.equal((await s.bind()).status, 201);
        const out = await record(s, outboundFields(await report(s)));
        assert.equal(out.status, 201);
        const outgoing = String(out.body['message_id']);
        let incoming = '';
        if (corruption === 'inbound') {
          const reportResult = await record(s, await report(s));
          assert.equal(reportResult.status, 201);
          incoming = String(reportResult.body['message_id']);
        }
        const baseline = await verifyFixFoundation(db, binding, () => {}, true);
        assert.equal(baseline.foundation_assessment, 'FOUNDATION_CONSISTENT');
        assert.deepEqual(baseline.findings, []);
        const original = await durableFixSnapshot(s.id),
          foreignOriginal = other ? await durableFixSnapshot(other.id) : undefined;
        const orphan = randomUUID();
        let expected: { code: string; record_id: string }[];
        if (corruption === 'inbound') {
          await corruptOutbox(
            admin,
            'INSERT INTO fi.fix_outbox(sandbox_id,message_id,order_id) VALUES($1,$2,$3)',
            [s.id, incoming, s.order],
          );
          expected = [{ code: 'OUTBOX_REFERENCE', record_id: incoming }];
        } else if (corruption === 'order') {
          await corruptOutbox(
            admin,
            'UPDATE fi.fix_outbox SET order_id=$3 WHERE sandbox_id=$1 AND message_id=$2',
            [s.id, outgoing, differentOrder],
          );
          expected = [
            { code: 'MISSING_OUTBOX', record_id: outgoing },
            { code: 'OUTBOX_REFERENCE', record_id: outgoing },
          ];
        } else if (corruption === 'orphan') {
          await corruptOutbox(
            admin,
            'UPDATE fi.fix_outbox SET message_id=$3 WHERE sandbox_id=$1 AND message_id=$2',
            [s.id, outgoing, orphan],
          );
          expected = [
            { code: 'MISSING_OUTBOX', record_id: outgoing },
            { code: 'OUTBOX_REFERENCE', record_id: orphan },
          ];
        } else {
          assert.ok(other);
          await corruptOutbox(
            admin,
            'UPDATE fi.fix_outbox SET sandbox_id=$3 WHERE sandbox_id=$1 AND message_id=$2',
            [s.id, outgoing, other.id],
          );
          expected = [{ code: 'MISSING_OUTBOX', record_id: outgoing }];
        }
        const damaged = await durableFixSnapshot(s.id),
          foreignDamaged = other ? await durableFixSnapshot(other.id) : undefined;
        for (const table of Object.keys(original))
          if (table !== 'fix_outbox')
            assert.ok(
              isDeepStrictEqual(damaged[table], original[table]),
              'Corruption changed a table outside outbox: ' + table,
            );
        const assessment = await verifyFixFoundation(db, binding, () => {}, true);
        assert.equal(assessment.foundation_assessment, 'FOUNDATION_FINDINGS');
        assert.deepEqual(assessment.findings, expected);
        assert.equal(assessment.total_findings, expected.length);
        assert.deepEqual(scopeEvidence(assessment), scopeEvidence(baseline));
        const repeated = await verifyFixFoundation(db, binding, () => {}, true);
        assert.deepEqual(repeated.findings, expected);
        assert.deepEqual(scopeEvidence(repeated), scopeEvidence(baseline));
        if (other) {
          assert.ok(foreignOriginal && foreignDamaged);
          for (const table of Object.keys(foreignOriginal))
            if (table !== 'fix_outbox')
              assert.ok(isDeepStrictEqual(foreignOriginal[table], foreignDamaged[table]));
          const foreign = await verifyFixFoundation(
            db,
            { sandboxId: other.id, digest: other.proof, scope: 'trade', generation: '1' },
            () => {},
            true,
          );
          assert.equal(foreign.foundation_assessment, 'FOUNDATION_FINDINGS');
          assert.deepEqual(foreign.findings, [{ code: 'OUTBOX_REFERENCE', record_id: outgoing }]);
          assert.equal(foreign.protocol_watermark, '0');
          assert.equal(foreign.financial_watermark, '4');
          assert.ok(isDeepStrictEqual(await durableFixSnapshot(other.id), foreignDamaged));
        }
        assert.ok(
          isDeepStrictEqual(await durableFixSnapshot(s.id), damaged),
          'Verifier mutated corruption evidence.',
        );
        console.log(
          'Corrupt outbox verification evidence:',
          JSON.stringify({
            corruption,
            findings: assessment.findings,
            scope: scopeEvidence(assessment),
            foreignScopedFinding: other ? 'OUTBOX_REFERENCE' : null,
          }),
        );
      } finally {
        await admin.query('ROLLBACK');
        await db.close();
        await admin.end();
        await s.close();
        await other?.close();
      }
    },
  );
void test('FIX verification stays default OFF and rejects altered SQL before authorization or database access', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "\nimport assert from 'node:assert/strict';\nimport {mock} from 'node:test';\nimport * as fs from 'node:fs/promises';\nimport {pathToFileURL} from 'node:url';\nconst url=pathToFileURL(process.cwd()+'/verification/sql/fix_foundation.sql');\nconst sql=await fs.readFile(url,'utf8');\nlet reads=0,transactions=0,authorizations=0;\nmock.module('node:fs/promises',{exports:{...fs,readFile:async(file,...args)=>{\n if(file instanceof URL && file.href===url.href){reads++;return sql+'\\n-- unauthorized verifier edit\\n';}\n return fs.readFile(file,...args);\n}}});\nconst {verifyFixFoundation}=await import('./app/server/fix/reconciliation.ts');\nconst {DomainError}=await import('./app/domain/errors.ts');\nconst database={transaction(){transactions++;throw new Error('Guard reached database.');}};\nconst binding={sandboxId:'00000000-0000-4000-8000-000000000001',digest:'not-a-credential',scope:'trade',generation:'1'};\nconst verify=()=>{authorizations++;};\nawait assert.rejects(verifyFixFoundation(database,binding,verify),e=>e instanceof DomainError&&e.status===503&&e.code==='FIX_FOUNDATION_DISABLED');\nassert.equal(reads,0);\nawait assert.rejects(verifyFixFoundation(database,binding,verify,true),e=>e instanceof DomainError&&e.status===503&&e.code==='VERIFICATION_SOURCE_CHANGED');\nassert.equal(reads,1);assert.equal(transactions,0);assert.equal(authorizations,0);\nconsole.log(JSON.stringify({defaultOff:true,sourceChangeRejected:true,reads,transactions,authorizations}));\n",
    ],
    { cwd: process.cwd(), env: { ...process.env, TF_DB_OWNER_FILE: '' }, maxBuffer: 64 * 1024 },
  );
  assert.deepEqual(JSON.parse(stdout.trim()), {
    defaultOff: true,
    sourceChangeRejected: true,
    reads: 1,
    transactions: 0,
    authorizations: 0,
  });
});
