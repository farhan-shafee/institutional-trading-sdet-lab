import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { applicationFixture } from './fix-application-fixture.js';
import { owner } from './harness.js';
import { VerificationDatabase } from '../../app/server/reconciliation/database.js';
import { verifyFixApplication } from '../../app/server/fix/application-reconciliation.js';
for (const instrument of ['SYN-UST-2031', 'SYN-CORP-2031'])
  for (const side of ['BUY', 'SELL'])
    for (const date of ['2028-01-15', '2028-02-29'])
      void test(`independent FIX dictionary/byte and rational cash transcript ${instrument} ${side} ${date}`, async () => {
        const s = await applicationFixture('100.00', side, instrument, date),
          cfg = await owner(),
          db = new VerificationDatabase(cfg.reconcilerUrl!);
        try {
          await s.apply((await s.prepare()).work);
          const order = (
            await s.app.query<{ id: string; contract: Record<string, string> }>(
              'SELECT id,contract FROM fi.orders WHERE sandbox_id=$1',
              [s.id],
            )
          ).rows[0]!;
          const px = order.contract['clean_price']!;
          for (const [cum, left, status] of [
            ['50.00', '50.00', '1'],
            ['100.00', '0.00', '2'],
          ]) {
            const p = await s.prepare({
              '150': 'F',
              '39': status!,
              '14': cum!,
              '151': left!,
              '32': '50.00',
              '31': px,
              '6': px,
            });
            assert.equal((await s.apply(p.work)).status, 200);
          }
          const executions = (
            await s.app.query<Record<string, unknown>>(
              'SELECT *,settlement_date::text FROM fi.executions WHERE sandbox_id=$1 ORDER BY fill_sequence',
              [s.id],
            )
          ).rows;
          const position = (
            await s.app.query<Record<string, unknown>>(
              'SELECT * FROM fi.positions WHERE sandbox_id=$1',
              [s.id],
            )
          ).rows[0];
          const lifecycle = (
            await s.app.query<Record<string, unknown>>(
              'SELECT * FROM fi.order_states WHERE sandbox_id=$1',
              [s.id],
            )
          ).rows[0];
          const messages = (
            await s.app.query<Record<string, unknown>>(
              "SELECT m.id,m.execution_id,m.source_event_id,encode(a.raw_bytes,'base64') raw_base64 FROM fi.fix_messages m JOIN fi.fix_attempts a ON(a.sandbox_id,a.message_id)=(m.sandbox_id,m.id) WHERE m.sandbox_id=$1 AND a.attempt_no=1 ORDER BY m.received_at",
              [s.id],
            )
          ).rows.map((m) => ({ ...m, raw_base64: String(m['raw_base64']).replaceAll('\n', '') }));
          const r = spawnSync(
            process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
            ['verification/python/fix_application_reference.py'],
            {
              input: JSON.stringify({ order, executions, position, lifecycle, messages }),
              encoding: 'utf8',
              timeout: 10000,
            },
          );
          assert.equal(r.status, 0, r.stderr);
          const evidence = JSON.parse(r.stdout) as {
            frames: number;
            executions: number;
            per_fill_minus_whole_cents: number;
          };
          assert.equal(evidence.frames, 4);
          assert.equal(evidence.executions, 2);
          if (instrument === 'SYN-UST-2031' && side === 'BUY' && date === '2028-01-15')
            assert.equal(evidence.per_fill_minus_whole_cents, 1);
          const assessment = await verifyFixApplication(
            db,
            { sandboxId: s.id, digest: s.proof, scope: 'trade', generation: '1' },
            () => {},
            true,
          );
          assert.equal(
            assessment.assessment,
            'OBSERVED_APPLICATION_CONSISTENT',
            JSON.stringify(assessment.findings),
          );
          assert.equal(assessment.financial_application_verified, true);
          assert.equal(assessment.delivery_verified, false);
          assert.equal(assessment.external_completeness_verified, false);
        } finally {
          await db.close();
          await s.close();
        }
      });
