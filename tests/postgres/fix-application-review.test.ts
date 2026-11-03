import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { applicationFixture } from './fix-application-fixture.js';
import { connection } from './harness.js';
async function pendingFixture(contradictory = false) {
  const s = await applicationFixture();
  await s.apply((await s.prepare()).work);
  const cancel = randomUUID(),
    base = { '11': cancel, '41': s.order };
  await s.apply((await s.prepare({ '35': 'F', '49': 'TRADEFLOW', '56': 'ATLAS', ...base })).work);
  const px = (
    await s.app.query<{ contract: Record<string, string> }>(
      'SELECT contract FROM fi.orders WHERE sandbox_id=$1',
      [s.id],
    )
  ).rows[0]!.contract['clean_price']!;
  const p = await s.prepare({
    ...base,
    '150': '6',
    '39': '6',
    ...(contradictory ? { '14': '40.00', '151': '60.00', '6': px } : {}),
  });
  return { s, p, px };
}
void test('review: a legacy unvalidated metadata outcome cannot unblock a contradictory pending-cancel head for later financial work', async () => {
  const { s, p, px } = await pendingFixture(true);
  try {
    assert.equal((await s.apply(p.work)).status, 409);
    assert.equal(
      (
        await s.fix('RESOLVE_METADATA', {
          order_id: s.order,
          owner_id: s.owner,
          fence: s.fence,
          work_id: p.work,
        })
      ).status,
      200,
    );
    const next = await s.stage({
        '150': 'F',
        '39': '1',
        '14': '40.00',
        '151': '60.00',
        '32': '40.00',
        '31': px,
        '6': px,
      }),
      work = randomUUID();
    await s.fix('QUEUE', { order_id: s.order, message_id: next.message, work_id: work });
    assert.equal(
      (
        await s.fix('PREPARE', {
          order_id: s.order,
          owner_id: s.owner,
          fence: s.fence,
          work_id: work,
          financial_key: randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal(
      (await s.app.query('SELECT * FROM fi.executions WHERE sandbox_id=$1', [s.id])).rowCount,
      0,
    );
  } finally {
    await s.close();
  }
});
void test('review: pending-cancel protocol observation cannot COMMIT after its current fence expires', async () => {
  const { s, p } = await pendingFixture(),
    admin = await connection('admin');
  try {
    await admin.query('BEGIN');
    assert.equal((await s.apply(p.work, randomUUID(), admin)).status, 200);
    // Deterministic fault at the real COMMIT boundary, equivalent to the independent
    // reviewer waiting16seconds beyond the15-second lease, without arbitrary sleeps.
    await admin.query(
      "UPDATE fi.fix_lanes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1",
      [s.id],
    );
    await assert.rejects(
      admin.query('COMMIT'),
      (e: unknown) => (e as { code?: string }).code === '23514',
    );
    assert.equal(
      (await s.app.query('SELECT * FROM fi.fix_protocol_observations WHERE sandbox_id=$1', [s.id]))
        .rowCount,
      0,
    );
  } finally {
    await admin.query('ROLLBACK');
    await admin.end();
    await s.close();
  }
});
void test('review: matched raw/semantic pending-cancel OrdStatus corruption must be an independent protocol finding', async () => {
  const { s, p } = await pendingFixture(),
    admin = await connection('admin'),
    db = await connection('reconciler');
  try {
    assert.equal((await s.apply(p.work)).status, 200);
    const sql = await readFile('verification/sql/fix_application.sql', 'utf8');
    assert.equal(
      (await db.query<{ total_findings: number }>(sql, [s.id])).rows[0]!.total_findings,
      0,
    );
    const row = (
      await admin.query<{ raw_bytes: Buffer }>(
        'SELECT raw_bytes FROM fi.fix_attempts WHERE sandbox_id=$1 AND message_id=$2',
        [s.id, p.message],
      )
    ).rows[0]!;
    const raw = Buffer.from(
      row.raw_bytes.toString('ascii').replace('\x0139=6\x01', '\x0139=1\x01'),
      'ascii',
    );
    const prefix = raw.subarray(0, -7),
      sum = prefix.reduce((a, b) => a + b, 0) % 256;
    raw.write('10=' + String(sum).padStart(3, '0') + '\x01', raw.length - 7, 'ascii');
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      "UPDATE fi.fix_messages SET fields=jsonb_set(fields,'{39}','\"1\"'),semantic_hash=encode(sha256(convert_to((jsonb_set(fields,'{39}','\"1\"')-ARRAY['8','9','10','34','43','52','122'])::text,'UTF8')),'hex') WHERE sandbox_id=$1 AND id=$2",
      [s.id, p.message],
    );
    await admin.query(
      "UPDATE fi.fix_attempts SET raw_bytes=$3,raw_hash=encode(sha256($3),'hex') WHERE sandbox_id=$1 AND message_id=$2",
      [s.id, p.message, raw],
    );
    await admin.query('COMMIT');
    assert.ok(
      (await db.query<{ findings: { code: string }[] }>(sql, [s.id])).rows[0]!.findings.some(
        (x) => x.code === 'PENDING_CANCEL_EVIDENCE',
      ),
    );
  } finally {
    await admin.end();
    await db.end();
    await s.close();
  }
});

import { spawnSync } from 'node:child_process';

for (const source of [
  'fix_application_v2.sql',
  'fix_foundation_v2.sql',
  'fix_foundation.sql',
  'foundation.sql',
  'rfq.sql',
  'executions.sql',
  'reconciliation.sql',
])
  void test(
    'application verification stays default OFF and rejects changed ' +
      source +
      ' before database access',
    { timeout: 30000 },
    () => {
      const script = String.raw`
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import * as fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const source=process.argv[1],url=pathToFileURL(process.cwd()+'/verification/sql/'+source);
const original=await fs.readFile(url,'utf8');
let reads=0,transactions=0,authorizations=0;
mock.module('node:fs/promises',{exports:{...fs,readFile:async(file,...args)=>{
 if(file instanceof URL&&file.href===url.href||typeof file==='string'&&file===url.pathname){
  reads++;return original+'\n-- unreviewed source change\n';
 }
 return fs.readFile(file,...args);
}}});
const {verifyFixApplication}=await import('./app/server/fix/application-reconciliation.ts');
const {DomainError}=await import('./app/domain/errors.ts');
const database={transaction(){transactions++;throw new Error('Source guard reached database.');}};
const binding={sandboxId:'00000000-0000-4000-8000-000000000001',digest:'not-a-credential',scope:'trade',generation:'1'};
const verify=()=>{authorizations++;};
await assert.rejects(verifyFixApplication(database,binding,verify),error=>error instanceof DomainError&&error.status===503&&error.code==='FIX_APPLICATION_DISABLED');
assert.equal(reads,0);
await assert.rejects(verifyFixApplication(database,binding,verify,true),error=>
 ['fix_application_v2.sql','fix_foundation_v2.sql','fix_foundation.sql'].includes(source)
 ? error instanceof DomainError&&error.status===503&&error.code==='VERIFICATION_SOURCE_CHANGED'
 : error instanceof Error&&error.message==='Reviewed verification source mismatch.');
assert.equal(reads,1);assert.equal(transactions,0);assert.equal(authorizations,0);
console.log(JSON.stringify({defaultOff:true,sourceChangeRejected:true,reads,transactions,authorizations}));
`;
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-test-module-mocks',
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          script,
          source,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, TF_DB_OWNER_FILE: '' },
          encoding: 'utf8',
          timeout: 20000,
          maxBuffer: 64 * 1024,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), {
        defaultOff: true,
        sourceChangeRejected: true,
        reads: 1,
        transactions: 0,
        authorizations: 0,
      });
    },
  );
