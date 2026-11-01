import { verifyOwned } from '../../scripts/owned-postgres.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { durableFixSnapshot } from './fix-recovery-evidence.js';
import { encodeFix44, decodeFix44 } from '../../app/protocol/fix44/index.js';
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

void test('independent verifier detects coherent message-price corruption against frozen contract terms', async () => {
  const owned = await verifyOwned(process.env.TF_DB_OWNER_FILE!);
  const cfg = await owner();
  assert.equal(cfg.adminUrl, owned.adminUrl);
  const s = await fixture(),
    admin = await connection('admin'),
    database = new VerificationDatabase(cfg.reconcilerUrl!);
  const binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' };
  try {
    assert.equal((await s.bind()).status, 201);
    const fields = await report(s),
      good = await record(s, fields);
    assert.equal(good.status, 201);
    const message = good.body['message_id'];
    assert.equal(typeof message, 'string');
    const baseline = await verifyFixFoundation(database, binding, () => {}, true);
    assert.equal(baseline.foundation_assessment, 'FOUNDATION_CONSISTENT');
    assert.deepEqual(baseline.findings, []);
    const original = await durableFixSnapshot(s.id);
    const wrong = { ...fields, '44': '999.000000000000' };
    assert.notEqual(wrong['44'], fields['44']);
    const raw = encodeFix44(wrong),
      decoded = decodeFix44(raw).fields;
    assert.equal(decoded['44'], wrong['44']);
    // The normal authenticated writer correctly rejects these contract-incompatible bytes.
    const admission = await record(s, wrong, randomUUID());
    assert.equal(admission.status, 400);
    assert.equal((admission.body['error'] as { code: string }).code, 'FIX_PROFILE_VIOLATION');
    assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), original));

    // Existing test-only coherent-corruption fixture, restricted to the owned instance.
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    const changed = await admin.query(
      "UPDATE fi.fix_messages SET fields=$3::jsonb,semantic_hash=encode(sha256(convert_to(($3::jsonb-ARRAY['8','9','10','34','43','52','122'])::text,'UTF8')),'hex') WHERE sandbox_id=$1 AND id=$2",
      [s.id, message, JSON.stringify(decoded)],
    );
    assert.equal(changed.rowCount, 1);
    const physical = await admin.query(
      "UPDATE fi.fix_attempts SET raw_bytes=$3::bytea,raw_hash=encode(sha256($3::bytea),'hex') WHERE sandbox_id=$1 AND message_id=$2",
      [s.id, message, raw],
    );
    assert.equal(physical.rowCount, 1);
    await admin.query('COMMIT');
    const damaged = await durableFixSnapshot(s.id);
    for (const table of Object.keys(original))
      if (!['fix_messages', 'fix_attempts'].includes(table))
        assert.ok(
          isDeepStrictEqual(damaged[table], original[table]),
          'Unexpected corruption outside wire evidence: ' + table,
        );
    const values = (
      await admin.query<{
        message_price: string;
        contract_price: string;
        semantic_hash_valid: boolean;
        raw_hash_valid: boolean;
      }>(
        "SELECT m.fields->>'44' AS message_price,o.contract->>'clean_price' AS contract_price,m.semantic_hash=encode(sha256(convert_to((m.fields-ARRAY['8','9','10','34','43','52','122'])::text,'UTF8')),'hex') AS semantic_hash_valid,a.raw_hash=encode(sha256(a.raw_bytes),'hex') AS raw_hash_valid FROM fi.fix_messages m JOIN fi.orders o ON(o.sandbox_id,o.id)=(m.sandbox_id,m.order_id) JOIN fi.fix_attempts a ON(a.sandbox_id,a.message_id)=(m.sandbox_id,m.id) WHERE m.sandbox_id=$1 AND m.id=$2",
        [s.id, message],
      )
    ).rows[0]!;
    assert.notEqual(values.message_price, values.contract_price);
    assert.equal(values.semantic_hash_valid, true);
    assert.equal(values.raw_hash_valid, true);
    const actual = await verifyFixFoundation(database, binding, () => {}, true);
    assert.ok(
      isDeepStrictEqual(await durableFixSnapshot(s.id), damaged),
      'Verification changed data.',
    );
    console.log(
      'Contract-integrity verification evidence:',
      JSON.stringify({
        message,
        normalWriterStatus: admission.status,
        normalWriterCode: 'FIX_PROFILE_VIOLATION',
        values,
        baseline: baseline.foundation_assessment,
        actual: actual.foundation_assessment,
        findings: actual.findings,
        financialWatermark: actual.financial_watermark,
        protocolWatermark: actual.protocol_watermark,
        financialApplication: actual.financial_application_verified,
        delivery: actual.delivery_verified,
        executions: damaged['executions']!.length,
      }),
    );
    assert.equal(
      actual.foundation_assessment,
      'FOUNDATION_FINDINGS',
      'Independent verifier must reject wire evidence that contradicts the frozen order contract.',
    );
    const expected = [
      { code: 'MESSAGE_CONTRACT', record_id: message },
      ...recordEvidenceFindings(original, String(message)),
    ];
    assert.deepEqual(actual.findings, expected);
    assert.equal(actual.total_findings, expected.length);
    assert.deepEqual(scopeEvidence(actual), scopeEvidence(baseline));
  } finally {
    await admin.query('ROLLBACK');
    await database.close();
    await s.close();
    const cleanup = (
      await admin.query<{ sandboxes: number; retained: number }>(
        'SELECT (SELECT count(*)::int FROM fi.sandboxes) AS sandboxes,retained_count AS retained FROM fi_control.service_capacity WHERE singleton',
      )
    ).rows[0]!;
    console.log('Acceptance diagnostic cleanup:', JSON.stringify(cleanup));
    assert.deepEqual(cleanup, { sandboxes: 0, retained: 0 });
    await admin.end();
  }
});

