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
  expectedRows = 1,
) {
  await admin.query('BEGIN');
  try {
    await admin.query("SET LOCAL session_replication_role='replica'");
    const result = await admin.query(sql, parameters);
    assert.equal(result.rowCount, expectedRows);
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
  missingRequiredWireField = false,
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
    // The first stored observation must also agree with its retained physical observation.
    ...(mixedRepresentations ? [{ code: 'MESSAGE_FIELDS', record_id: target.message }] : []),
    ...recordEvidenceFindings(target.original, target.message),
  ];
  if (missingRequiredWireField) expected.push({ code: 'WIRE_PROFILE', record_id: target.attempt });
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
    missingRequiredWireField?: boolean;
  }[] = [
    { name: 'missing price', patch: { '44': null }, missingRequiredWireField: true },
    { name: 'nonnumeric total par', patch: { '38': 'not-a-quantity' } },
    { name: 'nonnumeric cumulative', patch: { '14': 'NaN' } },
    { name: 'oversized cumulative representation', patch: { '14': '9'.repeat(200) + '.00' } },
    { name: 'missing cumulative', patch: { '14': null }, missingRequiredWireField: true },
    { name: 'JSON null price', patch: {}, json: { '44': null } },
    { name: 'JSON numeric quantity type', patch: {}, json: { '854': 0 } },
    { name: 'JSON object cumulative', patch: {}, json: { '14': { unexpected: 'synthetic' } } },
    { name: 'JSON array quantity', patch: {}, json: { '38': [] } },
  ];
  for (const item of cases)
    await withContractSandbox(async (context) => {
      const target = await contractMessage(context, '8');
      await corruptContractEvidence(context, target, item.patch, 'coherent', item.json);
      await assertContractFinding(
        context,
        target,
        Boolean(item.json),
        Boolean(item.missingRequiredWireField),
      );
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
    assert.deepEqual(assessment.findings, [
      { code: 'ATTEMPT_SEQUENCE', record_id: survivingAttempt },
      { code: 'RECORD_EVIDENCE', record_id: receipt },
    ]);
    assert.equal(assessment.total_findings, 2);
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
          else {
            const remaining = original['fix_attempts']!.filter(
              (a) => a['message_id'] === message && a['id'] !== attempt,
            );
            assert.equal(remaining.length, 1);
            assert.equal(remaining[0]!['attempt_no'], 2);
            expected.push({ code: 'ATTEMPT_SEQUENCE', record_id: String(remaining[0]!['id']) });
          }
        } else if (corruption === 'state') {
          await corruptOutbox(
            admin,
            'UPDATE fi.fix_attempts SET state=$3 WHERE sandbox_id=$1 AND id=$2',
            [s.id, attempt, direction === 'IN' ? 'STAGED' : 'RECEIVED'],
          );
          changedTables = ['fix_attempts'];
          expected.push({ code: 'ATTEMPT_SEQUENCE', record_id: attempt });
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
      // Losing the earlier message observation also invalidates the later logical-duplicate claim.
      // Redirecting to the sibling attempt likewise makes its retained physical-duplicate flag false.
      if (
        mutation.whole ||
        mutation.field === 'message_id' ||
        mutation.name === 'different message' ||
        mutation.name === 'different attempt' ||
        mutation.name === 'coherent redirect to surviving attempt'
      ) {
        const siblingReceipt = original['fix_commands']!.find(
          (c) =>
            c['operation'] === 'RECORD' &&
            (c['response_body'] as Record<string, unknown>)['attempt_id'] ===
              sibling.body['attempt_id'],
        )!;
        expected.push({ code: 'RECORD_EVIDENCE', record_id: String(siblingReceipt['id']) });
      }
      if (mutation.name === 'different message') {
        const outgoingReceipt = original['fix_commands']!.find(
          (c) =>
            c['operation'] === 'RECORD' &&
            (c['response_body'] as Record<string, unknown>)['attempt_id'] ===
              outgoing.body['attempt_id'],
        )!;
        expected.push({ code: 'RECORD_EVIDENCE', record_id: String(outgoingReceipt['id']) });
      }
      // The original physical observation has no matching receipt after its attempt reference is lost.
      if (
        mutation.whole ||
        mutation.field === 'attempt_id' ||
        mutation.name === 'different attempt' ||
        mutation.name === 'coherent redirect to surviving attempt'
      )
        expected.push({ code: 'MISSING_RECORD_RECEIPT', record_id: attempt });
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
        [
          { code: 'MISSING_RECORD_RECEIPT', record_id: String(local.body['attempt_id']) },
          { code: 'RECORD_EVIDENCE', record_id: receipt },
        ],
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

function integrityUuid(value: unknown): ReturnType<typeof randomUUID> {
  assert.equal(typeof value, 'string');
  const uuid = String(value);
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return uuid as ReturnType<typeof randomUUID>;
}
type IntegrityOperation =
  'BIND' | 'RECORD' | 'CLAIM' | 'QUEUE' | 'PREPARE' | 'RESOLVE_METADATA' | 'RELEASE';
const integrityOperations: IntegrityOperation[] = [
  'BIND',
  'RECORD',
  'CLAIM',
  'QUEUE',
  'PREPARE',
  'RESOLVE_METADATA',
  'RELEASE',
];
type IntegritySnapshot = Awaited<ReturnType<typeof durableFixSnapshot>>;
async function operationEvidence(
  context: ContractContext,
  operation: IntegrityOperation,
  protocolOnly = false,
) {
  const { s } = context;
  let input: Record<string, unknown> = {
      order_id: s.order,
      dealer_id: 'ATLAS',
      channel_id: s.channel,
    },
    fields: Awaited<ReturnType<typeof report>> | undefined,
    message = '',
    attempt = '',
    work = '',
    financialKey = '',
    ownerId = '',
    fence = '';
  if (operation === 'RELEASE') {
    input = { order_id: s.order };
    const released = await s.fix('RELEASE', input);
    assert.equal(released.status, 200);
    assert.equal(released.body['released'], true);
  } else if (operation !== 'BIND') {
    if (operation !== 'CLAIM') {
      fields = await report(
        s,
        operation === 'RESOLVE_METADATA' || protocolOnly
          ? { '150': '6', '39': '6', '11': randomUUID(), '41': s.order }
          : {},
      );
      attempt = randomUUID();
      input = {
        order_id: s.order,
        raw_hex: encodeFix44(fields).toString('hex'),
        attempt_id: attempt,
      };
      const recorded = await s.fix('RECORD', input);
      assert.equal(recorded.status, 201);
      assert.equal(recorded.body['financial_applied'], false);
      message = String(recorded.body['message_id']);
      if (operation !== 'RECORD') {
        work = randomUUID();
        input = { order_id: s.order, message_id: message, work_id: work };
        const queued = await s.fix('QUEUE', input);
        assert.equal(queued.status, 201);
        assert.equal(queued.body['work_id'], work);
      }
    }
    if (operation === 'CLAIM' || operation === 'PREPARE' || operation === 'RESOLVE_METADATA') {
      ownerId = randomUUID();
      input = { order_id: s.order, owner_id: ownerId };
      const claimed = await s.fix('CLAIM', input);
      assert.equal(claimed.status, 200);
      fence = String(claimed.body['fence']);
      assert.equal(fence, '1');
      if (operation !== 'CLAIM') {
        financialKey = randomUUID();
        input = {
          order_id: s.order,
          owner_id: ownerId,
          fence,
          work_id: work,
          financial_key: financialKey,
        };
        const prepared = await s.fix('PREPARE', input);
        assert.equal(prepared.status, 201);
        assert.equal(prepared.body['financial_key'], financialKey);
        if (operation === 'RESOLVE_METADATA') {
          input = { order_id: s.order, owner_id: ownerId, fence, work_id: work };
          const resolved = await s.fix('RESOLVE_METADATA', input);
          assert.equal(resolved.status, 200);
          assert.equal(resolved.body['outcome'], 'METADATA_ONLY');
          assert.equal(resolved.body['financial_applied'], false);
        }
      }
    }
  }
  const snapshot = await durableFixSnapshot(s.id),
    receipt = snapshot['fix_commands']!.find((c) => c['operation'] === operation)!;
  assert.ok(receipt, operation + ' must own a retained successful receipt before corruption.');
  return {
    operation,
    input,
    receipt,
    fields,
    message,
    attempt,
    work,
    financialKey,
    ownerId,
    fence,
  };
}
async function guardedIntegrityCorruption(
  context: ContractContext,
  sql: string,
  parameters: unknown[],
  expectedRows = 1,
) {
  const before = await durableFixSnapshot(context.s.id),
    reconciler = await connection('reconciler');
  try {
    for (const client of [context.s.app, reconciler])
      await assert.rejects(client.query(sql, parameters), { code: '42501' });
    assert.ok(
      isDeepStrictEqual(await durableFixSnapshot(context.s.id), before),
      'Rejected ordinary-role writes changed retained evidence.',
    );
    await corruptOutbox(context.admin, sql, parameters, expectedRows);
  } finally {
    await reconciler.end();
  }
}
async function assertIntegrityFinding(
  context: ContractContext,
  original: IntegritySnapshot,
  healthy: FixAssessment,
  expected: EvidenceFinding[],
  changedTables: string[],
  scopeChanges: Partial<ReturnType<typeof scopeEvidence>> = {},
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
    ),
    expectedScope = { ...scopeEvidence(healthy), ...scopeChanges };
  for (let observation = 0; observation < 2; observation++) {
    const actual = await verifyFixFoundation(context.database, context.binding, () => {}, true);
    assert.equal(actual.foundation_assessment, 'FOUNDATION_FINDINGS');
    assert.deepEqual(actual.findings, findings);
    assert.equal(actual.total_findings, findings.length);
    assert.deepEqual(scopeEvidence(actual), expectedScope);
  }
  assert.ok(
    isDeepStrictEqual(await durableFixSnapshot(context.s.id), damaged),
    'Independent verification changed the corrupted evidence.',
  );
  return damaged;
}
async function healthyIntegrity(context: ContractContext) {
  const before = await durableFixSnapshot(context.s.id),
    result = await verifyFixFoundation(context.database, context.binding, () => {}, true);
  assert.equal(result.foundation_assessment, 'FOUNDATION_CONSISTENT');
  assert.deepEqual(result.findings, []);
  assert.equal(result.total_findings, 0);
  assert.equal(result.financial_application_verified, false);
  assert.equal(result.delivery_verified, false);
  assert.equal(result.protocol_application_watermark, '0');
  assert.equal(result.complete, false);
  assert.equal(result.verified_scope, 'PROTOCOL_METADATA_ONLY');
  assert.ok(isDeepStrictEqual(await durableFixSnapshot(context.s.id), before));
  return result;
}

void test('retained protocol graph rejects the confirmed missing metadata, impossible lineage, identity and retirement faults', async () => {
  const cases = [
    'missing-lane',
    'missing-ordinary-key',
    'missing-queue-work',
    'missing-prepared',
    'missing-outcome',
    'missing-record-receipt-and-audit',
    'future-lane-generation',
    'future-prepared-generation',
    'prepared-generation-newer-than-retained-lane',
    'prepared-generation-older-at-current-fence',
    'zero-prepared-fence',
    'future-prepared-fence',
    'wrong-logical-identity',
    'illegal-retirement',
  ] as const;
  for (const corruption of cases)
    await withContractSandbox(async (context) => {
      const { s } = context,
        operation =
          corruption === 'missing-lane' || corruption === 'missing-ordinary-key'
            ? 'BIND'
            : corruption === 'missing-queue-work' ||
                corruption === 'prepared-generation-older-at-current-fence'
              ? 'QUEUE'
              : corruption === 'missing-outcome'
                ? 'RESOLVE_METADATA'
                : corruption === 'missing-record-receipt-and-audit' ||
                    corruption === 'wrong-logical-identity'
                  ? 'RECORD'
                  : 'PREPARE',
        evidence = await operationEvidence(context, operation);
      if (corruption === 'prepared-generation-newer-than-retained-lane') {
        const proof = createHash('sha256').update(randomUUID()).digest('hex'),
          rotated = (
            await s.app.query<{ r: { status: number } }>(
              'SELECT fi_control.rotate_capabilities($1,$2,1,1,$3,$4,$5,$6,$7) r',
              [
                s.id,
                s.proof,
                createHash('sha256').update(randomUUID()).digest('hex'),
                proof,
                createHash('sha256').update('prepared-lineage-rotation').digest('hex'),
                randomUUID(),
                s.actor,
              ],
            )
          ).rows[0]!.r;
        assert.equal(rotated.status, 200);
        context.binding = { ...context.binding, digest: proof, generation: '2' };
        const rotatedState = await durableFixSnapshot(s.id);
        assert.equal(rotatedState['sandboxes']![0]!['generation'], 2);
        assert.equal(rotatedState['fix_lanes']![0]!['capability_generation'], 1);
        assert.equal(rotatedState['fix_prepared']![0]!['prepared_generation'], 1);
      }
      if (corruption === 'prepared-generation-older-at-current-fence') {
        const ownerId = randomUUID(),
          claim = await s.fix('CLAIM', { order_id: s.order, owner_id: ownerId }),
          proof = createHash('sha256').update(randomUUID()).digest('hex');
        assert.equal(claim.status, 200);
        assert.equal(claim.body['fence'], '1');
        const rotated = (
          await s.app.query<{ r: { status: number } }>(
            'SELECT fi_control.rotate_capabilities($1,$2,1,1,$3,$4,$5,$6,$7) r',
            [
              s.id,
              s.proof,
              createHash('sha256').update(randomUUID()).digest('hex'),
              proof,
              createHash('sha256').update('current-fence-generation').digest('hex'),
              randomUUID(),
              s.actor,
            ],
          )
        ).rows[0]!.r;
        assert.equal(rotated.status, 200);
        context.binding = { ...context.binding, digest: proof, generation: '2' };
        const current = async (operation: string, input: Record<string, unknown>) =>
          (
            await s.app.query<{ r: Awaited<ReturnType<typeof s.fix>> }>(
              'SELECT fi_control.fix_command($1,$2,2,$3,$4,$5,$6) r',
              [s.id, proof, operation, JSON.stringify(input), randomUUID(), s.actor],
            )
          ).rows[0]!.r;
        const reclaimed = await current('CLAIM', { order_id: s.order, owner_id: ownerId });
        assert.equal(reclaimed.status, 200);
        assert.equal(reclaimed.body['fence'], '2');
        const prepared = await current('PREPARE', {
          order_id: s.order,
          owner_id: ownerId,
          fence: '2',
          work_id: evidence.work,
          financial_key: randomUUID(),
        });
        assert.equal(prepared.status, 201);
        const currentState = await durableFixSnapshot(s.id);
        assert.equal(currentState['fix_prepared']![0]!['prepared_generation'], 2);
        assert.equal(currentState['fix_prepared']![0]!['prepared_fence'], 2);
        assert.equal(currentState['fix_lanes']![0]!['capability_generation'], 2);
        assert.equal(currentState['fix_lanes']![0]!['fence'], 2);
      }
      const original = await durableFixSnapshot(s.id),
        healthy = await healthyIntegrity(context),
        receipt = String(evidence.receipt['id']),
        expected: EvidenceFinding[] = [],
        scopeChanges: Partial<ReturnType<typeof scopeEvidence>> = {};
      let sql: string, parameters: unknown[], changed: string[];
      if (corruption === 'missing-lane') {
        sql = 'DELETE FROM fi.fix_lanes WHERE sandbox_id=$1 AND order_id=$2';
        parameters = [s.id, s.order];
        changed = ['fix_lanes'];
        expected.push({ code: 'BIND_GRAPH', record_id: s.order });
      } else if (corruption === 'missing-ordinary-key') {
        sql = 'DELETE FROM fi_control.command_keys WHERE sandbox_id=$1 AND idempotency_key=$2';
        parameters = [s.id, evidence.receipt['idempotency_key']];
        changed = ['command_keys'];
        expected.push({ code: 'COMMAND_KEY', record_id: receipt });
      } else if (corruption === 'missing-queue-work') {
        sql = 'DELETE FROM fi.fix_work WHERE sandbox_id=$1 AND id=$2';
        parameters = [s.id, evidence.work];
        changed = ['fix_work'];
        expected.push({ code: 'QUEUE_EVIDENCE', record_id: receipt });
        scopeChanges['unresolved_work_count'] = 0;
      } else if (corruption === 'missing-prepared') {
        sql = 'DELETE FROM fi.fix_prepared WHERE sandbox_id=$1 AND work_id=$2';
        parameters = [s.id, evidence.work];
        changed = ['fix_prepared'];
        expected.push(
          { code: 'PREPARE_EVIDENCE', record_id: receipt },
          { code: 'PREPARED_KEY', record_id: evidence.financialKey },
        );
      } else if (corruption === 'missing-outcome') {
        sql = 'DELETE FROM fi.fix_outcomes WHERE sandbox_id=$1 AND work_id=$2';
        parameters = [s.id, evidence.work];
        changed = ['fix_outcomes'];
        expected.push({ code: 'RESOLVE_METADATA_EVIDENCE', record_id: receipt });
        scopeChanges['unresolved_work_count'] = 1;
      } else if (corruption === 'missing-record-receipt-and-audit') {
        sql =
          'WITH removed AS (DELETE FROM fi.fix_events WHERE sandbox_id=$1 AND command_seq=$2 RETURNING command_seq) DELETE FROM fi.fix_commands WHERE sandbox_id=$1 AND command_seq IN(SELECT command_seq FROM removed)';
        parameters = [s.id, evidence.receipt['command_seq']];
        changed = ['fix_commands', 'fix_events'];
        expected.push(
          { code: 'MISSING_RECORD_RECEIPT', record_id: evidence.attempt },
          { code: 'COMMAND_KEY', record_id: integrityUuid(evidence.receipt['idempotency_key']) },
        );
        scopeChanges['protocol_watermark'] = '1';
        scopeChanges['protocol_ingest_watermark'] = '0';
      } else if (corruption === 'future-lane-generation') {
        sql = 'UPDATE fi.fix_lanes SET capability_generation=2 WHERE sandbox_id=$1 AND order_id=$2';
        parameters = [s.id, s.order];
        changed = ['fix_lanes'];
        expected.push(
          { code: 'LANE_LINEAGE', record_id: s.order },
          { code: 'PREPARED_LINEAGE', record_id: evidence.work },
        );
      } else if (corruption === 'wrong-logical-identity') {
        sql =
          "UPDATE fi.fix_messages SET identity_value='ATLAS-CORRUPTED' WHERE sandbox_id=$1 AND id=$2";
        parameters = [s.id, evidence.message];
        changed = ['fix_messages'];
        expected.push({ code: 'MESSAGE_IDENTITY', record_id: evidence.message });
      } else if (corruption === 'illegal-retirement') {
        sql =
          'WITH released AS (UPDATE fi_control.fix_reservations SET released_at=clock_timestamp() WHERE sandbox_id=$1 AND order_id=$2 RETURNING order_id) UPDATE fi.fix_lanes SET closed_at=clock_timestamp() WHERE sandbox_id=$1 AND order_id IN(SELECT order_id FROM released)';
        parameters = [s.id, s.order];
        changed = ['fix_reservations', 'fix_lanes'];
        expected.push(
          { code: 'LANE_RETIREMENT', record_id: s.order },
          { code: 'MISSING_RELEASE_RECEIPT', record_id: s.order },
        );
      } else {
        sql =
          'UPDATE fi.fix_prepared SET ' +
          (corruption === 'future-prepared-generation' ||
          corruption === 'prepared-generation-newer-than-retained-lane'
            ? 'prepared_generation=2'
            : corruption === 'prepared-generation-older-at-current-fence'
              ? 'prepared_generation=1'
              : 'prepared_fence=$3') +
          ' WHERE sandbox_id=$1 AND work_id=$2';
        parameters =
          corruption === 'future-prepared-generation' ||
          corruption === 'prepared-generation-newer-than-retained-lane' ||
          corruption === 'prepared-generation-older-at-current-fence'
            ? [s.id, evidence.work]
            : [s.id, evidence.work, corruption === 'zero-prepared-fence' ? 0 : 2];
        changed = ['fix_prepared'];
        expected.push({ code: 'PREPARED_LINEAGE', record_id: evidence.work });
        if (corruption === 'future-prepared-fence')
          expected.push({ code: 'PREPARED_REFERENCE', record_id: evidence.work });
      }
      await guardedIntegrityCorruption(context, sql, parameters);
      await assertIntegrityFinding(context, original, healthy, expected, changed, scopeChanges);
      if (corruption === 'wrong-logical-identity') {
        const repeated = await record(s, { ...evidence.fields!, '34': '2' });
        assert.equal(repeated.status, 201);
        assert.equal(repeated.body['financial_applied'], false);
        assert.equal(repeated.body['logical_duplicate'], false);
        assert.notEqual(repeated.body['message_id'], evidence.message);
        const duplicate = String(repeated.body['message_id']),
          afterRecord = await durableFixSnapshot(s.id),
          expectedDuplicate = [
            { code: 'MESSAGE_IDENTITY', record_id: evidence.message },
            { code: 'DUPLICATE_MESSAGE_IDENTITY', record_id: evidence.message },
            { code: 'DUPLICATE_MESSAGE_IDENTITY', record_id: duplicate },
          ].sort((a, b) =>
            a.code < b.code
              ? -1
              : a.code > b.code
                ? 1
                : a.record_id < b.record_id
                  ? -1
                  : a.record_id > b.record_id
                    ? 1
                    : 0,
          ),
          assessed = await verifyFixFoundation(context.database, context.binding, () => {}, true);
        assert.equal(afterRecord['fix_messages']!.length, 2);
        assert.equal(afterRecord['fix_attempts']!.length, 2);
        assert.equal(assessed.foundation_assessment, 'FOUNDATION_FINDINGS');
        assert.deepEqual(assessed.findings, expectedDuplicate);
        assert.equal(assessed.total_findings, 3);
        assert.equal(assessed.financial_watermark, healthy.financial_watermark);
        assert.equal(assessed.protocol_watermark, '3');
        assert.equal(assessed.protocol_ingest_watermark, '3');
        assert.equal(assessed.financial_application_verified, false);
        assert.equal(assessed.delivery_verified, false);
        assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), afterRecord));
      }
    });
  console.log('Retained protocol graph integrity matrix:', JSON.stringify({ cases }));
});

