import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applicationFixture } from './fix-application-fixture.js';
import { report } from './fix-fixture.js';
import { owner } from './harness.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { FixApplicationService } from '../../app/server/fix/application.js';
import { encodeFix44 } from '../../app/protocol/fix44/index.js';
void test('strict controlled ingest retains mismatched frozen terms/identities as hash-only findings without financial changes', async () => {
  const s = await applicationFixture(),
    cfg = await owner(),
    db = new WorkflowDatabase(cfg.appUrl!),
    service = new FixApplicationService(db, true);
  try {
    await s.apply((await s.prepare()).work);
    const base = await report(s),
      binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' };
    const invalid: Record<string, string>[] = [
      { '54': '2' },
      { '55': 'SYN-CORP-2031', '167': 'CORP' },
      { '44': '99.000000000000' },
      { '38': '200.00', '151': '200.00' },
      { '64': '20280301' },
      { '11': randomUUID() },
      { '49': 'BIRCH', '37': 'BIRCH-OTHER', '17': 'BIRCH-OTHER' },
      { '37': 'ATLAS-UNRECOGNIZED' },
    ];
    for (const [i, change] of invalid.entries()) {
      const input = {
          order_id: s.order,
          attempt_id: randomUUID(),
          raw_hex: encodeFix44({ ...base, '34': String(i + 100), ...change }).toString('hex'),
        },
        key = randomUUID();
      const r = await service.ingest(binding, s.actor, input, key, () => {});
      assert.equal(r.status, 200);
      assert.equal((r.body as { accepted: boolean }).accepted, false);
      assert.equal((await service.ingest(binding, s.actor, input, key, () => {})).replayed, true);
    }
    assert.equal(
      (await s.app.query('SELECT * FROM fi.fix_unresolved_ingest WHERE sandbox_id=$1', [s.id]))
        .rowCount,
      8,
    );
    assert.equal(
      (await s.app.query('SELECT * FROM fi.fix_consumptions WHERE sandbox_id=$1', [s.id])).rowCount,
      1,
    );
    assert.equal(
      (await s.app.query('SELECT * FROM fi.executions WHERE sandbox_id=$1', [s.id])).rowCount,
      0,
    );
    assert.equal(
      (
        await service.ingest(
          binding,
          s.actor,
          { order_id: s.order, attempt_id: randomUUID(), raw_hex: '61' },
          randomUUID(),
          () => {},
        )
      ).status,
      429,
    );
  } finally {
    await db.close();
    await s.close();
  }
});
void test('unknown-order cancel reject remains unresolved and preserves actual partial fills and pending local cancellation', async () => {
  const s = await applicationFixture(),
    cfg = await owner(),
    db = new WorkflowDatabase(cfg.appUrl!),
    service = new FixApplicationService(db, true);
  try {
    await s.apply((await s.prepare()).work);
    const px = (
      await s.app.query<{ contract: Record<string, string> }>(
        'SELECT contract FROM fi.orders WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.contract['clean_price']!;
    const cancel = randomUUID(),
      base = { '11': cancel, '41': s.order };
    await s.apply((await s.prepare({ '35': 'F', '49': 'TRADEFLOW', '56': 'ATLAS', ...base })).work);
    await s.apply(
      (
        await s.prepare({
          '150': 'F',
          '39': '1',
          '14': '40.00',
          '151': '60.00',
          '32': '40.00',
          '31': px,
          '6': px,
        })
      ).work,
    );
    // Independently reframe the unsupported102=1 fixture; the approved codec must reject it.
    const original = await report(s, {
      '35': '9',
      ...base,
      '39': '1',
      '434': '1',
      '102': '99',
      '34': '100',
    });
    const f: Record<string, string> = { ...original };
    for (const t of [
      '17',
      '150',
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
      '14',
      '151',
      '6',
    ])
      delete f[t];
    const fields = encodeFix44(f).toString('ascii').split('\x01');
    const body =
      fields
        .slice(2, -2)
        .map((v) => (v === '102=99' ? '102=1' : v))
        .join('\x01') + '\x01';
    const prefix = Buffer.from(
        '8=FIX.4.4\x019=' + Buffer.byteLength(body) + '\x01' + body,
        'ascii',
      ),
      sum = prefix.reduce((a, b) => a + b, 0) % 256;
    const wire = Buffer.concat([
      prefix,
      Buffer.from('10=' + String(sum).padStart(3, '0') + '\x01', 'ascii'),
    ]);
    const r = await service.ingest(
      { sandboxId: s.id, digest: s.proof, scope: 'trade', generation: '1' },
      s.actor,
      { order_id: s.order, attempt_id: randomUUID(), raw_hex: wire.toString('hex') },
      randomUUID(),
      () => {},
    );
    assert.equal(r.status, 200);
    assert.equal((r.body as { accepted: boolean }).accepted, false);
    assert.deepEqual(
      (
        await s.app.query(
          'SELECT status,filled_par,pending_cancel_id FROM fi.order_states WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows,
      [{ status: 'PARTIALLY_FILLED', filled_par: '40.00', pending_cancel_id: cancel }],
    );
    assert.equal(
      (await s.app.query('SELECT * FROM fi.cancellation_outcomes WHERE sandbox_id=$1', [s.id]))
        .rowCount,
      0,
    );
  } finally {
    await db.close();
    await s.close();
  }
});