type ContractSandbox = Awaited<ReturnType<typeof fixture>>;
type ContractContext = {
  s: ContractSandbox;
  admin: Awaited<ReturnType<typeof connection>>;
  database: VerificationDatabase;
  binding: { sandboxId: string; digest: string; scope: 'trade'; generation: string };
};
async function withContractSandbox(
  run: (context: ContractContext) => Promise<void>,
  side = 'BUY',
  instrument = 'SYN-UST-2031',
) {
  const original = await fixture(),
    cfg = await owner(),
    admin = await connection('admin'),
    database = new VerificationDatabase(cfg.reconcilerUrl!);
  try {
    const order =
      side === 'BUY' && instrument === 'SYN-UST-2031'
        ? original.order
        : await original.createOrder('100.00', side, instrument);
    const s = { ...original, order };
    const bound = await s.fix('BIND', {
      order_id: order,
      dealer_id: 'ATLAS',
      channel_id: s.channel,
    });
    assert.equal(bound.status, 201);
    await run({
      s,
      admin,
      database,
      binding: { sandboxId: s.id, digest: s.proof, scope: 'trade', generation: '1' },
    });
  } finally {
    await database.close();
    await admin.end();
    await original.close();
  }
}
function cancelFields(
  base: Awaited<ReturnType<typeof report>>,
  type: 'F' | '9',
  order: string,
  sequence: string,
) {
  const fields = Object.fromEntries(
    (type === 'F'
      ? (['35', '49', '56', '34', '52', '37', '55', '167', '54', '38', '60'] as const)
      : (['35', '49', '56', '34', '52', '37', '60'] as const)
    ).map((tag) => [tag, base[tag]]),
  );
  Object.assign(fields, { '35': type, '34': sequence, '11': randomUUID(), '41': order });
  if (type === 'F') Object.assign(fields, { '49': 'TRADEFLOW', '56': 'ATLAS' });
  else Object.assign(fields, { '39': '0', '434': '1', '102': '99' });
  return fields;
}
function executionVariants(
  base: Awaited<ReturnType<typeof report>>,
  order: string,
): { name: string; fields: Record<string, string> }[] {
  const price = base['44'];
  return [
    { name: 'new', fields: { ...base } },
    { name: 'rejected', fields: { ...base, '150': '8', '39': '8', '151': '0.00', '103': '99' } },
    {
      name: 'duplicate rejection',
      fields: { ...base, '150': '8', '39': '8', '151': '0.00', '103': '6' },
    },
    {
      name: 'partial trade',
      fields: {
        ...base,
        '150': 'F',
        '39': '1',
        '14': '40.00',
        '151': '60.00',
        '32': '40.00',
        '31': price,
        '6': price,
      },
    },
    {
      name: 'full trade',
      fields: {
        ...base,
        '150': 'F',
        '39': '2',
        '14': '100.00',
        '151': '0.00',
        '32': '60.00',
        '31': price,
        '6': price,
      },
    },
    {
      name: 'pending cancel before fills',
      fields: { ...base, '150': '6', '39': '6', '11': randomUUID(), '41': order },
    },
    {
      name: 'pending cancel after fills',
      fields: {
        ...base,
        '150': '6',
        '39': '6',
        '11': randomUUID(),
        '41': order,
        '14': '40.00',
        '151': '60.00',
        '6': price,
      },
    },
    {
      name: 'trade while cancel pending',
      fields: {
        ...base,
        '150': 'F',
        '39': '6',
        '14': '60.00',
        '151': '40.00',
        '32': '20.00',
        '31': price,
        '6': price,
      },
    },
    {
      name: 'full trade while cancel pending',
      fields: {
        ...base,
        '150': 'F',
        '39': '6',
        '14': '100.00',
        '151': '0.00',
        '32': '40.00',
        '31': price,
        '6': price,
      },
    },
    {
      name: 'canceled before fills',
      fields: { ...base, '150': '4', '39': '4', '11': randomUUID(), '41': order, '151': '0.00' },
    },
    {
      name: 'canceled after fills',
      fields: {
        ...base,
        '150': '4',
        '39': '4',
        '11': randomUUID(),
        '41': order,
        '14': '40.00',
        '151': '0.00',
        '6': price,
      },
    },
  ];
}
async function contractMessage(
  context: ContractContext,
  type: 'D' | '8' | 'F' | '9',
  trade = false,
) {
  const { s, database, binding } = context,
    base = await report(s);
  let fields: Record<string, string>;
  if (type === 'D') fields = outboundFields(base);
  else if (type === '8')
    fields = trade
      ? {
          ...base,
          '150': 'F',
          '39': '1',
          '14': '40.00',
          '151': '60.00',
          '32': '40.00',
          '31': base['44'],
          '6': base['44'],
        }
      : { ...base };
  else {
    assert.equal((await record(s, base)).status, 201); // establish the accepted dealer OrderID
    fields = cancelFields(base, type, s.order, type === '9' ? '2' : '1');
  }
  const attempt = randomUUID(),
    result = await record(s, fields, randomUUID(), attempt);
  assert.equal(result.status, 201);
  assert.equal(typeof result.body['message_id'], 'string');
  const message = String(result.body['message_id']);
  const healthy = await verifyFixFoundation(database, binding, () => {}, true);
  assert.equal(healthy.foundation_assessment, 'FOUNDATION_CONSISTENT');
  assert.deepEqual(healthy.findings, []);
  return { fields, attempt, message, healthy, original: await durableFixSnapshot(s.id) };
}
// Test-only framing for deliberately invalid business fields. Production codec is unchanged.
// Preserve header/body order, then recompute byte BodyLength and CheckSum independently.
function reframe(original: Buffer, patch: Record<string, string | null>) {
  const parts = original
    .toString('ascii')
    .split('\x01')
    .filter(Boolean)
    .map((part) => [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)] as const)
    .filter(([tag]) => !['8', '9', '10'].includes(tag));
  const pairs: [string, string][] = [];
  for (const [tag, value] of parts) {
    const replacement = Object.hasOwn(patch, tag) ? patch[tag] : value;
    if (replacement !== null) pairs.push([tag, replacement!]);
  }
  for (const [tag, value] of Object.entries(patch))
    if (value !== null && !parts.some(([existing]) => existing === tag)) pairs.push([tag, value]);
  const body = Buffer.from(
    pairs.map(([tag, value]) => tag + '=' + value + '\x01').join(''),
    'ascii',
  );
  const prefix = Buffer.concat([
    Buffer.from('8=FIX.4.4\x019=' + body.length + '\x01', 'ascii'),
    body,
  ]);
  const checksum = prefix
    .reduce((sum, byte) => (sum + byte) % 256, 0)
    .toString()
    .padStart(3, '0');
  const raw = Buffer.concat([prefix, Buffer.from('10=' + checksum + '\x01', 'ascii')]);
  const fields: Record<string, unknown> = Object.fromEntries(
    raw
      .toString('ascii')
      .split('\x01')
      .filter(Boolean)
      .map((part) => [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)]),
  );
  return { raw, fields };
}
async function corruptContractEvidence(
  context: ContractContext,
  target: Awaited<ReturnType<typeof contractMessage>>,
  patch: Record<string, string | null>,
  mode: 'coherent' | 'raw-only' | 'stored-only' = 'coherent',
  jsonPatch: Record<string, unknown> = {},
) {
  const row = target.original['fix_attempts']!.find((a) => a['id'] === target.attempt)!;
  const changed = reframe(Buffer.from(String(row['raw_bytes']).slice(2), 'hex'), patch);
  await context.admin.query('BEGIN');
  try {
    await context.admin.query("SET LOCAL session_replication_role='replica'");
    if (mode !== 'raw-only') {
      const fields = { ...changed.fields, ...jsonPatch };
      const updated = await context.admin.query(
        "UPDATE fi.fix_messages SET fields=$3::jsonb,semantic_hash=encode(sha256(convert_to(($3::jsonb-ARRAY['8','9','10','34','43','52','122'])::text,'UTF8')),'hex') WHERE sandbox_id=$1 AND id=$2",
        [context.s.id, target.message, JSON.stringify(fields)],
      );
      assert.equal(updated.rowCount, 1);
    }
    if (mode !== 'stored-only') {
      const updated = await context.admin.query(
        "UPDATE fi.fix_attempts SET raw_bytes=$3::bytea,raw_hash=encode(sha256($3::bytea),'hex') WHERE sandbox_id=$1 AND id=$2",
        [context.s.id, target.attempt, changed.raw],
      );
      assert.equal(updated.rowCount, 1);
    }
    await context.admin.query('COMMIT');
  } catch (error) {
    await context.admin.query('ROLLBACK');
    throw error;
  }
}
async function assertContractFinding(
  context: ContractContext,
  target: Awaited<ReturnType<typeof contractMessage>>,
  mixedRepresentations = false,
) {
  const damaged = await durableFixSnapshot(context.s.id);
  for (const table of Object.keys(target.original))
    if (!['fix_messages', 'fix_attempts'].includes(table))
      assert.ok(
        isDeepStrictEqual(damaged[table], target.original[table]),
        'Contract corruption changed non-wire state: ' + table,
      );
  const assessment = await verifyFixFoundation(context.database, context.binding, () => {}, true);
  const expected = [
    { code: 'MESSAGE_CONTRACT', record_id: target.message },
    ...recordEvidenceFindings(target.original, target.message),
  ];
  if (mixedRepresentations) expected.push({ code: 'WIRE_SEMANTICS', record_id: target.attempt });
  assert.equal(assessment.foundation_assessment, 'FOUNDATION_FINDINGS');
  assert.deepEqual(assessment.findings, expected);
  assert.equal(assessment.total_findings, expected.length);
  assert.deepEqual(scopeEvidence(assessment), scopeEvidence(target.healthy));
  const repeated = await verifyFixFoundation(context.database, context.binding, () => {}, true);
  assert.deepEqual(repeated.findings, expected);
  assert.deepEqual(scopeEvidence(repeated), scopeEvidence(target.healthy));
  assert.ok(
    isDeepStrictEqual(await durableFixSnapshot(context.s.id), damaged),
    'Verifier changed corrupted evidence.',
  );
}