void test('every retained operation effect requires its own successful receipt even when the final receipt and audit disappear together', async () => {
  for (const operation of integrityOperations)
    for (const keepKey of [true, false])
      await withContractSandbox(async (context) => {
        const { s } = context,
          evidence = await operationEvidence(context, operation),
          original = await durableFixSnapshot(s.id),
          healthy = await healthyIntegrity(context),
          sequence = Number(evidence.receipt['command_seq']),
          surviving = original['fix_commands']!.filter(
            (c) => Number(c['command_seq']) !== sequence,
          ),
          maximum = (op?: string) =>
            String(
              Math.max(
                0,
                ...surviving
                  .filter((c) => !op || c['operation'] === op)
                  .map((c) => Number(c['command_seq'])),
              ),
            ),
          expected: EvidenceFinding[] = keepKey
            ? [
                {
                  code: 'COMMAND_KEY',
                  record_id: integrityUuid(evidence.receipt['idempotency_key']),
                },
              ]
            : [];
        assert.equal(
          sequence,
          original['fix_commands']!.length,
          'Remove the tail, not a detectable sequence gap.',
        );
        if (operation === 'CLAIM') expected.push({ code: 'LANE_LINEAGE', record_id: s.order });
        else {
          const code =
              operation === 'RESOLVE_METADATA'
                ? 'MISSING_RESOLVE_RECEIPT'
                : 'MISSING_' + operation + '_RECEIPT',
            recordId =
              operation === 'BIND' || operation === 'RELEASE'
                ? s.order
                : operation === 'RECORD'
                  ? evidence.attempt
                  : evidence.work;
          expected.push({ code, record_id: recordId });
          if (operation === 'RELEASE')
            expected.push(
              { code: 'LANE_LINEAGE', record_id: s.order },
              { code: 'LANE_RETIREMENT', record_id: s.order },
            );
        }
        if (!keepKey)
          await guardedIntegrityCorruption(
            context,
            'DELETE FROM fi_control.command_keys WHERE sandbox_id=$1 AND idempotency_key=$2',
            [s.id, evidence.receipt['idempotency_key']],
          );
        await guardedIntegrityCorruption(
          context,
          'WITH removed AS (DELETE FROM fi.fix_events WHERE sandbox_id=$1 AND command_seq=$2 RETURNING command_seq) DELETE FROM fi.fix_commands WHERE sandbox_id=$1 AND command_seq IN(SELECT command_seq FROM removed)',
          [s.id, sequence],
        );
        await assertIntegrityFinding(
          context,
          original,
          healthy,
          expected,
          keepKey ? ['fix_commands', 'fix_events'] : ['fix_commands', 'fix_events', 'command_keys'],
          {
            protocol_watermark: maximum(),
            protocol_ingest_watermark: maximum('RECORD'),
            protocol_prepare_watermark: maximum('PREPARE'),
          },
        );
      });
});

