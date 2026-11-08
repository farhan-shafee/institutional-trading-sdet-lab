/** Independent live verification with real owned engines and immutable SQL evidence. */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { LiveVerificationDatabase } from '../../app/server/fix/live-verification-database.js';
import { verifyLiveApplication } from '../../app/server/fix/live-reconciliation.js';
import { DomainError } from '../../app/domain/errors.js';
import { join } from 'node:path';
import { loadPrivate, replacePrivate } from '../../scripts/private-state.js';
import { report } from '../postgres/fix-fixture.js';
import { connection } from '../postgres/harness.js';
import { liveScenario, startLiveTestDatabase, body } from './runtime-fixture.js';

let database: Awaited<ReturnType<typeof startLiveTestDatabase>> | undefined;
before(async () => {
  database = await startLiveTestDatabase();
});
after(async () => {
  await database?.close();
});

void test('live verification requires its explicit feature flag and current authorized snapshot', async () => {
  assert.ok(database);
  const h = await liveScenario(database.owned),
    reader = new LiveVerificationDatabase(h.cfg.reconcilerUrl!);
  try {
    await h.controller.start();
    await assert.rejects(
      () => verifyLiveApplication(reader, h.binding, h.journal, () => {}),
      (e: unknown) => e instanceof DomainError && e.code === 'FIX_LIVE_VERIFICATION_DISABLED',
    );
    await assert.rejects(
      () =>
        verifyLiveApplication(
          reader,
          { ...h.binding, digest: 'f'.repeat(64) },
          h.journal,
          () => {},
          true,
        ),
      (e: unknown) => e instanceof DomainError && e.code === 'SANDBOX_NOT_FOUND',
    );
    const result = await verifyLiveApplication(reader, h.binding, h.journal, () => {}, true);
    assert.equal(result.profile, 'fix-live-application-v1');
    assert.equal(result.physical_schema_revision, 9);
    assert.equal(result.financial_application_verified, false);
    assert.equal(result.assessment, 'INCOMPLETE');
  } finally {
    await reader.close();
    await h.close();
  }
});

for (const side of ['BUY', 'SELL'])
  for (const instrument of ['SYN-UST-2031', 'SYN-CORP-2031'])
    void test(`independent live SQL and rational oracle verify real ${instrument} ${side} partial/final fills`, async () => {
      assert.ok(database);
      const h = await liveScenario(database.owned, '100.00', side, instrument),
        reader = new LiveVerificationDatabase(h.cfg.reconcilerUrl!);
      try {
        await h.controller.start();
        const order = body(await report(h.s, { '35': 'D', '21': '1' }));
        for (const tag of ['37', '17', '150', '39', '14', '151', '6']) delete order[tag];
        await h.controller.send(h.s.order, order);
        await h.controller.send(h.s.order, body(await report(h.s)));
        const price = (await report(h.s))['44'];
        for (const [par, cum, leaves, status] of [
          ['40.00', '40.00', '60.00', '1'],
          ['60.00', '100.00', '0.00', '2'],
        ])
          assert.equal(
            (
              await h.controller.send(
                h.s.order,
                body(
                  await report(h.s, {
                    '150': 'F',
                    '39': status!,
                    '32': par!,
                    '31': price,
                    '6': price,
                    '14': cum!,
                    '151': leaves!,
                  }),
                ),
              )
            ).status,
            200,
          );
        await h.controller.stop();
        const result = await verifyLiveApplication(reader, h.binding, h.journal, () => {}, true);
        assert.equal(result.total_findings, 0, JSON.stringify(result.findings));
        assert.equal(result.assessment, 'OBSERVED_LIVE_APPLICATION_CONSISTENT');
        assert.equal(result.financial_application_verified, true);
        assert.equal(result.oracle.executions, 2);
        assert.equal(result.live_callbacks, 4);
        assert.equal(result.external_delivery_verified, false);
        assert.equal(result.external_completeness_verified, false);
      } finally {
        await reader.close();
        await h.close();
      }
    });