for (const [side, instrument] of [
  ['BUY', 'SYN-UST-2031'],
  ['SELL', 'SYN-UST-2031'],
  ['BUY', 'SYN-CORP-2031'],
  ['SELL', 'SYN-CORP-2031'],
])
  void test(
    'exact frozen terms and all supported report variants remain healthy for ' +
      side +
      ' ' +
      instrument,
    async () => {
      await withContractSandbox(
        async (context) => {
          const { s, database, binding } = context,
            base = await report(s),
            before = await durableFixSnapshot(s.id),
            messages: string[] = [];
          let inbound = 0;
          const variants = executionVariants(base, s.order);
          // Metadata observations are not financial transitions or a counterparty/session simulation.
          for (const variant of variants) {
            const fields = {
              ...variant.fields,
              '34': String(++inbound),
              '17': 'ATLAS-' + randomUUID().toUpperCase(),
            };
            const result = await record(s, fields);
            assert.equal(result.status, 201, variant.name);
            messages.push(String(result.body['message_id']));
          }
          const outbound = await record(s, outboundFields(base));
          assert.equal(outbound.status, 201);
          messages.push(String(outbound.body['message_id']));
          const cancellation = await record(s, cancelFields(base, 'F', s.order, '2'));
          assert.equal(cancellation.status, 201);
          messages.push(String(cancellation.body['message_id']));
          for (const [status, reason] of [
            ['0', '99'],
            ['1', '99'],
            ['2', '0'],
          ]) {
            const result = await record(s, {
              ...cancelFields(base, '9', s.order, String(++inbound)),
              '39': status!,
              '102': reason!,
            });
            assert.equal(result.status, 201);
            messages.push(String(result.body['message_id']));
          }
          const state = await durableFixSnapshot(s.id);
          assert.equal(messages.length, 16);
          assert.equal(new Set(messages).size, 16);
          assert.equal(state['fix_messages']!.length, 16);
          assert.equal(state['fix_attempts']!.length, 16);
          assert.equal(state['fix_outbox']!.length, 2);
          for (const table of [
            'sandboxes',
            'commands',
            'audit_events',
            'orders',
            'order_states',
            'executions',
            'positions',
            'cancellation_requests',
            'cancellation_outcomes',
            'order_history',
          ])
            assert.ok(
              isDeepStrictEqual(state[table], before[table]),
              'Healthy FIX metadata changed ' + table,
            );
          const result = await verifyFixFoundation(database, binding, () => {}, true);
          assert.equal(result.foundation_assessment, 'FOUNDATION_CONSISTENT');
          assert.deepEqual(result.findings, []);
          assert.equal(result.protocol_watermark, '17');
          assert.equal(result.protocol_ingest_watermark, '17');
          assert.equal(
            result.financial_watermark,
            String(before['sandboxes']![0]!['command_count']),
          );
          assert.equal(result.financial_application_verified, false);
          assert.equal(result.delivery_verified, false);
          assert.equal(result.complete, false);
          assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), state));
          console.log(
            'Healthy contract matrix:',
            JSON.stringify({
              side,
              instrument,
              executionVariants: variants.map((v) => v.name),
              messages: 16,
              outbox: 2,
              assessment: result.foundation_assessment,
            }),
          );
        },
        side,
        instrument,
      );
    },
  );
const termMutations: { name: string; patch: Record<string, string | null> }[] = [
  { name: 'instrument pair', patch: { '55': 'SYN-CORP-2031', '167': 'CORP' } },
  { name: 'security type', patch: { '167': 'CORP' } },
  { name: 'client side', patch: { '54': '2' } },
  { name: 'original total par', patch: { '38': '101.00' } },
  { name: 'contractual clean price', patch: { '44': '999.000000000000' } },
  { name: 'settlement date', patch: { '64': '20280301' } },
  { name: 'quantity type', patch: { '854': '1' } },
  { name: 'order type', patch: { '40': '1' } },
  { name: 'time in force', patch: { '59': '0' } },
  { name: 'price type', patch: { '423': '2' } },
  { name: 'currency', patch: { '15': 'EUR' } },
];
for (const type of ['D', '8', 'F'] as const)
  void test(
    'independent ' + type + ' contract matrix rejects each applicable coherently rewritten term',
    async () => {
      const applicable = type === 'F' ? termMutations.slice(0, 4) : termMutations;
      for (const mutation of applicable)
        await withContractSandbox(async (context) => {
          const target = await contractMessage(context, type);
          const patch = { ...mutation.patch };
          if (type === '8' && mutation.name === 'original total par') patch['151'] = '101.00';
          await corruptContractEvidence(context, target, patch);
          await assertContractFinding(context, target);
        });
      console.log(
        'Contract term corruption matrix:',
        JSON.stringify({ type, cases: applicable.map((m) => m.name) }),
      );
    },
  );