void test('non-RECORD receipts retain exact operation bodies and original request fingerprints despite coherent audit rewrites', async () => {
  for (const operation of integrityOperations.filter((op) => op !== 'RECORD'))
    for (const corruption of [
      'wrong-value',
      'unexpected-payload',
      'nonobject',
      'request-hash',
    ] as const)
      await withContractSandbox(async (context) => {
        const { s } = context,
          evidence = await operationEvidence(context, operation),
          original = await durableFixSnapshot(s.id),
          healthy = await healthyIntegrity(context),
          receipt = String(evidence.receipt['id']),
          body = { ...(evidence.receipt['response_body'] as Record<string, unknown>) },
          expected: EvidenceFinding[] = [{ code: operation + '_EVIDENCE', record_id: receipt }];
        if (corruption === 'request-hash') {
          await guardedIntegrityCorruption(
            context,
            'UPDATE fi.fix_commands SET request_hash=$3 WHERE sandbox_id=$1 AND id=$2',
            [s.id, receipt, '0'.repeat(64)],
          );
        } else {
          if (corruption === 'wrong-value') {
            if (operation === 'BIND') body['reserved_commands'] = 26;
            else if (operation === 'CLAIM') body['fence'] = '999';
            else if (operation === 'QUEUE') body['lane_seq'] = 99;
            else if (operation === 'PREPARE') body['financial_key'] = randomUUID();
            else if (operation === 'RESOLVE_METADATA') body['outcome'] = 'APPLIED';
            else body['released'] = false;
          } else if (corruption === 'unexpected-payload') {
            if (operation === 'PREPARE') body['unexpected'] = { synthetic: true };
            else body['payload'] = { unexpected: 'synthetic' };
          }
          const modified = corruption === 'nonobject' ? [] : body;
          // Verify ordinary roles cannot make the same receipt rewrite.
          const reconciler = await connection('reconciler');
          try {
            for (const client of [s.app, reconciler])
              await assert.rejects(
                client.query(
                  'UPDATE fi.fix_commands SET response_body=$3::jsonb WHERE sandbox_id=$1 AND id=$2',
                  [s.id, receipt, JSON.stringify(modified)],
                ),
                { code: '42501' },
              );
          } finally {
            await reconciler.end();
          }
          assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), original));
          await rewriteRecordReceipt(context, receipt, modified);
          if (corruption === 'nonobject') {
            expected.push({ code: 'AUDIT_CORRESPONDENCE', record_id: receipt });
            if (operation === 'RELEASE')
              expected.push(
                { code: 'LANE_LINEAGE', record_id: s.order },
                { code: 'LANE_RETIREMENT', record_id: s.order },
              );
            if (operation !== 'CLAIM')
              expected.push({
                code:
                  operation === 'RESOLVE_METADATA'
                    ? 'MISSING_RESOLVE_RECEIPT'
                    : 'MISSING_' + operation + '_RECEIPT',
                record_id:
                  operation === 'BIND' || operation === 'RELEASE' ? s.order : evidence.work,
              });
          }
          if (operation === 'CLAIM' && corruption === 'nonobject')
            expected.push({ code: 'LANE_LINEAGE', record_id: s.order });
        }
        await assertIntegrityFinding(
          context,
          original,
          healthy,
          expected,
          corruption === 'request-hash' || corruption === 'nonobject'
            ? ['fix_commands']
            : ['fix_commands', 'fix_events'],
        );
      });
});

void test('command registries and audit rows cannot borrow the wrong domain or survive without their owning effect', async () => {
  for (const corruption of [
    'wrong-fix-domain',
    'missing-prepared-key',
    'wrong-prepared-domain',
    'orphan-event',
  ] as const)
    await withContractSandbox(async (context) => {
      const { s } = context,
        evidence = await operationEvidence(
          context,
          corruption === 'wrong-fix-domain' || corruption === 'orphan-event' ? 'BIND' : 'PREPARE',
        ),
        original = await durableFixSnapshot(s.id),
        healthy = await healthyIntegrity(context),
        receipt = String(evidence.receipt['id']),
        expected: EvidenceFinding[] = [];
      let sql: string,
        parameters: unknown[],
        changed: string[],
        scopeChanges: Partial<ReturnType<typeof scopeEvidence>> = {};
      if (corruption === 'wrong-fix-domain') {
        sql =
          "UPDATE fi_control.command_keys SET domain='FIX_PREPARED' WHERE sandbox_id=$1 AND idempotency_key=$2";
        parameters = [s.id, evidence.receipt['idempotency_key']];
        changed = ['command_keys'];
        expected.push(
          { code: 'COMMAND_KEY', record_id: receipt },
          { code: 'PREPARED_KEY', record_id: integrityUuid(evidence.receipt['idempotency_key']) },
        );
      } else if (corruption === 'missing-prepared-key') {
        sql = 'DELETE FROM fi_control.command_keys WHERE sandbox_id=$1 AND idempotency_key=$2';
        parameters = [s.id, evidence.financialKey];
        changed = ['command_keys'];
        expected.push(
          { code: 'PREPARED_FINGERPRINT', record_id: evidence.work },
          { code: 'PREPARED_KEY', record_id: evidence.work },
        );
      } else if (corruption === 'wrong-prepared-domain') {
        sql =
          "UPDATE fi_control.command_keys SET domain='FIX' WHERE sandbox_id=$1 AND idempotency_key=$2";
        parameters = [s.id, evidence.financialKey];
        changed = ['command_keys'];
        expected.push(
          { code: 'PREPARED_FINGERPRINT', record_id: evidence.work },
          { code: 'PREPARED_KEY', record_id: evidence.work },
          { code: 'COMMAND_KEY', record_id: evidence.financialKey },
        );
      } else {
        sql = 'DELETE FROM fi.fix_commands WHERE sandbox_id=$1 AND id=$2';
        parameters = [s.id, receipt];
        changed = ['fix_commands'];
        expected.push(
          { code: 'ORPHAN_PROTOCOL_EVENT', record_id: String(evidence.receipt['command_seq']) },
          { code: 'MISSING_BIND_RECEIPT', record_id: s.order },
          { code: 'COMMAND_KEY', record_id: integrityUuid(evidence.receipt['idempotency_key']) },
        );
        scopeChanges = { protocol_watermark: '0' };
      }
      await guardedIntegrityCorruption(context, sql, parameters);
      await assertIntegrityFinding(context, original, healthy, expected, changed, scopeChanges);
    });
});

