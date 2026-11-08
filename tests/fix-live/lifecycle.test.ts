/** Actual native rejection/cancellation/pending-cancel evidence and independent ledger checks. */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { report } from '../postgres/fix-fixture.js';
import { LiveVerificationDatabase } from '../../app/server/fix/live-verification-database.js';
import { verifyLiveApplication } from '../../app/server/fix/live-reconciliation.js';
import { DomainError } from '../../app/domain/errors.js';
import { liveScenario, startLiveTestDatabase, body } from './runtime-fixture.js';

let database: Awaited<ReturnType<typeof startLiveTestDatabase>> | undefined;
before(async () => {
  database = await startLiveTestDatabase();
});
after(async () => {
  await database?.close();
});

for (const mode of [
  'rejected',
  'cancel-rejected',
  'canceled',
  'partial-canceled',
  'pending-fill-too-late',
] as const)
  void test(`real ${mode} lifecycle retains exact native evidence and original financial effects`, async () => {
    assert.ok(database);
    const h = await liveScenario(database.owned),
      reader = new LiveVerificationDatabase(h.cfg.reconcilerUrl!);
    try {
      await h.controller.start();
      const original = body(await report(h.s));
      const order: Record<string, string> = { ...original, '35': 'D', '21': '1' };
      for (const tag of ['37', '17', '150', '39', '14', '151', '6']) delete order[tag];
      await h.controller.send(h.s.order, order);
      const send = async (changes: Record<string, string>) => {
        const result = await h.controller.send(h.s.order, body(await report(h.s, changes)));
        assert.equal(result.status, 200, JSON.stringify(result));
      };
      const price = original['44']!;
      let expected = 'NEW',
        fills = 0,
        par = '0.00';
      if (mode === 'rejected') {
        await send({
          '150': '8',
          '39': '8',
          '103': '99',
          '58': 'SYNTHETIC_REJECTION',
          '151': '0.00',
        });
        expected = 'REJECTED';
      } else {
        await send({});
        if (mode === 'partial-canceled' || mode === 'pending-fill-too-late') {
          await send({
            '150': 'F',
            '39': '1',
            '32': '40.00',
            '31': price,
            '6': price,
            '14': '40.00',
            '151': '60.00',
          });
          fills = 1;
          par = '40.00';
        }
        const cancel = randomUUID();
        const request = {
          '35': 'F',
          '11': cancel,
          '41': h.s.order,
          '37': original['37']!,
          '55': original['55']!,
          '167': original['167']!,
          '54': original['54']!,
          '38': original['38']!,
          '60': new Date().toISOString().replaceAll('-', '').replace('T', '-').replace('Z', ''),
          '58': 'SYNTHETIC_CANCEL_REQUEST',
        };
        assert.equal((await h.controller.send(h.s.order, request)).status, 200);
        if (mode === 'pending-fill-too-late') {
          const metadata = await h.controller.send(
            h.s.order,
            body(
              await report(h.s, {
                '11': cancel,
                '41': h.s.order,
                '150': '6',
                '39': '6',
                '14': '40.00',
                '151': '60.00',
                '6': price,
              }),
            ),
          );
          assert.equal(metadata.status, 200);
          assert.equal((metadata.body as { financial_applied?: boolean }).financial_applied, false);
          await send({
            '150': 'F',
            '39': '6',
            '32': '60.00',
            '31': price,
            '6': price,
            '14': '100.00',
            '151': '0.00',
          });
          fills = 2;
          par = '100.00';
          expected = 'FILLED';
        }
        if (mode === 'cancel-rejected' || mode === 'pending-fill-too-late') {
          const rejection = {
            '35': '9',
            '11': cancel,
            '41': h.s.order,
            '37': original['37']!,
            '39': mode === 'pending-fill-too-late' ? '2' : '0',
            '434': '1',
            '102': mode === 'pending-fill-too-late' ? '0' : '99',
            '60': request['60'],
            '58': 'SYNTHETIC_CANCEL_REJECT',
          };
          assert.equal((await h.controller.send(h.s.order, rejection)).status, 200);
        } else {
          await send({
            '11': cancel,
            '41': h.s.order,
            '150': '4',
            '39': '4',
            '14': par,
            '151': '0.00',
            '6': fills ? price : '0.000000000000',
          });
          expected = 'CANCELED';
        }
      }
      await h.controller.stop();
      assert.deepEqual(
        (
          await h.s.app.query<{
            status: string;
            filled_par: string;
            execution_count: number;
            pending_cancel_id: string | null;
          }>(
            'SELECT status,filled_par::text,execution_count,pending_cancel_id FROM fi.order_states WHERE sandbox_id=$1 AND order_id=$2',
            [h.s.id, h.s.order],
          )
        ).rows[0],
        { status: expected, filled_par: par, execution_count: fills, pending_cancel_id: null },
      );
      const verified = await verifyLiveApplication(reader, h.binding, h.journal, () => {}, true);
      assert.equal(verified.total_findings, 0, JSON.stringify(verified.findings));
      assert.equal(verified.financial_application_verified, true);
      assert.equal(verified.oracle.executions, fills);
      assert.equal(verified.external_delivery_verified, false);
    } finally {
      await reader.close();
      await h.close();
    }
  });
void test('an actual duplicate-order rejection remains unresolved instead of fabricating a financial rejection', async () => {
  assert.ok(database);
  const h = await liveScenario(database.owned),
    reader = new LiveVerificationDatabase(h.cfg.reconcilerUrl!);
  try {
    await h.controller.start();
    const order = body(await report(h.s, { '35': 'D', '21': '1' }));
    for (const tag of ['37', '17', '150', '39', '14', '151', '6']) delete order[tag];
    await h.controller.send(h.s.order, order);
    const rejected = body(
      await report(h.s, {
        '150': '8',
        '39': '8',
        '103': '6',
        '58': 'SYNTHETIC_REJECTION',
        '151': '0.00',
      }),
    );
    await assert.rejects(
      () => h.controller.send(h.s.order, rejected),
      (e: unknown) => e instanceof DomainError && e.code === 'FIX_LIVE_SQL_REJECTED',
    );
    assert.equal(
      (
        await h.s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_applications WHERE sandbox_id=$1',
          [h.s.id],
        )
      ).rows[0]!.n,
      0,
    );
    assert.equal(
      (
        await h.s.app.query<{ status: string }>(
          'SELECT status FROM fi.order_states WHERE sandbox_id=$1 AND order_id=$2',
          [h.s.id, h.s.order],
        )
      ).rows[0]!.status,
      'PENDING_ACK',
    );
    const verified = await verifyLiveApplication(reader, h.binding, h.journal, () => {}, true);
    assert.equal(verified.financial_application_verified, false);
    assert.equal(verified.assessment, 'INCOMPLETE');
  } finally {
    await reader.close();
    await h.close();
  }
});