void test('filled execution price remains contractual even when Price, LastPx and AvgPx are coherently changed together', async () => {
  await withContractSandbox(async (context) => {
    const target = await contractMessage(context, '8', true);
    await corruptContractEvidence(context, target, {
      '44': '999.000000000000',
      '31': '999.000000000000',
      '6': '999.000000000000',
    });
    await assertContractFinding(context, target);
  });
});
void test('execution-report quantities, prices and conditional fields fail closed without applying financial effects', async () => {
  const cases: { name: string; trade: boolean; patch: Record<string, string | null> }[] = [
    { name: 'zero-fill average', trade: false, patch: { '6': '1.000000000000' } },
    { name: 'filled average', trade: true, patch: { '6': '0.000000000000' } },
    { name: 'last price', trade: true, patch: { '31': '999.000000000000' } },
    { name: 'last quantity above cumulative', trade: true, patch: { '32': '40.01' } },
    { name: 'zero last quantity', trade: true, patch: { '32': '0.00' } },
    { name: 'missing last quantity', trade: true, patch: { '32': null } },
    { name: 'cumulative and leaves', trade: true, patch: { '151': '59.99' } },
    {
      name: 'partial status at full amount',
      trade: true,
      patch: { '14': '100.00', '151': '0.00' },
    },
    { name: 'full status with partial amount', trade: true, patch: { '39': '2' } },
    { name: 'nontrade last quantity', trade: false, patch: { '32': '1.00' } },
    {
      name: 'missing reject reason',
      trade: false,
      patch: { '150': '8', '39': '8', '151': '0.00' },
    },
    { name: 'cancel report without original ID', trade: false, patch: { '150': '6', '39': '6' } },
  ];
  for (const item of cases)
    await withContractSandbox(async (context) => {
      const target = await contractMessage(context, '8', item.trade);
      await corruptContractEvidence(context, target, item.patch);
      await assertContractFinding(context, target);
    });
  console.log(
    'Execution contract negative matrix:',
    JSON.stringify({ cases: cases.map((c) => c.name) }),
  );
});
void test('missing, malformed and nonstring contractual evidence yields bounded findings instead of SQL errors', async () => {
  const cases: {
    name: string;
    patch: Record<string, string | null>;
    json?: Record<string, unknown>;
  }[] = [
    { name: 'missing price', patch: { '44': null } },
    { name: 'nonnumeric total par', patch: { '38': 'not-a-quantity' } },
    { name: 'nonnumeric cumulative', patch: { '14': 'NaN' } },
    { name: 'oversized cumulative representation', patch: { '14': '9'.repeat(200) + '.00' } },
    { name: 'missing cumulative', patch: { '14': null } },
    { name: 'JSON null price', patch: {}, json: { '44': null } },
    { name: 'JSON numeric quantity type', patch: {}, json: { '854': 0 } },
    { name: 'JSON object cumulative', patch: {}, json: { '14': { unexpected: 'synthetic' } } },
    { name: 'JSON array quantity', patch: {}, json: { '38': [] } },
  ];
  for (const item of cases)
    await withContractSandbox(async (context) => {
      const target = await contractMessage(context, '8');
      await corruptContractEvidence(context, target, item.patch, 'coherent', item.json);
      await assertContractFinding(context, target, Boolean(item.json));
    });
  console.log(
    'Malformed contract evidence matrix:',
    JSON.stringify({ cases: cases.map((c) => c.name) }),
  );
});
void test('stored message and independently decoded physical evidence are each checked against frozen terms', async () => {
  for (const mode of ['stored-only', 'raw-only'] as const)
    await withContractSandbox(async (context) => {
      const target = await contractMessage(context, '8');
      await corruptContractEvidence(context, target, { '44': '999.000000000000' }, mode);
      await assertContractFinding(context, target, true);
    });
});

void test('independent verifier detects missing sole physical attempts and sequence slots for retained IN and OUT messages', async () => {
  const observations: {
    assessment: FixAssessment;
    expected: { code: string; record_id: string }[];
  }[] = [];
  for (const direction of ['IN', 'OUT'] as const)
    await withContractSandbox(async ({ s, admin, database, binding }) => {
      const reconciler = await connection('reconciler');
      try {
        const base = await report(s),
          incomingAttempt = randomUUID(),
          outgoingAttempt = randomUUID(),
          incomingKey = randomUUID(),
          outgoingKey = randomUUID(),
          incoming = await record(s, base, incomingKey, incomingAttempt),
          outgoing = await record(s, outboundFields(base), outgoingKey, outgoingAttempt);
        assert.equal(incoming.status, 201);
        assert.equal(outgoing.status, 201);
        assert.equal(incoming.body['financial_applied'], false);
        assert.equal(outgoing.body['financial_applied'], false);
        const message = String((direction === 'IN' ? incoming : outgoing).body['message_id']),
          attempt = direction === 'IN' ? incomingAttempt : outgoingAttempt,
          key = direction === 'IN' ? incomingKey : outgoingKey,
          original = await durableFixSnapshot(s.id),
          receipt = String(
            original['fix_commands']!.find((c) => c['idempotency_key'] === key)!['id'],
          );
        assert.equal(original['fix_messages']!.length, 2);
        assert.deepEqual(original['fix_messages']!.map((m) => m['direction']).sort(), [
          'IN',
          'OUT',
        ]);
        assert.equal(original['fix_attempts']!.length, 2);
        assert.equal(original['fix_sequence_slots']!.length, 2);
        assert.equal(original['fix_outbox']!.length, 1);
        assert.equal(
          original['fix_attempts']!.filter((a) => a['message_id'] === message).length,
          1,
        );
        const healthy = await verifyFixFoundation(database, binding, () => {}, true);
        assert.equal(healthy.foundation_assessment, 'FOUNDATION_CONSISTENT');
        assert.deepEqual(healthy.findings, []);
        for (const client of [s.app, reconciler]) {
          await assert.rejects(
            client.query('DELETE FROM fi.fix_attempts WHERE sandbox_id=$1 AND id=$2', [
              s.id,
              attempt,
            ]),
            { code: '42501' },
          );
          await assert.rejects(
            client.query(
              'DELETE FROM fi.fix_sequence_slots WHERE sandbox_id=$1 AND message_id=$2',
              [s.id, message],
            ),
            { code: '42501' },
          );
        }
        assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), original));
        await corruptOutbox(admin, 'DELETE FROM fi.fix_attempts WHERE sandbox_id=$1 AND id=$2', [
          s.id,
          attempt,
        ]);
        await corruptOutbox(
          admin,
          'DELETE FROM fi.fix_sequence_slots WHERE sandbox_id=$1 AND message_id=$2',
          [s.id, message],
        );
        const damaged = await durableFixSnapshot(s.id);
        assert.ok(
          isDeepStrictEqual(damaged, {
            ...original,
            fix_attempts: original['fix_attempts']!.filter((a) => a['id'] !== attempt),
            fix_sequence_slots: original['fix_sequence_slots']!.filter(
              (x) => x['message_id'] !== message,
            ),
          }),
          'Corruption must retain the logical messages, successful receipts, outbox and opposite-direction graph.',
        );
        const assessment = await verifyFixFoundation(database, binding, () => {}, true),
          repeated = await verifyFixFoundation(database, binding, () => {}, true),
          expected = [
            { code: 'MESSAGE_SEQUENCE', record_id: message },
            { code: 'MISSING_PHYSICAL_EVIDENCE', record_id: message },
            { code: 'RECORD_EVIDENCE', record_id: receipt },
          ];
        console.log(
          'Missing sole physical evidence assessment:',
          JSON.stringify({
            direction,
            message,
            attempt,
            receipt,
            healthy: healthy.foundation_assessment,
            corrupted: assessment.foundation_assessment,
            findings: assessment.findings,
            logicalMessages: damaged['fix_messages']!.length,
            physicalAttempts: damaged['fix_attempts']!.length,
            sequenceSlots: damaged['fix_sequence_slots']!.length,
            outboxIntents: damaged['fix_outbox']!.length,
            appAndReconcilerDeletionDenied: true,
            scope: scopeEvidence(assessment),
          }),
        );
        assert.deepEqual(scopeEvidence(assessment), scopeEvidence(healthy));
        assert.deepEqual(repeated.findings, assessment.findings);
        assert.deepEqual(scopeEvidence(repeated), scopeEvidence(healthy));
        assert.ok(
          isDeepStrictEqual(await durableFixSnapshot(s.id), damaged),
          'Verifier mutated retained evidence.',
        );
        observations.push({ assessment, expected });
      } finally {
        await reconciler.end();
      }
    });
  for (const { assessment, expected } of observations) {
    assert.equal(assessment.foundation_assessment, 'FOUNDATION_FINDINGS');
    assert.deepEqual(assessment.findings, expected);
    assert.equal(assessment.total_findings, expected.length);
  }
});