void test('all seven healthy operation histories retain exact original receipts and replay without manufacturing effects', async () => {
  const expected = {
    BIND: ['1', '0', '0', 0],
    RECORD: ['2', '2', '0', 0],
    CLAIM: ['2', '0', '0', 0],
    QUEUE: ['3', '2', '0', 1],
    PREPARE: ['5', '2', '5', 1],
    RESOLVE_METADATA: ['6', '2', '5', 0],
    RELEASE: ['2', '0', '0', 0],
  } as const;
  for (const operation of integrityOperations)
    await withContractSandbox(async (context) => {
      const { s } = context,
        evidence = await operationEvidence(context, operation),
        before = await durableFixSnapshot(s.id),
        result = await healthyIntegrity(context),
        [protocol, ingest, prepare, unresolved] = expected[operation];
      assert.deepEqual(scopeEvidence(result), {
        financial_watermark: '4',
        protocol_watermark: protocol,
        protocol_ingest_watermark: ingest,
        protocol_prepare_watermark: prepare,
        protocol_application_watermark: '0',
        unresolved_work_count: unresolved,
        financial_ledger_consistency: 'NOT_EVALUATED',
        protocol_completeness: 'NOT_IMPLEMENTED',
        delivery_verified: false,
        financial_application_verified: false,
        complete: false,
        verified_scope: 'PROTOCOL_METADATA_ONLY',
      });
      const key = integrityUuid(evidence.receipt['idempotency_key']),
        replay = await s.fix(operation, evidence.input, key),
        receipt = (
          await s.app.query<{
            r: { status: number; body: { operation: string; status: number; body: unknown } };
          }>('SELECT fi_control.read_fix($1,$2,$3,1,$4,$5) r', [
            s.id,
            s.proof,
            'trade',
            'RECEIPT',
            key,
          ])
        ).rows[0]!.r;
      assert.equal(replay.status, evidence.receipt['http_status']);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.body, evidence.receipt['response_body']);
      assert.equal(receipt.status, 200);
      assert.equal(receipt.body.operation, operation);
      assert.equal(receipt.body.status, evidence.receipt['http_status']);
      assert.deepEqual(receipt.body.body, evidence.receipt['response_body']);
      assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), before));
      await healthyIntegrity(context);
    });
});

void test('historical claims and prepared work remain valid through renewal, expired-owner reclaim, current-owner metadata resolution and capability rotation', async () => {
  await withContractSandbox(async (context) => {
    const { s, admin } = context,
      evidence = await operationEvidence(context, 'PREPARE', true),
      original = await durableFixSnapshot(s.id),
      prepared = original['fix_prepared']![0]!,
      firstClaim = original['fix_commands']!.find((c) => c['operation'] === 'CLAIM')!,
      firstClaimInput = { order_id: s.order, owner_id: evidence.ownerId };
    await healthyIntegrity(context);
    const renewed = await s.fix('CLAIM', firstClaimInput);
    assert.equal(renewed.status, 200);
    assert.equal(renewed.body['fence'], '2');
    await healthyIntegrity(context);
    // Advance only fixture lease state, then reclaim before evaluating retained history.
    assert.equal(
      (
        await admin.query(
          "UPDATE fi.fix_lanes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1 AND order_id=$2",
          [s.id, s.order],
        )
      ).rowCount,
      1,
    );
    const nextOwner = randomUUID(),
      reclaimed = await s.fix('CLAIM', { order_id: s.order, owner_id: nextOwner });
    assert.equal(reclaimed.status, 200);
    assert.equal(reclaimed.body['fence'], '3');
    const reclaimedState = await durableFixSnapshot(s.id);
    assert.ok(isDeepStrictEqual(reclaimedState['fix_prepared'], original['fix_prepared']));
    assert.equal(prepared['prepared_fence'], 1);
    assert.equal(prepared['prepared_generation'], 1);
    await healthyIntegrity(context);
    const replayedClaim = await s.fix(
        'CLAIM',
        firstClaimInput,
        integrityUuid(firstClaim['idempotency_key']),
      ),
      replayedPrepare = await s.fix(
        'PREPARE',
        evidence.input,
        integrityUuid(evidence.receipt['idempotency_key']),
      );
    assert.equal(replayedClaim.replayed, true);
    assert.deepEqual(replayedClaim.body, firstClaim['response_body']);
    assert.equal(replayedPrepare.replayed, true);
    assert.deepEqual(replayedPrepare.body, evidence.receipt['response_body']);
    assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), reclaimedState));
    const resolved = await s.fix('RESOLVE_METADATA', {
      order_id: s.order,
      owner_id: nextOwner,
      fence: '3',
      work_id: evidence.work,
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body['outcome'], 'METADATA_ONLY');
    assert.equal(resolved.body['financial_applied'], false);
    const beforeRotation = await durableFixSnapshot(s.id),
      beforeAssessment = await healthyIntegrity(context),
      proof = createHash('sha256').update(randomUUID()).digest('hex'),
      rotation = (
        await s.app.query<{ r: { status: number } }>(
          'SELECT fi_control.rotate_capabilities($1,$2,1,1,$3,$4,$5,$6,$7) r',
          [
            s.id,
            s.proof,
            createHash('sha256').update(randomUUID()).digest('hex'),
            proof,
            createHash('sha256').update('integrity-rotation').digest('hex'),
            randomUUID(),
            s.actor,
          ],
        )
      ).rows[0]!.r;
    assert.equal(rotation.status, 200);
    const currentContext = {
        ...context,
        binding: { ...context.binding, digest: proof, generation: '2' },
      },
      rotatedState = await durableFixSnapshot(s.id);
    assert.equal(rotatedState['sandboxes']![0]!['generation'], 2);
    assert.ok(isDeepStrictEqual(rotatedState['fix_prepared'], original['fix_prepared']));
    const rotatedAssessment = await healthyIntegrity(currentContext);
    assert.equal(rotatedAssessment.protocol_watermark, beforeAssessment.protocol_watermark);
    assert.equal(rotatedAssessment.protocol_prepare_watermark, '5');
    assert.equal(rotatedAssessment.unresolved_work_count, 0);
    assert.equal(
      rotatedAssessment.financial_watermark,
      String(Math.max(...rotatedState['commands']!.map((c) => Number(c['command_seq'])))),
    );
    await assert.rejects(
      verifyFixFoundation(context.database, context.binding, () => {}, true),
      { code: 'SANDBOX_NOT_FOUND' },
    );
    const current = async (op: string, input: Record<string, unknown>, key = randomUUID()) =>
      (
        await s.app.query<{ r: Awaited<ReturnType<typeof s.fix>> }>(
          'SELECT fi_control.fix_command($1,$2,2,$3,$4,$5,$6) r',
          [s.id, proof, op, JSON.stringify(input), key, s.actor],
        )
      ).rows[0]!.r;
    for (const [operation, input, saved] of [
      ['CLAIM', firstClaimInput, firstClaim],
      ['PREPARE', evidence.input, evidence.receipt],
    ] as const) {
      const replay = await current(operation, input, integrityUuid(saved['idempotency_key']));
      assert.equal(replay.status, saved['http_status']);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.body, saved['response_body']);
    }
    assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), rotatedState));
    const finalClaim = await current('CLAIM', { order_id: s.order, owner_id: randomUUID() });
    assert.equal(finalClaim.status, 200);
    assert.equal(finalClaim.body['fence'], '4');
    const final = await durableFixSnapshot(s.id);
    assert.equal(final['fix_lanes']![0]!['capability_generation'], 2);
    assert.ok(isDeepStrictEqual(final['fix_prepared'], original['fix_prepared']));
    assert.ok(isDeepStrictEqual(final['fix_messages'], beforeRotation['fix_messages']));
    assert.equal(
      (
        original['fix_commands']!.find((c) => c['operation'] === 'BIND')![
          'response_body'
        ] as Record<string, unknown>
      )['dealer_order_id'],
      null,
    );
    await healthyIntegrity(currentContext);
  });
});