async function acknowledged() {
  assert.ok(database);
  const h = await liveScenario(database.owned),
    reader = new LiveVerificationDatabase(h.cfg.reconcilerUrl!);
  try {
    await h.controller.start();
    const order = body(await report(h.s, { '35': 'D', '21': '1' }));
    for (const tag of ['37', '17', '150', '39', '14', '151', '6']) delete order[tag];
    await h.controller.send(h.s.order, order);
    await h.controller.send(h.s.order, body(await report(h.s)));
    await h.controller.stop();
    const before = await verifyLiveApplication(reader, h.binding, h.journal, () => {}, true);
    assert.equal(before.total_findings, 0, JSON.stringify(before.findings));
    assert.equal(before.financial_application_verified, true);
    return { h, reader };
  } catch (error) {
    await reader.close();
    await h.close();
    throw error;
  }
}
for (const mutation of [
  {
    code: 'LIVE_WIRE',
    sql: "UPDATE fi.fix_live_observations SET raw_bytes=set_byte(raw_bytes,0,57),raw_hash=encode(sha256(set_byte(raw_bytes,0,57)),'hex') WHERE sandbox_id=$1",
  },
  {
    code: 'LIVE_CALLBACK_WIRE',
    sql: "UPDATE fi.fix_live_callbacks SET callback_bytes=set_byte(callback_bytes,0,57),callback_hash=encode(sha256(set_byte(callback_bytes,0,57)),'hex') WHERE sandbox_id=$1",
  },
  {
    code: 'LIVE_NATIVE_PROCESS',
    sql: 'UPDATE fi.fix_live_connections SET java_pid=java_pid+100000 WHERE sandbox_id=$1',
  },
  {
    code: 'LIVE_STORE_SEQUENCE',
    sql: 'UPDATE fi.fix_live_sequence_slots SET message_seq=message_seq+1000 WHERE sandbox_id=$1',
  },
  {
    code: 'LIVE_REQUEST_FINGERPRINT',
    sql: "UPDATE fi.fix_live_requests SET request_hash=repeat('a',64) WHERE sandbox_id=$1",
  },
  {
    code: 'FINANCIAL_FINGERPRINT',
    sql: "UPDATE fi.fix_applications SET financial_request_hash=repeat('a',64) WHERE sandbox_id=$1",
  },
  {
    code: 'APPLICATION_CAPACITY',
    sql: 'UPDATE fi.fix_consumptions SET events=3 WHERE sandbox_id=$1',
  },
])
  void test(`independent live verification detects isolated ${mutation.code} corruption after real native acceptance`, async () => {
    const { h, reader } = await acknowledged();
    const admin = await connection('admin');
    try {
      await admin.query('BEGIN');
      await admin.query("SET LOCAL session_replication_role='replica'");
      await admin.query(mutation.sql, [h.s.id]);
      await admin.query('COMMIT');
      const result = await verifyLiveApplication(reader, h.binding, h.journal, () => {}, true);
      assert.ok(
        result.findings.some((f) => f.code === mutation.code),
        JSON.stringify(result.findings),
      );
      assert.ok(result.total_findings > 0);
      assert.equal(result.financial_application_verified, false);
      assert.equal(result.assessment, 'LIVE_APPLICATION_FINDINGS');
    } finally {
      await admin.end();
      await reader.close();
      await h.close();
    }
  });
void test('losing a real native callback witness cannot be repaired by SQL acceptance or financial receipts', async () => {
  const { h, reader } = await acknowledged();
  try {
    const accepted = (await h.journal.entries('request')).find(
      (r) =>
        typeof r.value === 'object' &&
        r.value !== null &&
        'action' in r.value &&
        r.value.action === 'ACCEPT',
    );
    assert.ok(accepted);
    const path = join(h.journal.directory, 'request-' + accepted.id + '.json');
    const retained = (await loadPrivate(path)) as { value: Record<string, unknown> };
    delete retained.value['witness'];
    await replacePrivate(path, retained);
    const result = await verifyLiveApplication(reader, h.binding, h.journal, () => {}, true);
    assert.ok(result.findings.some((f) => f.code === 'LIVE_NATIVE_WITNESS'));
    assert.equal(result.financial_application_verified, false);
  } finally {
    await reader.close();
    await h.close();
  }
});
void test('the live verifier follows native reconnect/restart slots while logical replay reuses its financial key', async () => {
  assert.ok(database);
  const h = await liveScenario(database.owned),
    reader = new LiveVerificationDatabase(h.cfg.reconcilerUrl!);
  try {
    await h.controller.start();
    const order = body(await report(h.s, { '35': 'D', '21': '1' }));
    for (const tag of ['37', '17', '150', '39', '14', '151', '6']) delete order[tag];
    await h.controller.send(h.s.order, order);
    const ack = body(await report(h.s));
    await h.controller.send(h.s.order, ack);
    const original = await h.journal.entries('work');
    assert.equal(original.length, 1);
    for (const role of ['none', 'go', 'java'] as const) {
      await h.controller.reconnect(role);
      assert.equal((await h.controller.send(h.s.order, ack)).status, 200);
    }
    await h.controller.stop();
    assert.deepEqual(await h.journal.entries('work'), original);
    const verified = await verifyLiveApplication(reader, h.binding, h.journal, () => {}, true);
    assert.equal(verified.total_findings, 0, JSON.stringify(verified.findings));
    assert.equal(verified.financial_application_verified, true);
    assert.equal(verified.runtime_connection_watermark, 4);
    assert.equal(verified.live_callbacks, 5);
    assert.equal(
      (
        await h.s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_consumptions WHERE sandbox_id=$1',
          [h.s.id],
        )
      ).rows[0]!.n,
      1,
    );
  } finally {
    await reader.close();
    await h.close();
  }
});