void test('independent verifier detects a lost physical retransmission attempt while its same-sequence sibling and successful receipt survive', async () => {
  await withContractSandbox(async ({ s, admin, database, binding }) => {
    const base = await report(s),
      lostAttempt = randomUUID(),
      survivingAttempt = randomUUID(),
      lostKey = randomUUID(),
      first = await record(s, base, lostKey, lostAttempt),
      retransmission = await record(
        s,
        {
          ...base,
          '43': 'Y',
          '122': base['52'],
          '52': '20261030-12:01:00.000',
        },
        randomUUID(),
        survivingAttempt,
      ),
      outgoing = await record(s, outboundFields(base));
    assert.equal(first.status, 201);
    assert.equal(retransmission.status, 201);
    assert.equal(outgoing.status, 201);
    assert.equal(retransmission.body['message_id'], first.body['message_id']);
    assert.equal(retransmission.body['logical_duplicate'], true);
    assert.equal(retransmission.body['physical_duplicate'], false);
    const message = String(first.body['message_id']),
      original = await durableFixSnapshot(s.id),
      receipt = String(
        original['fix_commands']!.find((c) => c['idempotency_key'] === lostKey)!['id'],
      );
    assert.equal(original['fix_messages']!.length, 2);
    assert.equal(original['fix_attempts']!.length, 3);
    assert.equal(original['fix_sequence_slots']!.length, 2);
    assert.equal(original['fix_attempts']!.filter((a) => a['message_id'] === message).length, 2);
    assert.equal(
      original['fix_sequence_slots']!.filter(
        (x) => x['message_id'] === message && x['message_seq'] === 1,
      ).length,
      1,
    );
    const healthy = await verifyFixFoundation(database, binding, () => {}, true);
    assert.equal(healthy.foundation_assessment, 'FOUNDATION_CONSISTENT');
    assert.deepEqual(healthy.findings, []);
    await assert.rejects(
      s.app.query('DELETE FROM fi.fix_attempts WHERE sandbox_id=$1 AND id=$2', [s.id, lostAttempt]),
      { code: '42501' },
    );
    assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), original));
    await corruptOutbox(admin, 'DELETE FROM fi.fix_attempts WHERE sandbox_id=$1 AND id=$2', [
      s.id,
      lostAttempt,
    ]);
    const damaged = await durableFixSnapshot(s.id);
    assert.ok(
      isDeepStrictEqual(damaged, {
        ...original,
        fix_attempts: original['fix_attempts']!.filter((a) => a['id'] !== lostAttempt),
      }),
      'Only the named physical attempt may be removed; its receipt and same-sequence sibling must survive.',
    );
    assert.ok(
      damaged['fix_attempts']!.some(
        (a) => a['id'] === survivingAttempt && a['message_id'] === message,
      ),
    );
    const assessment = await verifyFixFoundation(database, binding, () => {}, true),
      repeated = await verifyFixFoundation(database, binding, () => {}, true);
    console.log(
      'Lost retransmission evidence assessment:',
      JSON.stringify({
        message,
        lostAttempt,
        survivingAttempt,
        receipt,
        healthy: healthy.foundation_assessment,
        corrupted: assessment.foundation_assessment,
        findings: assessment.findings,
        logicalMessages: damaged['fix_messages']!.length,
        physicalAttempts: damaged['fix_attempts']!.length,
        sequenceSlots: damaged['fix_sequence_slots']!.length,
        retainedReceipt: true,
        appDeletionDenied: true,
        scope: scopeEvidence(assessment),
      }),
    );
    assert.deepEqual(scopeEvidence(assessment), scopeEvidence(healthy));
    assert.deepEqual(repeated.findings, assessment.findings);
    assert.deepEqual(scopeEvidence(repeated), scopeEvidence(healthy));
    assert.ok(
      isDeepStrictEqual(await durableFixSnapshot(s.id), damaged),
      'Verifier mutated retained evidence.',
    );
    assert.equal(assessment.foundation_assessment, 'FOUNDATION_FINDINGS');
    assert.deepEqual(assessment.findings, [{ code: 'RECORD_EVIDENCE', record_id: receipt }]);
    assert.equal(assessment.total_findings, 1);
  });
});