void test('pristine release preserves an expired historical owner and original-key replay after closure and write expiry', async () => {
  for (const claimed of [false, true])
    await withContractSandbox(async (context) => {
      const { s, admin } = context,
        initial = await durableFixSnapshot(s.id),
        bound = initial['fix_commands']!.find((c) => c['operation'] === 'BIND')!,
        ownerId = randomUUID(),
        claimInput = { order_id: s.order, owner_id: ownerId },
        claimKey = randomUUID(),
        claim = claimed ? await s.fix('CLAIM', claimInput, claimKey) : undefined;
      let clockAdjustedClaimBody = claim?.body;
      if (claim) {
        assert.equal(claim.status, 200);
        assert.equal(claim.body['fence'], '1');
        clockAdjustedClaimBody = await advanceIntegrityLeaseClock(context, claimKey);
      }
      const releaseKey = randomUUID(),
        release = await s.fix('RELEASE', { order_id: s.order }, releaseKey);
      assert.equal(release.status, 200);
      assert.equal(release.body['released'], true);
      const released = await durableFixSnapshot(s.id),
        lane = released['fix_lanes']![0]!;
      assert.equal(lane['fence'], claimed ? 2 : 1);
      assert.equal(lane['owner_id'], claimed ? ownerId : null);
      assert.equal(lane['actor_id'], claimed ? s.actor : null);
      assert.notEqual(lane['closed_at'], null);
      assert.notEqual(released['fix_reservations']![0]!['released_at'], null);
      assert.equal(released['fix_messages']!.length, 0);
      assert.equal(released['fix_work']!.length, 0);
      await healthyIntegrity(context);
      assert.equal(
        (
          await admin.query(
            "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '8 days',write_expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",
            [s.id],
          )
        ).rowCount,
        1,
      );
      const afterExpiry = await durableFixSnapshot(s.id);
      for (const [operation, input, key, saved] of [
        [
          'BIND',
          { order_id: s.order, dealer_id: 'ATLAS', channel_id: s.channel },
          integrityUuid(bound['idempotency_key']),
          bound['response_body'],
        ],
        ['RELEASE', { order_id: s.order }, releaseKey, release.body],
        ...(claimed ? [['CLAIM', claimInput, claimKey, clockAdjustedClaimBody!] as const] : []),
      ] as const) {
        const replay = await s.fix(operation, input, key);
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.body, saved);
      }
      const rejected = await s.fix('CLAIM', { order_id: s.order, owner_id: randomUUID() });
      assert.equal(rejected.status, 409);
      assert.equal((rejected.body['error'] as { code: string }).code, 'SANDBOX_EXPIRED');
      assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), afterExpiry));
      await healthyIntegrity(context);
    });
});

async function swapIntegrityReceipts(
  context: ContractContext,
  first: Record<string, unknown>,
  second: Record<string, unknown>,
) {
  const replacement = [
    { ...second, id: first['id'] },
    { ...first, id: second['id'] },
  ];
  await guardedIntegrityCorruption(
    context,
    "WITH changed AS (UPDATE fi.fix_commands c SET operation=x.operation,request_hash=x.request_hash,http_status=x.http_status,response_body=x.response_body,actor_id=x.actor_id FROM jsonb_to_recordset($2::jsonb) x(id uuid,operation text,request_hash text,http_status integer,response_body jsonb,actor_id uuid) WHERE c.sandbox_id=$1 AND c.id=x.id RETURNING c.command_seq,c.operation,c.response_body) UPDATE fi.fix_events e SET event_type=c.operation,payload=jsonb_build_object('financial_applied',false,'record',c.response_body-'payload') FROM changed c WHERE e.sandbox_id=$1 AND e.command_seq=c.command_seq",
    [context.s.id, JSON.stringify(replacement)],
    2,
  );
}

void test('single-effect operations reject coherent duplicate receipts while preserving contiguous sequence, keys and audits', async () => {
  for (const operation of ['BIND', 'QUEUE', 'PREPARE', 'RESOLVE_METADATA', 'RELEASE'] as const)
    await withContractSandbox(async (context) => {
      const { s } = context,
        evidence = await operationEvidence(context, operation),
        original = await durableFixSnapshot(s.id),
        healthy = await healthyIntegrity(context),
        duplicateId = randomUUID(),
        duplicateKey = randomUUID(),
        expected: EvidenceFinding[] = [
          { code: 'DUPLICATE_EFFECT_RECEIPT', record_id: String(evidence.receipt['id']) },
          { code: 'DUPLICATE_EFFECT_RECEIPT', record_id: duplicateId },
        ];
      if (operation === 'QUEUE')
        expected.push({ code: 'OPERATION_ORDERING', record_id: duplicateId });
      if (operation === 'RELEASE')
        expected.push(
          { code: 'LANE_LINEAGE', record_id: s.order },
          { code: 'LANE_RETIREMENT', record_id: s.order },
        );
      await guardedIntegrityCorruption(
        context,
        "WITH registry AS (INSERT INTO fi_control.command_keys VALUES($1,$4,'FIX')),added AS (INSERT INTO fi.fix_commands SELECT sandbox_id,$3,$4,operation,request_hash,command_seq+1,http_status,response_body,actor_id FROM fi.fix_commands WHERE sandbox_id=$1 AND id=$2 RETURNING command_seq,operation,response_body) INSERT INTO fi.fix_events SELECT $1,command_seq,0,operation,$5,jsonb_build_object('financial_applied',false,'record',response_body-'payload'),clock_timestamp() FROM added",
        [s.id, evidence.receipt['id'], duplicateId, duplicateKey, s.order],
      );
      const after = await durableFixSnapshot(s.id);
      assert.equal(after['fix_commands']!.length, original['fix_commands']!.length + 1);
      assert.equal(after['fix_events']!.length, original['fix_events']!.length + 1);
      assert.equal(after['command_keys']!.length, original['command_keys']!.length + 1);
      await assertIntegrityFinding(
        context,
        original,
        healthy,
        expected,
        ['fix_commands', 'fix_events', 'command_keys'],
        {
          protocol_watermark: String(Number(healthy.protocol_watermark) + 1),
          ...(operation === 'PREPARE'
            ? { protocol_prepare_watermark: String(Number(healthy.protocol_prepare_watermark) + 1) }
            : {}),
        },
      );
    });
});

void test('receipt chronology rejects binding, message, preparation and prior-head resolution that occur after their consumers', async () => {
  for (const corruption of [
    'bind-after-record',
    'queue-before-record',
    'resolve-before-prepare',
    'later-prepare-before-prior-resolve',
  ] as const)
    await withContractSandbox(async (context) => {
      const { s } = context,
        evidence = await operationEvidence(
          context,
          corruption === 'bind-after-record'
            ? 'RECORD'
            : corruption === 'queue-before-record'
              ? 'QUEUE'
              : corruption === 'later-prepare-before-prior-resolve'
                ? 'PREPARE'
                : 'RESOLVE_METADATA',
          corruption === 'later-prepare-before-prior-resolve',
        );
      let secondWork = '';
      if (corruption === 'later-prepare-before-prior-resolve') {
        const fields = await report(s, {
            '150': '6',
            '39': '6',
            '11': randomUUID(),
            '41': s.order,
            '34': '2',
          }),
          recorded = await record(s, fields);
        assert.equal(recorded.status, 201);
        secondWork = randomUUID();
        assert.equal(
          (
            await s.fix('QUEUE', {
              order_id: s.order,
              message_id: recorded.body['message_id'],
              work_id: secondWork,
            })
          ).status,
          201,
        );
        const resolved = await s.fix('RESOLVE_METADATA', {
          order_id: s.order,
          owner_id: evidence.ownerId,
          fence: evidence.fence,
          work_id: evidence.work,
        });
        assert.equal(resolved.status, 200);
        assert.equal(resolved.body['outcome'], 'METADATA_ONLY');
        assert.equal(
          (
            await s.fix('PREPARE', {
              order_id: s.order,
              owner_id: evidence.ownerId,
              fence: evidence.fence,
              work_id: secondWork,
              financial_key: randomUUID(),
            })
          ).status,
          201,
        );
      }
      const original = await durableFixSnapshot(s.id),
        healthy = await healthyIntegrity(context),
        commands = original['fix_commands']!,
        first = commands.find(
          (c) =>
            c['operation'] ===
            (corruption === 'bind-after-record'
              ? 'BIND'
              : corruption === 'queue-before-record'
                ? 'RECORD'
                : corruption === 'resolve-before-prepare'
                  ? 'PREPARE'
                  : 'RESOLVE_METADATA'),
        )!,
        second = commands.find(
          (c) =>
            c['operation'] ===
              (corruption === 'bind-after-record'
                ? 'RECORD'
                : corruption === 'queue-before-record'
                  ? 'QUEUE'
                  : corruption === 'resolve-before-prepare'
                    ? 'RESOLVE_METADATA'
                    : 'PREPARE') &&
            (corruption !== 'later-prepare-before-prior-resolve' ||
              (c['response_body'] as Record<string, unknown>)['work_id'] === secondWork),
        )!,
        expected = [
          {
            code:
              corruption === 'later-prepare-before-prior-resolve'
                ? 'PREPARED_ORDERING'
                : 'OPERATION_ORDERING',
            record_id:
              corruption === 'later-prepare-before-prior-resolve'
                ? secondWork
                : String(first['id']),
          },
        ];
      if (corruption === 'later-prepare-before-prior-resolve') {
        const secondQueue = commands.find(
          (c) =>
            c['operation'] === 'QUEUE' &&
            (c['response_body'] as Record<string, unknown>)['work_id'] === secondWork,
        )!;
        assert.equal(first['command_seq'], 8);
        assert.equal(second['command_seq'], 9);
        assert.equal(secondQueue['command_seq'], 7);
      }
      await swapIntegrityReceipts(context, first, second);
      await assertIntegrityFinding(
        context,
        original,
        healthy,
        expected,
        ['fix_commands', 'fix_events'],
        {
          ...(corruption === 'bind-after-record' ? { protocol_ingest_watermark: '1' } : {}),
          ...(corruption === 'queue-before-record' ? { protocol_ingest_watermark: '3' } : {}),
          ...(corruption === 'resolve-before-prepare' ? { protocol_prepare_watermark: '6' } : {}),
          ...(corruption === 'later-prepare-before-prior-resolve'
            ? { protocol_prepare_watermark: '8' }
            : {}),
        },
      );
    });
});