type EvidenceFinding = { code: string; record_id: string };
function recordEvidenceFindings(
  snapshot: Awaited<ReturnType<typeof durableFixSnapshot>>,
  message: string,
) {
  const receipts = snapshot['fix_commands']!.filter(
    (c) =>
      c['operation'] === 'RECORD' &&
      (c['response_body'] as Record<string, unknown>)['message_id'] === message,
  );
  assert.ok(receipts.length > 0, 'A successful RECORD receipt must predate the corruption.');
  return receipts
    .map((c) => ({ code: 'RECORD_EVIDENCE', record_id: String(c['id']) }))
    .sort((a, b) => (a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0));
}
async function assertReverseEvidence(
  context: ContractContext,
  original: Awaited<ReturnType<typeof durableFixSnapshot>>,
  healthy: FixAssessment,
  expected: EvidenceFinding[],
  changedTables: string[],
) {
  const damaged = await durableFixSnapshot(context.s.id);
  for (const table of Object.keys(original))
    if (!changedTables.includes(table))
      assert.ok(
        isDeepStrictEqual(damaged[table], original[table]),
        'Unexpected corruption outside ' + changedTables.join(', ') + ': ' + table,
      );
  const findings = [...expected].sort((a, b) =>
    a.code < b.code
      ? -1
      : a.code > b.code
        ? 1
        : a.record_id < b.record_id
          ? -1
          : a.record_id > b.record_id
            ? 1
            : 0,
  );
  const assessment = await verifyFixFoundation(context.database, context.binding, () => {}, true);
  assert.equal(assessment.foundation_assessment, 'FOUNDATION_FINDINGS');
  assert.deepEqual(assessment.findings, findings);
  assert.equal(assessment.total_findings, findings.length);
  assert.deepEqual(scopeEvidence(assessment), scopeEvidence(healthy));
  const repeated = await verifyFixFoundation(context.database, context.binding, () => {}, true);
  assert.deepEqual(repeated.findings, findings);
  assert.deepEqual(scopeEvidence(repeated), scopeEvidence(healthy));
  assert.ok(
    isDeepStrictEqual(await durableFixSnapshot(context.s.id), damaged),
    'Verifier mutated damaged evidence.',
  );
}
async function rewriteRecordReceipt(context: ContractContext, receipt: string, body: unknown) {
  // Keep the audit payload coherent for object bodies, so receipt checks have an independent oracle.
  if (body !== null && typeof body === 'object' && !Array.isArray(body))
    await corruptOutbox(
      context.admin,
      "WITH changed AS (UPDATE fi.fix_commands SET response_body=$3::jsonb WHERE sandbox_id=$1 AND id=$2 RETURNING sandbox_id,command_seq,response_body) UPDATE fi.fix_events e SET payload=jsonb_build_object('financial_applied',false,'record',changed.response_body-'payload') FROM changed WHERE (e.sandbox_id,e.command_seq)=(changed.sandbox_id,changed.command_seq)",
      [context.s.id, receipt, JSON.stringify(body)],
    );
  else
    await corruptOutbox(
      context.admin,
      'UPDATE fi.fix_commands SET response_body=$3::jsonb WHERE sandbox_id=$1 AND id=$2',
      [context.s.id, receipt, JSON.stringify(body)],
    );
}

void test('healthy reverse evidence retains one logical identity across same/new-sequence retransmission, physical reuse and original-key replay', async () => {
  for (const direction of ['IN', 'OUT'] as const)
    await withContractSandbox(async ({ s, database, binding }) => {
      const base = await report(s),
        fields = direction === 'IN' ? base : outboundFields(base),
        key = randomUUID(),
        attempt = randomUUID(),
        first = await record(s, fields, key, attempt);
      assert.equal(first.status, 201);
      assert.equal(first.body['logical_duplicate'], false);
      assert.equal(first.body['physical_duplicate'], false);
      const initial = await durableFixSnapshot(s.id);
      assert.equal(initial['fix_messages']!.length, 1);
      assert.equal(initial['fix_attempts']!.length, 1);
      assert.equal(initial['fix_sequence_slots']!.length, 1);
      const initialAssessment = await verifyFixFoundation(database, binding, () => {}, true);
      assert.equal(initialAssessment.foundation_assessment, 'FOUNDATION_CONSISTENT');
      assert.deepEqual(initialAssessment.findings, []);
      assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), initial));
      const reused = await record(s, fields, randomUUID(), attempt);
      assert.equal(reused.status, 201);
      assert.equal(reused.body['message_id'], first.body['message_id']);
      assert.equal(reused.body['logical_duplicate'], true);
      assert.equal(reused.body['physical_duplicate'], true);
      const reusedState = await durableFixSnapshot(s.id);
      assert.equal(reusedState['fix_commands']!.length, initial['fix_commands']!.length + 1);
      assert.equal(reusedState['fix_events']!.length, initial['fix_events']!.length + 1);
      for (const table of Object.keys(initial))
        if (!['fix_commands', 'fix_events', 'command_keys'].includes(table))
          assert.ok(
            isDeepStrictEqual(reusedState[table], initial[table]),
            'Physical reuse changed ' + table,
          );
      const replay = await record(s, fields, key, attempt);
      assert.equal(replay.status, 201);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.body, first.body);
      assert.ok(
        isDeepStrictEqual(await durableFixSnapshot(s.id), reusedState),
        'Original replay created another receipt or observation.',
      );
      const same = await record(s, {
          ...fields,
          '43': 'Y',
          '122': base['52'],
          '52': '20261030-12:01:00.000',
        }),
        next = await record(s, {
          ...fields,
          '34': '2',
          '43': 'Y',
          '122': base['52'],
          '52': '20261030-12:02:00.000',
        });
      for (const observed of [same, next]) {
        assert.equal(observed.status, 201);
        assert.equal(observed.body['message_id'], first.body['message_id']);
        assert.equal(observed.body['logical_duplicate'], true);
        assert.equal(observed.body['physical_duplicate'], false);
      }
      const final = await durableFixSnapshot(s.id);
      assert.equal(final['fix_messages']!.length, 1);
      assert.equal(final['fix_attempts']!.length, 3);
      assert.equal(final['fix_sequence_slots']!.length, 2);
      assert.equal(final['fix_commands']!.filter((c) => c['operation'] === 'RECORD').length, 4);
      assert.equal(final['fix_outbox']!.length, direction === 'OUT' ? 1 : 0);
      const assessment = await verifyFixFoundation(database, binding, () => {}, true);
      assert.equal(assessment.foundation_assessment, 'FOUNDATION_CONSISTENT');
      assert.deepEqual(assessment.findings, []);
      assert.equal(assessment.total_findings, 0);
      assert.equal(assessment.financial_watermark, initialAssessment.financial_watermark);
      assert.equal(assessment.protocol_watermark, '5');
      assert.equal(assessment.protocol_ingest_watermark, '5');
      assert.equal(assessment.financial_application_verified, false);
      assert.equal(assessment.delivery_verified, false);
      assert.equal(assessment.complete, false);
      assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), final));
    });
});

void test('reverse sequence and attempt evidence rejects missing, wrong-channel, wrong-direction and wrong-state witnesses', async () => {
  const cases = [
    'missing-attempt',
    'missing-slot',
    'channel',
    'direction',
    'sequence',
    'state',
    'lost-new-sequence-attempt',
  ] as const;
  for (const direction of ['IN', 'OUT'] as const)
    for (const corruption of cases)
      await withContractSandbox(async (context) => {
        const { s, admin, database, binding } = context,
          base = await report(s),
          fields = direction === 'IN' ? base : outboundFields(base),
          attempt = randomUUID(),
          key = randomUUID(),
          first = await record(s, fields, key, attempt);
        assert.equal(first.status, 201);
        const message = String(first.body['message_id']),
          alternateChannel = corruption === 'channel' ? randomUUID() : undefined;
        if (alternateChannel) {
          const alternateOrder = await s.createOrder();
          assert.equal(
            (
              await s.fix('BIND', {
                order_id: alternateOrder,
                dealer_id: 'ATLAS',
                channel_id: alternateChannel,
              })
            ).status,
            201,
          );
          assert.equal(
            (
              await admin.query('SELECT id FROM fi.fix_channels WHERE sandbox_id=$1 AND id=$2', [
                s.id,
                alternateChannel,
              ])
            ).rowCount,
            1,
            'The wrong-channel witness must still reference an existing legitimately bound channel.',
          );
        }
        if (corruption === 'lost-new-sequence-attempt') {
          const next = await record(s, { ...fields, '34': '2' });
          assert.equal(next.status, 201);
          assert.equal(next.body['message_id'], message);
        }
        const original = await durableFixSnapshot(s.id),
          receipt = String(
            original['fix_commands']!.find((c) => c['idempotency_key'] === key)!['id'],
          ),
          healthy = await verifyFixFoundation(database, binding, () => {}, true);
        assert.equal(healthy.foundation_assessment, 'FOUNDATION_CONSISTENT');
        assert.deepEqual(healthy.findings, []);
        const expected: EvidenceFinding[] = [{ code: 'RECORD_EVIDENCE', record_id: receipt }];
        let changedTables: string[];
        if (corruption === 'missing-attempt' || corruption === 'lost-new-sequence-attempt') {
          await corruptOutbox(admin, 'DELETE FROM fi.fix_attempts WHERE sandbox_id=$1 AND id=$2', [
            s.id,
            attempt,
          ]);
          changedTables = ['fix_attempts'];
          expected.push({ code: 'SEQUENCE_CORRELATION', record_id: message });
          if (corruption === 'missing-attempt')
            expected.push({ code: 'MISSING_PHYSICAL_EVIDENCE', record_id: message });
        } else if (corruption === 'state') {
          await corruptOutbox(
            admin,
            'UPDATE fi.fix_attempts SET state=$3 WHERE sandbox_id=$1 AND id=$2',
            [s.id, attempt, direction === 'IN' ? 'STAGED' : 'RECEIVED'],
          );
          changedTables = ['fix_attempts'];
        } else {
          changedTables = ['fix_sequence_slots'];
          expected.push({ code: 'MISSING_SEQUENCE', record_id: attempt });
          if (corruption !== 'sequence')
            expected.push({ code: 'MESSAGE_SEQUENCE', record_id: message });
          if (corruption === 'missing-slot')
            await corruptOutbox(
              admin,
              'DELETE FROM fi.fix_sequence_slots WHERE sandbox_id=$1 AND message_id=$2',
              [s.id, message],
            );
          else {
            const column =
              corruption === 'channel'
                ? 'channel_id'
                : corruption === 'direction'
                  ? 'direction'
                  : 'message_seq';
            const value =
              corruption === 'channel'
                ? alternateChannel!
                : corruption === 'direction'
                  ? direction === 'IN'
                    ? 'OUT'
                    : 'IN'
                  : '2';
            await corruptOutbox(
              admin,
              'UPDATE fi.fix_sequence_slots SET ' +
                column +
                '=$3 WHERE sandbox_id=$1 AND message_id=$2',
              [s.id, message, value],
            );
            expected.push({ code: 'SEQUENCE_CORRELATION', record_id: message });
          }
        }
        await assertReverseEvidence(context, original, healthy, expected, changedTables);
      });
  console.log(
    'Reverse witness corruption matrix:',
    JSON.stringify({ directions: ['IN', 'OUT'], cases }),
  );
});

void test('successful RECORD receipts require exact retained message, attempt, order, hashes and original canonical request', async () => {
  const mutations: {
    name: string;
    field?: string;
    value?: unknown;
    omit?: boolean;
    whole?: boolean;
  }[] = [
    { name: 'different message' },
    { name: 'different attempt' },
    { name: 'different order' },
    { name: 'different raw hash' },
    { name: 'different semantic hash' },
    { name: 'coherent redirect to surviving attempt' },
    { name: 'different original request hash' },
    { name: 'non-201 successful status' },
  ];
  for (const field of ['message_id', 'attempt_id', 'order_id', 'raw_hash', 'semantic_hash']) {
    mutations.push({ name: field + ' missing', field, omit: true });
    for (const [kind, value] of [
      ['null', null],
      ['number', 7],
      ['array', []],
      ['object', { unexpected: 'synthetic' }],
      ['malformed string', 'not-evidence'],
    ] as const)
      mutations.push({ name: field + ' ' + kind, field, value });
  }
  for (const [kind, value] of [
    ['null', null],
    ['array', []],
    ['boolean', true],
    ['number', 7],
    ['string', 'synthetic'],
  ] as const)
    mutations.push({ name: 'whole body ' + kind, value, whole: true });
  for (const mutation of mutations)
    await withContractSandbox(async (context) => {
      const { s, admin, database, binding } = context,
        base = await report(s),
        key = randomUUID(),
        attempt = randomUUID(),
        first = await record(s, base, key, attempt),
        sibling = await record(s, {
          ...base,
          '43': 'Y',
          '122': base['52'],
          '52': '20261030-12:01:00.000',
        }),
        outgoing = await record(s, outboundFields(base));
      assert.equal(first.status, 201);
      assert.equal(sibling.status, 201);
      assert.equal(outgoing.status, 201);
      assert.equal(sibling.body['message_id'], first.body['message_id']);
      assert.notEqual(sibling.body['attempt_id'], attempt);
      const otherOrder = mutation.name === 'different order' ? await s.createOrder() : undefined,
        original = await durableFixSnapshot(s.id),
        receiptRow = original['fix_commands']!.find((c) => c['idempotency_key'] === key)!,
        receipt = String(receiptRow['id']),
        body = { ...(receiptRow['response_body'] as Record<string, unknown>) },
        healthy = await verifyFixFoundation(database, binding, () => {}, true);
      assert.equal(healthy.foundation_assessment, 'FOUNDATION_CONSISTENT');
      assert.deepEqual(healthy.findings, []);
      const auditMismatch =
        mutation.whole || mutation.field === 'order_id' || mutation.name === 'different order';
      let changedTables = ['fix_commands', 'fix_events'];
      if (
        mutation.name === 'different original request hash' ||
        mutation.name === 'non-201 successful status'
      ) {
        const column =
          mutation.name === 'different original request hash' ? 'request_hash' : 'http_status';
        await corruptOutbox(
          admin,
          'UPDATE fi.fix_commands SET ' + column + '=$3 WHERE sandbox_id=$1 AND id=$2',
          [s.id, receipt, column === 'request_hash' ? '0'.repeat(64) : 200],
        );
        changedTables = ['fix_commands'];
      } else {
        if (mutation.name === 'different message') body['message_id'] = outgoing.body['message_id'];
        else if (mutation.name === 'different attempt')
          body['attempt_id'] = sibling.body['attempt_id'];
        else if (mutation.name === 'different order') body['order_id'] = otherOrder;
        else if (mutation.name === 'different raw hash') body['raw_hash'] = '0'.repeat(64);
        else if (mutation.name === 'different semantic hash')
          body['semantic_hash'] = '0'.repeat(64);
        else if (mutation.name === 'coherent redirect to surviving attempt')
          for (const field of ['attempt_id', 'raw_hash', 'semantic_hash'])
            body[field] = sibling.body[field];
        else if (mutation.field) {
          if (mutation.omit) delete body[mutation.field];
          else body[mutation.field] = mutation.value;
        }
        await rewriteRecordReceipt(context, receipt, mutation.whole ? mutation.value : body);
        const damagedReceipt = (await durableFixSnapshot(s.id))['fix_commands']!.find(
          (c) => c['id'] === receipt,
        )!;
        assert.equal(
          damagedReceipt['request_hash'],
          receiptRow['request_hash'],
          'Receipt corruption must preserve the original request fingerprint.',
        );
        if (mutation.whole) changedTables = ['fix_commands'];
      }
      const expected = [{ code: 'RECORD_EVIDENCE', record_id: receipt }];
      if (auditMismatch) expected.push({ code: 'AUDIT_CORRESPONDENCE', record_id: receipt });
      await assertReverseEvidence(context, original, healthy, expected, changedTables);
    });
  console.log(
    'Exact RECORD receipt corruption matrix:',
    JSON.stringify({ cases: mutations.map((m) => m.name) }),
  );
});