void test('RECORD duplicate flags, stored first-observation fields, and control operation status remain independent evidence', async () => {
  for (const corruption of [
    'first-logical-flag',
    'first-physical-flag',
    'later-logical-flag',
    'reused-physical-flag',
    'stored-header',
    'nul-byte',
    'high-byte',
    'bind-status',
    'unknown-operation',
  ] as const)
    await withContractSandbox(async (context) => {
      const { s } = context,
        evidence = await operationEvidence(
          context,
          corruption === 'bind-status' || corruption === 'unknown-operation' ? 'BIND' : 'RECORD',
        );
      let targetKey = integrityUuid(evidence.receipt['idempotency_key']);
      if (corruption === 'later-logical-flag') {
        targetKey = randomUUID();
        assert.equal(
          (
            await record(
              s,
              {
                ...evidence.fields!,
                '43': 'Y',
                '122': evidence.fields!['52'],
                '52': '20261030-12:01:00.000',
              },
              targetKey,
            )
          ).status,
          201,
        );
      } else if (corruption === 'reused-physical-flag') {
        targetKey = randomUUID();
        const reused = await record(
          s,
          evidence.fields!,
          targetKey,
          integrityUuid(evidence.attempt),
        );
        assert.equal(reused.status, 201);
        assert.equal(reused.body['logical_duplicate'], true);
        assert.equal(reused.body['physical_duplicate'], true);
      }
      const original = await durableFixSnapshot(s.id),
        healthy = await healthyIntegrity(context),
        receipt = original['fix_commands']!.find((c) => c['idempotency_key'] === targetKey)!,
        receiptId = String(receipt['id']),
        expected: EvidenceFinding[] = [];
      let changed: string[];
      if (corruption === 'nul-byte' || corruption === 'high-byte') {
        await guardedIntegrityCorruption(
          context,
          "UPDATE fi.fix_attempts SET raw_bytes=set_byte(raw_bytes,0,$3),raw_hash=encode(sha256(set_byte(raw_bytes,0,$3)),'hex') WHERE sandbox_id=$1 AND id=$2",
          [s.id, evidence.attempt, corruption === 'nul-byte' ? 0 : 255],
        );
        expected.push(
          { code: 'WIRE_FRAMING', record_id: evidence.attempt },
          { code: 'WIRE_PROFILE', record_id: evidence.attempt },
          { code: 'WIRE_SEMANTICS', record_id: evidence.attempt },
          { code: 'MESSAGE_CONTRACT', record_id: evidence.message },
          { code: 'RECORD_EVIDENCE', record_id: receiptId },
          { code: 'MESSAGE_FIELDS', record_id: evidence.message },
          { code: 'SEQUENCE_CORRELATION', record_id: evidence.message },
          { code: 'MISSING_SEQUENCE', record_id: evidence.attempt },
        );
        changed = ['fix_attempts'];
      } else if (corruption === 'stored-header') {
        await guardedIntegrityCorruption(
          context,
          "UPDATE fi.fix_messages SET fields=jsonb_set(fields,'{34}','\"2\"') WHERE sandbox_id=$1 AND id=$2",
          [s.id, evidence.message],
        );
        expected.push({ code: 'MESSAGE_FIELDS', record_id: evidence.message });
        changed = ['fix_messages'];
      } else if (corruption === 'bind-status') {
        await guardedIntegrityCorruption(
          context,
          'UPDATE fi.fix_commands SET http_status=200 WHERE sandbox_id=$1 AND id=$2',
          [s.id, receiptId],
        );
        expected.push({ code: 'BIND_EVIDENCE', record_id: receiptId });
        changed = ['fix_commands'];
      } else if (corruption === 'unknown-operation') {
        await guardedIntegrityCorruption(
          context,
          "WITH changed AS (UPDATE fi.fix_commands SET operation='UNSUPPORTED' WHERE sandbox_id=$1 AND id=$2 RETURNING command_seq) UPDATE fi.fix_events e SET event_type='UNSUPPORTED' FROM changed c WHERE e.sandbox_id=$1 AND e.command_seq=c.command_seq",
          [s.id, receiptId],
        );
        expected.push(
          { code: 'PROTOCOL_OPERATION', record_id: receiptId },
          { code: 'MISSING_BIND_RECEIPT', record_id: s.order },
          { code: 'OPERATION_ORDERING', record_id: receiptId },
        );
        changed = ['fix_commands', 'fix_events'];
      } else {
        const body = { ...(receipt['response_body'] as Record<string, unknown>) },
          flag = corruption.includes('logical') ? 'logical_duplicate' : 'physical_duplicate';
        body[flag] = !body[flag];
        await rewriteRecordReceipt(context, receiptId, body);
        expected.push({ code: 'RECORD_EVIDENCE', record_id: receiptId });
        changed = ['fix_commands', 'fix_events'];
      }
      await assertIntegrityFinding(context, original, healthy, expected, changed);
    });
});

void test('shared bound channels remain healthy while orphan channels and later correlation witnesses are rejected', async () => {
  for (const corruption of [
    'orphan-channel',
    'later-dealer-correlation',
    'later-cancel-correlation',
  ] as const)
    await withContractSandbox(async (context) => {
      const { s } = context;
      let firstMessage = '',
        secondMessage = '',
        cancel = '';
      if (corruption === 'orphan-channel') {
        const order = await s.createOrder();
        assert.equal(
          (await s.fix('BIND', { order_id: order, dealer_id: 'ATLAS', channel_id: s.channel }))
            .status,
          201,
        );
      } else {
        cancel = randomUUID();
        const fields = await report(
            s,
            corruption === 'later-cancel-correlation'
              ? { '150': '6', '39': '6', '11': cancel, '41': s.order }
              : {},
          ),
          first = await record(s, fields),
          second = await record(s, {
            ...fields,
            '34': '2',
            '17': 'ATLAS-' + randomUUID().toUpperCase(),
          });
        assert.equal(first.status, 201);
        assert.equal(second.status, 201);
        firstMessage = String(first.body['message_id']);
        secondMessage = String(second.body['message_id']);
        assert.notEqual(firstMessage, secondMessage);
      }
      const original = await durableFixSnapshot(s.id),
        healthy = await healthyIntegrity(context),
        orphan = randomUUID(),
        expected: EvidenceFinding[] = [];
      let changed: string[];
      if (corruption === 'orphan-channel') {
        assert.equal(original['fix_channels']!.length, 1);
        assert.equal(original['fix_bindings']!.length, 2);
        await guardedIntegrityCorruption(
          context,
          "INSERT INTO fi.fix_channels VALUES($1,$2,'ATLAS',1)",
          [s.id, orphan],
        );
        expected.push({ code: 'BIND_GRAPH', record_id: orphan });
        changed = ['fix_channels'];
      } else {
        const table =
          corruption === 'later-dealer-correlation'
            ? 'fix_dealer_correlations'
            : 'fix_cancel_correlations';
        assert.equal(original[table]![0]!['first_message_id'], firstMessage);
        await guardedIntegrityCorruption(
          context,
          'UPDATE fi.' + table + ' SET first_message_id=$3 WHERE sandbox_id=$1 AND order_id=$2',
          [s.id, s.order, secondMessage],
        );
        expected.push({
          code:
            corruption === 'later-dealer-correlation' ? 'DEALER_CORRELATION' : 'CANCEL_CORRELATION',
          record_id: corruption === 'later-dealer-correlation' ? s.order : cancel,
        });
        changed = [table];
      }
      await assertIntegrityFinding(context, original, healthy, expected, changed);
    });
});