void test('foreign RECORD body references cannot borrow physical evidence from another sandbox or mutate it', async () => {
  await withContractSandbox(async (context) => {
    const { s, database, binding } = context,
      other = await fixture();
    try {
      assert.equal((await other.bind()).status, 201);
      const key = randomUUID(),
        local = await record(s, await report(s), key),
        foreign = await record(other, await report(other));
      assert.equal(local.status, 201);
      assert.equal(foreign.status, 201);
      const original = await durableFixSnapshot(s.id),
        foreignOriginal = await durableFixSnapshot(other.id),
        receipt = String(
          original['fix_commands']!.find((c) => c['idempotency_key'] === key)!['id'],
        ),
        healthy = await verifyFixFoundation(database, binding, () => {}, true),
        foreignBinding = {
          sandboxId: other.id,
          digest: other.proof,
          scope: 'trade' as const,
          generation: '1',
        },
        foreignHealthy = await verifyFixFoundation(database, foreignBinding, () => {}, true);
      assert.equal(healthy.foundation_assessment, 'FOUNDATION_CONSISTENT');
      assert.deepEqual(healthy.findings, []);
      assert.equal(foreignHealthy.foundation_assessment, 'FOUNDATION_CONSISTENT');
      assert.deepEqual(foreignHealthy.findings, []);
      const body = { ...local.body };
      for (const field of ['message_id', 'attempt_id', 'raw_hash', 'semantic_hash'])
        body[field] = foreign.body[field];
      await rewriteRecordReceipt(context, receipt, body);
      await assertReverseEvidence(
        context,
        original,
        healthy,
        [{ code: 'RECORD_EVIDENCE', record_id: receipt }],
        ['fix_commands', 'fix_events'],
      );
      const foreignAfter = await verifyFixFoundation(database, foreignBinding, () => {}, true);
      assert.equal(foreignAfter.foundation_assessment, 'FOUNDATION_CONSISTENT');
      assert.deepEqual(foreignAfter.findings, []);
      assert.deepEqual(scopeEvidence(foreignAfter), scopeEvidence(foreignHealthy));
      assert.ok(
        isDeepStrictEqual(await durableFixSnapshot(other.id), foreignOriginal),
        'Local corruption or verification changed the other sandbox.',
      );
    } finally {
      await other.close();
    }
  });
});

void test('reverse-evidence corruption fixtures preserve ordinary CHECK, NOT NULL and unique constraints', async () => {
  await withContractSandbox(async ({ s, admin, database, binding }) => {
    const fields = await report(s),
      first = await record(s, fields),
      second = await record(s, { ...fields, '34': '2' });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const original = await durableFixSnapshot(s.id),
      attempt = String(first.body['attempt_id']),
      message = String(first.body['message_id']),
      receipt = String(original['fix_commands']!.find((c) => c['operation'] === 'RECORD')!['id']);
    for (const [sql, parameters, code] of [
      [
        "UPDATE fi.fix_attempts SET state='DELIVERED' WHERE sandbox_id=$1 AND id=$2",
        [s.id, attempt],
        '23514',
      ],
      [
        'UPDATE fi.fix_attempts SET attempt_no=2 WHERE sandbox_id=$1 AND id=$2',
        [s.id, attempt],
        '23505',
      ],
      [
        'UPDATE fi.fix_sequence_slots SET epoch=2 WHERE sandbox_id=$1 AND message_id=$2 AND message_seq=1',
        [s.id, message],
        '23514',
      ],
      [
        'UPDATE fi.fix_sequence_slots SET message_seq=0 WHERE sandbox_id=$1 AND message_id=$2 AND message_seq=1',
        [s.id, message],
        '23514',
      ],
      [
        'UPDATE fi.fix_commands SET http_status=202 WHERE sandbox_id=$1 AND id=$2',
        [s.id, receipt],
        '23514',
      ],
      [
        'UPDATE fi.fix_commands SET response_body=NULL WHERE sandbox_id=$1 AND id=$2',
        [s.id, receipt],
        '23502',
      ],
    ] as const)
      await assert.rejects(corruptOutbox(admin, sql, [...parameters]), { code });
    assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), original));
    const assessment = await verifyFixFoundation(database, binding, () => {}, true);
    assert.equal(assessment.foundation_assessment, 'FOUNDATION_CONSISTENT');
    assert.deepEqual(assessment.findings, []);
    assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), original));
    console.log(
      'Reverse-evidence fixture constraints:',
      JSON.stringify({
        checkEnforced: true,
        notNullEnforced: true,
        uniquenessEnforced: true,
        bypassedImpossibleFixtures: false,
      }),
    );
  });
});