void test('forensic reconstruction rejects coherently forged retained graphs beyond the admitted binding and message bounds', async () => {
  for (const bound of ['binding', 'message'] as const)
    await withContractSandbox(async (context) => {
      const { s } = context;
      let order = s.order;
      if (bound === 'binding') {
        for (let index = 0; index < 3; index++) {
          const next = await s.createOrder();
          assert.equal(
            (
              await s.fix('BIND', {
                order_id: next,
                dealer_id: 'ATLAS',
                channel_id: s.channel,
              })
            ).status,
            201,
          );
        }
        order = await s.createOrder();
        const beforeRejected = await durableFixSnapshot(s.id),
          rejected = await s.fix('BIND', {
            order_id: order,
            dealer_id: 'ATLAS',
            channel_id: s.channel,
          });
        assert.equal(rejected.status, 429);
        assert.equal((rejected.body['error'] as { code: string }).code, 'FIX_RESERVATION_CAPACITY');
        assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), beforeRejected));
      } else {
        for (let sequence = 1; sequence <= 40; sequence++)
          assert.equal((await record(s, await report(s, { '34': String(sequence) }))).status, 201);
        const beforeRejected = await durableFixSnapshot(s.id),
          rejected = await record(s, await report(s, { '34': '41' }));
        assert.equal(rejected.status, 429);
        assert.equal((rejected.body['error'] as { code: string }).code, 'FIX_MESSAGE_QUOTA');
        assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), beforeRejected));
      }
      const original = await durableFixSnapshot(s.id),
        healthy = await healthyIntegrity(context),
        command = randomUUID(),
        key = randomUUID();
      // A privileged coherent forgery checks the forensic oracle. Ordinary writer admission above
      // remains authoritative and must reject these fifth-binding / forty-first-message requests.
      if (bound === 'binding') {
        const body = {
            order_id: order,
            cl_ord_id: order,
            dealer_order_id: null,
            reserved_commands: 25,
            reserved_events: 43,
            financial_applied: false,
          },
          payload = { order_id: order, dealer_id: 'ATLAS', channel_id: s.channel };
        await guardedIntegrityCorruption(
          context,
          "WITH binding AS (INSERT INTO fi.fix_bindings SELECT sandbox_id,id,$3,'ATLAS',id,encode(sha256(convert_to(contract::text,'UTF8')),'hex'),clock_timestamp() FROM fi.orders WHERE sandbox_id=$1 AND id=$2 RETURNING sandbox_id,order_id),lane AS (INSERT INTO fi.fix_lanes(sandbox_id,order_id) SELECT sandbox_id,order_id FROM binding),reservation AS (INSERT INTO fi_control.fix_reservations(sandbox_id,order_id) SELECT sandbox_id,order_id FROM binding),registry AS (INSERT INTO fi_control.command_keys VALUES($1,$5,'FIX')),receipt AS (INSERT INTO fi.fix_commands VALUES($1,$4,$5,'BIND',encode(sha256(convert_to(jsonb_build_object('version',1,'sandbox',$1::uuid,'operation','BIND','payload',$7::jsonb)::text,'UTF8')),'hex'),5,201,$6,$8) RETURNING command_seq) INSERT INTO fi.fix_events SELECT $1,command_seq,0,'BIND',$2,jsonb_build_object('financial_applied',false,'record',$6::jsonb),clock_timestamp() FROM receipt",
          [
            s.id,
            order,
            s.channel,
            command,
            key,
            JSON.stringify(body),
            JSON.stringify(payload),
            s.actor,
          ],
        );
        await assertIntegrityFinding(
          context,
          original,
          healthy,
          [{ code: 'PROTOCOL_CAPACITY', record_id: s.id }],
          [
            'fix_bindings',
            'fix_lanes',
            'fix_reservations',
            'fix_commands',
            'fix_events',
            'command_keys',
          ],
          { protocol_watermark: '5' },
        );
      } else {
        const raw = encodeFix44(await report(s, { '34': '41' })),
          fields = decodeFix44(raw).fields,
          message = randomUUID(),
          attempt = randomUUID();
        await guardedIntegrityCorruption(
          context,
          "WITH evidence AS (SELECT encode(sha256(convert_to(($4::jsonb-ARRAY['8','9','10','34','43','52','122'])::text,'UTF8')),'hex') semantic,encode(sha256($5::bytea),'hex') raw_hash),message AS (INSERT INTO fi.fix_messages SELECT $1,$6,$8,'ATLAS','EXEC_REPORT',$4::jsonb->>'17','IN','8',$4,semantic,NULL,NULL,clock_timestamp() FROM evidence),attempt AS (INSERT INTO fi.fix_attempts SELECT $1,$7,$6,1,$5,raw_hash,'RECEIVED',clock_timestamp() FROM evidence),slot AS (INSERT INTO fi.fix_sequence_slots VALUES($1,$9,1,'IN',41,$6)),body AS (SELECT jsonb_build_object('order_id',$8::uuid,'message_id',$6::uuid,'attempt_id',$7::uuid,'semantic_hash',semantic,'logical_duplicate',false,'physical_duplicate',false,'raw_hash',raw_hash,'financial_applied',false,'delivery_state','NOT_IMPLEMENTED') value FROM evidence),registry AS (INSERT INTO fi_control.command_keys VALUES($1,$3,'FIX')),receipt AS (INSERT INTO fi.fix_commands SELECT $1,$2,$3,'RECORD',encode(sha256(convert_to(jsonb_build_object('version',1,'sandbox',$1::uuid,'operation','RECORD','payload',jsonb_build_object('order_id',$8::uuid,'raw_hex',encode($5::bytea,'hex'),'attempt_id',$7::uuid))::text,'UTF8')),'hex'),42,201,value,$10 FROM body RETURNING command_seq,response_body) INSERT INTO fi.fix_events SELECT $1,command_seq,0,'RECORD',$8,jsonb_build_object('financial_applied',false,'record',response_body),clock_timestamp() FROM receipt",
          [
            s.id,
            command,
            key,
            JSON.stringify(fields),
            raw,
            message,
            attempt,
            order,
            s.channel,
            s.actor,
          ],
        );
        await assertIntegrityFinding(
          context,
          original,
          healthy,
          [{ code: 'PROTOCOL_CAPACITY', record_id: order }],
          [
            'fix_messages',
            'fix_attempts',
            'fix_sequence_slots',
            'fix_commands',
            'fix_events',
            'command_keys',
          ],
          { protocol_watermark: '42', protocol_ingest_watermark: '42' },
        );
      }
    });
});

async function advanceIntegrityLeaseClock(
  context: ContractContext,
  claimKey: ReturnType<typeof randomUUID>,
) {
  const before = await durableFixSnapshot(context.s.id),
    original = before['fix_commands']!.find((c) => c['idempotency_key'] === claimKey)!;
  assert.equal(original['operation'], 'CLAIM');
  // Test clock fixture: age the same retained lease in its receipt, audit and mutable lane.
  // This privileged setup is followed by an actual RELEASE; it is not a production mutation path.
  await guardedIntegrityCorruption(
    context,
    "WITH aged AS (UPDATE fi.fix_commands SET response_body=jsonb_set(response_body,'{lease_expires_at}',to_jsonb(clock_timestamp()-interval '1 second')) WHERE sandbox_id=$1 AND idempotency_key=$2 RETURNING sandbox_id,command_seq,response_body),audit AS (UPDATE fi.fix_events e SET payload=jsonb_build_object('financial_applied',false,'record',a.response_body) FROM aged a WHERE(e.sandbox_id,e.command_seq)=(a.sandbox_id,a.command_seq)) UPDATE fi.fix_lanes l SET lease_expires_at=(a.response_body->>'lease_expires_at')::timestamptz FROM aged a WHERE l.sandbox_id=a.sandbox_id AND l.order_id::text=a.response_body->>'order_id'",
    [context.s.id, claimKey],
  );
  const aged = await durableFixSnapshot(context.s.id),
    receipt = aged['fix_commands']!.find((c) => c['idempotency_key'] === claimKey)!;
  for (const table of Object.keys(before))
    if (!['fix_commands', 'fix_events', 'fix_lanes'].includes(table))
      assert.ok(isDeepStrictEqual(aged[table], before[table]), 'Test clock changed ' + table);
  assert.equal(receipt['request_hash'], original['request_hash']);
  assert.deepEqual(
    { ...(receipt['response_body'] as Record<string, unknown>), lease_expires_at: null },
    { ...(original['response_body'] as Record<string, unknown>), lease_expires_at: null },
  );
  assert.equal(
    aged['fix_lanes']![0]!['lease_expires_at'],
    (receipt['response_body'] as Record<string, unknown>)['lease_expires_at'],
  );
  return receipt['response_body'] as Record<string, unknown>;
}

void test('retained original sending time, physical observation order and closed-lane lease witnesses cannot be coherently redirected', async () => {
  for (const corruption of ['original-time', 'attempt-order', 'retired-lease'] as const)
    await withContractSandbox(async (context) => {
      const { s } = context;
      let second: Awaited<ReturnType<typeof record>> | undefined,
        third: Awaited<ReturnType<typeof record>> | undefined,
        later: Record<string, string> | undefined;
      if (corruption === 'retired-lease') {
        const key = randomUUID(),
          claimed = await s.fix('CLAIM', { order_id: s.order, owner_id: randomUUID() }, key);
        assert.equal(claimed.status, 200);
        await advanceIntegrityLeaseClock(context, key);
        await healthyIntegrity(context);
        const released = await s.fix('RELEASE', { order_id: s.order });
        assert.equal(released.status, 200);
        assert.equal(released.body['released'], true);
      } else {
        const fields = await report(s),
          first = await record(s, fields);
        assert.equal(first.status, 201);
        later = { ...fields, '43': 'Y', '122': fields['52'], '52': '20261030-12:01:00.000' };
        second = await record(s, later);
        assert.equal(second.status, 201);
        assert.equal(second.body['message_id'], first.body['message_id']);
        assert.equal(second.body['logical_duplicate'], true);
        assert.equal(second.body['physical_duplicate'], false);
        if (corruption === 'attempt-order') {
          third = await record(s, { ...fields, '34': '2' });
          assert.equal(third.status, 201);
          assert.equal(third.body['message_id'], first.body['message_id']);
        } else {
          const beforeRejected = await durableFixSnapshot(s.id),
            rejected = await record(s, { ...later, '122': '20261030-11:59:00.000' });
          assert.equal(rejected.status, 409);
          assert.equal((rejected.body['error'] as { code: string }).code, 'FIX_IDENTITY_CONFLICT');
          assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), beforeRejected));
        }
      }
      const original = await durableFixSnapshot(s.id),
        healthy = await healthyIntegrity(context),
        expected: EvidenceFinding[] = [];
      let changed: string[];
      if (corruption === 'original-time') {
        const raw = encodeFix44({ ...later!, '122': '20261030-11:59:00.000' }),
          attempt = String(second!.body['attempt_id']);
        await guardedIntegrityCorruption(
          context,
          "WITH observed AS (UPDATE fi.fix_attempts SET raw_bytes=$3,raw_hash=encode(sha256($3::bytea),'hex') WHERE sandbox_id=$1 AND id=$2 RETURNING sandbox_id,id,raw_hash),receipt AS (UPDATE fi.fix_commands c SET response_body=jsonb_set(c.response_body,'{raw_hash}',to_jsonb(a.raw_hash)),request_hash=encode(sha256(convert_to(jsonb_build_object('version',1,'sandbox',c.sandbox_id,'operation','RECORD','payload',jsonb_build_object('order_id',$4::text,'attempt_id',$2::text,'raw_hex',encode($3::bytea,'hex')))::text,'UTF8')),'hex') FROM observed a WHERE c.sandbox_id=a.sandbox_id AND c.operation='RECORD' AND c.response_body->>'attempt_id'=a.id::text RETURNING c.sandbox_id,c.command_seq,c.response_body) UPDATE fi.fix_events e SET payload=jsonb_build_object('financial_applied',false,'record',c.response_body) FROM receipt c WHERE(e.sandbox_id,e.command_seq)=(c.sandbox_id,c.command_seq)",
          [s.id, attempt, raw, s.order],
        );
        expected.push({ code: 'RETRANSMISSION_EVIDENCE', record_id: attempt });
        changed = ['fix_attempts', 'fix_commands', 'fix_events'];
      } else if (corruption === 'attempt-order') {
        const secondAttempt = String(second!.body['attempt_id']),
          thirdAttempt = String(third!.body['attempt_id']);
        assert.deepEqual(original['fix_attempts']!.map((a) => a['attempt_no']).sort(), [1, 2, 3]);
        // The temporary value stays inside the existing CHECK and unique constraints.
        for (const [attempt, ordinal] of [
          [secondAttempt, 4],
          [thirdAttempt, 2],
          [secondAttempt, 3],
        ] as const)
          await guardedIntegrityCorruption(
            context,
            'UPDATE fi.fix_attempts SET attempt_no=$3 WHERE sandbox_id=$1 AND id=$2',
            [s.id, attempt, ordinal],
          );
        expected.push(
          { code: 'ATTEMPT_SEQUENCE', record_id: secondAttempt },
          { code: 'ATTEMPT_SEQUENCE', record_id: thirdAttempt },
        );
        changed = ['fix_attempts'];
      } else {
        await guardedIntegrityCorruption(
          context,
          "UPDATE fi.fix_lanes SET lease_expires_at=lease_expires_at-interval '1 second' WHERE sandbox_id=$1 AND order_id=$2",
          [s.id, s.order],
        );
        expected.push({ code: 'LANE_LINEAGE', record_id: s.order });
        changed = ['fix_lanes'];
      }
      await assertIntegrityFinding(context, original, healthy, expected, changed);
    });
});

void test('second physical observations enforce bounded wire grammar and profile independently of coherent hashes, receipts and the valid first observation', async () => {
  const cases = [
    'duplicate-52',
    'swapped-header',
    'empty-token',
    'malformed-token',
    'invalid-52-date',
    'invalid-43',
    'unlicensed-122',
    'missing-60',
    'invalid-60-date',
    '75-date-mismatch',
    'unsupported-58',
    'unknown-tag',
  ] as const;
  for (const corruption of cases)
    await withContractSandbox(async (context) => {
      const { s } = context,
        fields = await report(s),
        first = await record(s, fields),
        later = { ...fields, '43': 'Y', '122': fields['52'], '52': '20261030-12:01:00.000' },
        second = await record(s, later);
      assert.equal(first.status, 201);
      assert.equal(second.status, 201);
      assert.equal(second.body['message_id'], first.body['message_id']);
      assert.equal(second.body['logical_duplicate'], true);
      assert.equal(second.body['physical_duplicate'], false);
      const tokens = encodeFix44(later).toString('ascii').split('\x01').slice(2, -2),
        indexOf = (tag: string) => {
          const index = tokens.findIndex((token) => token.startsWith(tag + '='));
          assert.ok(index >= 0, 'Healthy observation must contain ' + tag);
          return index;
        },
        set = (tag: string, value: string) => {
          const index = tokens.findIndex((token) => token.startsWith(tag + '='));
          if (index >= 0) tokens[index] = tag + '=' + value;
          else tokens.push(tag + '=' + value);
        };
      if (corruption === 'duplicate-52') {
        const index = indexOf('52');
        tokens.splice(index + 1, 0, tokens[index]!);
      } else if (corruption === 'swapped-header') {
        const sender = indexOf('49'),
          target = indexOf('56'),
          originalSender = tokens[sender]!;
        tokens[sender] = tokens[target]!;
        tokens[target] = originalSender;
      } else if (corruption === 'empty-token') tokens.splice(indexOf('60'), 0, '');
      else if (corruption === 'malformed-token') tokens[indexOf('52')] = '52';
      else if (corruption === 'invalid-52-date') set('52', '20261330-12:01:00.000');
      else if (corruption === 'invalid-43') set('43', 'INVALID');
      else if (corruption === 'unlicensed-122') set('43', 'N');
      else if (corruption === 'missing-60') tokens.splice(indexOf('60'), 1);
      else if (corruption === 'invalid-60-date') set('60', '20260230-12:00:00.000');
      else if (corruption === '75-date-mismatch') set('75', '20261029');
      else if (corruption === 'unsupported-58') set('58', 'SYNTHETIC_UNSUPPORTED');
      else set('9999', 'SYNTHETIC');
      // Preserve actual byte length and checksum while deliberately bypassing the application codec.
      const body = Buffer.from(tokens.join('\x01') + '\x01', 'ascii'),
        prefix = Buffer.concat([
          Buffer.from('8=FIX.4.4\x019=' + body.length + '\x01', 'ascii'),
          body,
        ]),
        checksum = prefix.reduce((sum, byte) => (sum + byte) % 256, 0),
        raw = Buffer.concat([
          prefix,
          Buffer.from('10=' + String(checksum).padStart(3, '0') + '\x01', 'ascii'),
        ]),
        original = await durableFixSnapshot(s.id),
        healthy = await healthyIntegrity(context),
        rejected = await s.fix('RECORD', {
          order_id: s.order,
          attempt_id: randomUUID(),
          raw_hex: raw.toString('hex'),
        });
      assert.equal(rejected.status, 400);
      assert.equal((rejected.body['error'] as { code: string }).code, 'FIX_PROFILE_VIOLATION');
      assert.ok(isDeepStrictEqual(await durableFixSnapshot(s.id), original));
      const attempt = String(second.body['attempt_id']),
        receipt = original['fix_commands']!.find(
          (c) =>
            c['operation'] === 'RECORD' &&
            (c['response_body'] as Record<string, unknown>)['attempt_id'] === attempt,
        )!,
        framing = ['duplicate-52', 'swapped-header', 'empty-token', 'malformed-token'].includes(
          corruption,
        ),
        profile = !['duplicate-52', 'swapped-header', 'empty-token'].includes(corruption),
        semantic = [
          'missing-60',
          'invalid-60-date',
          '75-date-mismatch',
          'unsupported-58',
          'unknown-tag',
        ].includes(corruption),
        expected: EvidenceFinding[] = [];
      await guardedIntegrityCorruption(
        context,
        "WITH observed AS (UPDATE fi.fix_attempts SET raw_bytes=$3,raw_hash=encode(sha256($3::bytea),'hex') WHERE sandbox_id=$1 AND id=$2 RETURNING sandbox_id,id,raw_hash),receipt AS (UPDATE fi.fix_commands c SET response_body=jsonb_set(c.response_body,'{raw_hash}',to_jsonb(a.raw_hash)),request_hash=encode(sha256(convert_to(jsonb_build_object('version',1,'sandbox',c.sandbox_id,'operation','RECORD','payload',jsonb_build_object('order_id',$4::text,'attempt_id',$2::text,'raw_hex',encode($3::bytea,'hex')))::text,'UTF8')),'hex') FROM observed a WHERE c.sandbox_id=a.sandbox_id AND c.operation='RECORD' AND c.response_body->>'attempt_id'=a.id::text RETURNING c.sandbox_id,c.command_seq,c.response_body) UPDATE fi.fix_events e SET payload=jsonb_build_object('financial_applied',false,'record',c.response_body) FROM receipt c WHERE(e.sandbox_id,e.command_seq)=(c.sandbox_id,c.command_seq)",
        [s.id, attempt, raw, s.order],
      );
      if (framing) expected.push({ code: 'WIRE_FRAMING', record_id: attempt });
      if (profile) expected.push({ code: 'WIRE_PROFILE', record_id: attempt });
      if (semantic)
        expected.push(
          { code: 'WIRE_SEMANTICS', record_id: attempt },
          { code: 'RECORD_EVIDENCE', record_id: String(receipt['id']) },
        );
      const damaged = await assertIntegrityFinding(context, original, healthy, expected, [
        'fix_attempts',
        'fix_commands',
        'fix_events',
      ]);
      assert.ok(
        isDeepStrictEqual(damaged['fix_messages'], original['fix_messages']),
        'The first logical observation must stay independent of the corrupted retransmission.',
      );
      const firstAttempt = String(first.body['attempt_id']);
      assert.ok(
        isDeepStrictEqual(
          damaged['fix_attempts']!.find((a) => a['id'] === firstAttempt),
          original['fix_attempts']!.find((a) => a['id'] === firstAttempt),
        ),
      );
    });
  console.log('Bounded independent wire observation matrix:', JSON.stringify({ cases }));
});

void test('the maximum admitted wire graph and 1024 retained receipts remain verifiable under unchanged verifier limits', async () => {
  await withContractSandbox(async (context) => {
    const { s, database, binding } = context,
      orders = [s.order];
    for (let index = 0; index < 3; index++) orders.push(await s.createOrder());
    for (const order of orders) {
      if (order !== s.order)
        assert.equal(
          (
            await s.fix('BIND', {
              order_id: order,
              dealer_id: 'ATLAS',
              channel_id: randomUUID(),
            })
          ).status,
          201,
        );
      const orderFixture = { ...s, order };
      for (let sequence = 1; sequence <= 40; sequence++) {
        const fields = await report(orderFixture, { '34': String(sequence) }),
          raw = encodeFix44(fields).toString('hex');
        for (let observation = 0; observation < 4; observation++) {
          const recorded = await s.fix('RECORD', {
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
    const ownerId = randomUUID();
    for (let fence = 1; fence <= 380; fence++) {
      const claimed = await s.fix('CLAIM', { order_id: s.order, owner_id: ownerId });
      assert.equal(claimed.status, 200);
      assert.equal(claimed.body['fence'], String(fence));
    }
    const before = await durableFixSnapshot(s.id);
    assert.equal(before['fix_bindings']!.length, 4);
    assert.equal(before['fix_channels']!.length, 4);
    assert.equal(before['fix_messages']!.length, 160);
    assert.equal(before['fix_attempts']!.length, 640);
    assert.equal(before['fix_sequence_slots']!.length, 160);
    assert.equal(before['fix_commands']!.length, 1024);
    assert.equal(before['fix_events']!.length, 1024);
    assert.equal(before['command_keys']!.filter((key) => key['domain'] === 'FIX').length, 1024);
    assert.equal(before['fix_outbox']!.length, 0);
    assert.equal(before['fix_work']!.length, 0);
    assert.equal(before['executions']!.length, 0);
    assert.equal(before['positions']!.length, 0);
    const assessment = await verifyFixFoundation(database, binding, () => {}, true);
    assert.equal(assessment.foundation_assessment, 'FOUNDATION_CONSISTENT');
    assert.deepEqual(assessment.findings, []);
    assert.equal(assessment.total_findings, 0);
    assert.deepEqual(scopeEvidence(assessment), {
      financial_watermark: '13',
      protocol_watermark: '1024',
      protocol_ingest_watermark: '644',
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
      'Maximum-graph verification must remain read only.',
    );
    console.log(
      'Maximum admitted protocol verification evidence:',
      JSON.stringify({
        bindings: 4,
        logicalMessages: 160,
        physicalAttempts: 640,
        retainedReceipts: 1024,
        assessment: assessment.foundation_assessment,
        unchangedVerifierLimits: true,
      }),
    );
  });
});
