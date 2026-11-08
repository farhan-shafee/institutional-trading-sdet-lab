import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { assessOwned } from '../../app/domain/post-trade/assessment.js';
import { ownedSourceSchema } from '../../app/domain/post-trade/source.js';
import { fundedBook, duePayload } from './settlement-fixture.js';
import { postTradeSandbox, connection, randomUUID } from './fixture.js';

async function source(
  s: { app: pg.Client; id: string; proof: string },
  raw: string | null = null,
  post: string | null = null,
) {
  const result = await s.app.query<{ result: { status: number; body: unknown } }>(
    "SELECT fi_control.read_posttrade($1,$2,'trade',1,$3,$4) result",
    [s.id, s.proof, raw, post],
  );
  assert.equal(result.rows[0]!.result.status, 200);
  return ownedSourceSchema.parse(result.rows[0]!.result.body);
}
await test('uninitialized and incomplete inventory are unavailable while initialized verified empty is real zero', async () => {
  const s = await postTradeSandbox();
  try {
    const disabled = assessOwned(await source(s), 'FLAT_V1', '2030-01-15');
    assert.equal(disabled.status, 'UNAVAILABLE');
    assert.ok(!('risk' in disabled));
    assert.ok(!('pnl' in disabled));
    assert.equal(
      (await s.command('INITIALIZE', { economic_start_date: '2030-01-15' })).status,
      201,
    );
    const empty = assessOwned(await source(s), 'FLAT_V1', '2030-01-15');
    assert.equal(empty.status, 'AVAILABLE');
    if (empty.status !== 'AVAILABLE') throw new Error('Expected admitted empty book.');
    assert.equal(empty.risk.total.pv_usd, '0.00');
    assert.equal(empty.pnl.equity_usd, '100000000.00');
    assert.equal(empty.pnl.realized_pnl_usd, '0.00');
    assert.equal(empty.pnl.unrealized_pnl_usd, '0.00');
    assert.equal(empty.pnl.total_pnl_usd, '0.00');
    assert.equal(empty.pnl.signed_unsettled_cash_usd, '0.00');
  } finally {
    await s.close();
  }
});
await test('source-bound FIFO/equity preserves exact partial basis and discloses aggregate presentation rounding', async () => {
  const s = await fundedBook(),
    admin = await connection('admin');
  try {
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          execution_id: s.raw.id,
          expected_revision: 0,
          clean_price: '100.880000000000',
        })
      ).status,
      201,
    );
    const sell = await s.additional('40.00', 'SELL');
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          execution_id: sell.id,
          expected_revision: 0,
          clean_price: '109.500000000000',
        })
      ).status,
      201,
    );
    const snapshot = await source(s),
      before = (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.posttrade_commands WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n;
    const a = assessOwned(snapshot, 'FLAT_V1', '2030-01-15');
    assert.equal(a.status, 'AVAILABLE');
    if (a.status !== 'AVAILABLE') throw new Error('Expected complete corrected economics.');
    assert.equal(a.pnl.realized_pnl_usd, '3.45');
    assert.equal(a.pnl.unrealized_pnl_usd, '0.05');
    assert.equal(a.pnl.total_pnl_usd, '3.49');
    assert.equal(a.pnl.equity_usd, '100000003.49');
    assert.equal(a.pnl.presentation_rounding_delta_usd, '-0.01');
    assert.deepEqual(a.pnl.lots[0]!.remaining_basis_or_proceeds_exact_usd, {
      numerator: '7566',
      denominator: '125',
    });
    assert.equal(
      a.risk.instruments.find((row) => row.instrument_id === 'SYN-UST-2031')!.signed_par,
      '60.00',
    );
    assert.equal(a.source.sandbox_id, s.id);
    assert.equal(a.source.generation, '1');
    assert.equal(a.curve.snapshot_id.length, 64);
    assert.equal(a.source.source_id.length, 64);
    assert.equal(a.assessment_id.length, 64);
    assert.deepEqual(assessOwned(await source(s), 'FLAT_V1', '2030-01-15'), a);
    assert.equal(
      (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.posttrade_commands WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      before,
    );
  } finally {
    await admin.end();
    await s.close();
  }
});
await test('settlement, failure, reversal and cash correction never double-realize economic P&L', async () => {
  const s = await fundedBook();
  try {
    const snapshot = await source(s),
      original = assessOwned(snapshot, 'BASE_UP_V1', '2030-01-15');
    assert.equal(original.status, 'AVAILABLE');
    if (original.status !== 'AVAILABLE') throw new Error('Expected complete source.');
    assert.equal((await s.post('SETTLE', duePayload(s.raw.id))).status, 200);
    const settled = assessOwned(await source(s), 'BASE_UP_V1', '2030-01-15');
    assert.equal(settled.status, 'AVAILABLE');
    if (settled.status !== 'AVAILABLE') throw new Error('Expected settled source.');
    assert.equal(settled.pnl.total_pnl_usd, original.pnl.total_pnl_usd);
    assert.equal(settled.pnl.realized_pnl_usd, original.pnl.realized_pnl_usd);
    assert.equal(settled.pnl.signed_unsettled_cash_usd, '0.00');
    assert.equal((await s.post('REVERSE', duePayload(s.raw.id))).status, 200);
    const reversed = assessOwned(await source(s), 'BASE_UP_V1', '2030-01-15');
    assert.equal(reversed.status, 'AVAILABLE');
    if (reversed.status !== 'AVAILABLE') throw new Error('Expected reversed source.');
    assert.equal(reversed.pnl.total_pnl_usd, original.pnl.total_pnl_usd);
    assert.equal(reversed.pnl.signed_unsettled_cash_usd, original.pnl.signed_unsettled_cash_usd);
    assert.notEqual(reversed.assessment_id, original.assessment_id);
    assert.deepEqual(
      assessOwned(
        await source(s, null, snapshot.posttrade_command_seq),
        'BASE_UP_V1',
        '2030-01-15',
      ),
      original,
    );
  } finally {
    await s.close();
  }
});
await test('offset and closed-flat books keep realized cash but cannot escape the original economic window', async () => {
  const s = await fundedBook();
  try {
    const sell = await s.additional('100.00', 'SELL');
    const result = assessOwned(await source(s), 'NEGATIVE_V1', '2030-01-15');
    assert.equal(result.status, 'AVAILABLE');
    if (result.status !== 'AVAILABLE') throw new Error('Expected offset inventory.');
    assert.equal(result.risk.total.pv_usd, '0.00');
    assert.equal(result.risk.total.parallel_dv01_usd, '0.00000000');
    assert.notEqual(result.pnl.realized_pnl_usd, undefined);
    const afterCoupon = assessOwned(await source(s), 'NEGATIVE_V1', '2030-07-15');
    assert.equal(afterCoupon.status, 'UNAVAILABLE');
    assert.ok(!('pnl' in afterCoupon));
    assert.equal(
      (await s.post('BUST', { execution_id: s.raw.id, expected_revision: 0 })).status,
      201,
    );
    assert.equal(
      (await s.post('BUST', { execution_id: sell.id, expected_revision: 0 })).status,
      201,
    );
    assert.equal(assessOwned(await source(s), 'NEGATIVE_V1', '2030-07-15').status, 'UNAVAILABLE');
  } finally {
    await s.close();
  }
});
await test('mark before original value date is unavailable and economic source cutoff cannot omit registered roots', async () => {
  const s = await fundedBook({ dueDate: '2030-01-17', windowStart: '2030-01-15' });
  try {
    const early = assessOwned(await source(s), 'FLAT_V1', '2030-01-16');
    assert.equal(early.status, 'UNAVAILABLE');
    assert.ok(
      early.status === 'UNAVAILABLE' && early.reasons.includes('VALUATION_BEFORE_VALUE_DATE'),
    );
    const incoherent = assessOwned(await source(s, '0', '2'), 'FLAT_V1', '2030-01-17');
    assert.equal(incoherent.status, 'UNAVAILABLE');
    assert.ok(!('risk' in incoherent));
  } finally {
    await s.close();
  }
});
await test('source accounting mismatch and unsupported definitions never yield financial zero', async () => {
  const s = await fundedBook();
  try {
    const current = await source(s);
    const badCash = ownedSourceSchema.parse({ ...current, available_cash_cents: '9999999999' });
    const mismatch = assessOwned(badCash, 'FLAT_V1', '2030-01-15');
    assert.equal(mismatch.status, 'UNAVAILABLE');
    assert.ok(
      mismatch.status === 'UNAVAILABLE' && mismatch.reasons.includes('SOURCE_ACCOUNTING_MISMATCH'),
    );
    const unknown = ownedSourceSchema.parse({
      ...current,
      roots: current.roots.map((root) => ({
        ...root,
        instrument_id: 'UNSUPPORTED',
        definition_version: 'UNSUPPORTED_V1',
      })),
    });
    const missingMark = assessOwned(unknown, 'FLAT_V1', '2030-01-15');
    assert.equal(missingMark.status, 'UNAVAILABLE');
    assert.ok(!('risk' in missingMark));
    assert.ok(!('pnl' in missingMark));
  } finally {
    await s.close();
  }
});

await test('a ninth real raw execution makes assessment unavailable rather than a verified empty portfolio', async () => {
  const s = await fundedBook({ parentPar: '8.00', fillPar: '1.00' });
  try {
    for (let i = 1; i < 8; i++) {
      const fill = await s.fill(String(i + 2), '1.00');
      assert.equal(fill.status, 201);
      assert.equal(
        (await s.post('REGISTER', { execution_id: fill.body.execution!.id })).status,
        201,
      );
    }
    const complete = assessOwned(await source(s), 'FLAT_V1', '2030-01-15');
    assert.equal(complete.status, 'AVAILABLE');
    const id = await s.createOrder('1.00');
    assert.equal(
      (await s.command('ACK_ORDER', { order_id: id, expected_version: '1' })).status,
      200,
    );
    const fill = await s.command('EXECUTE_ORDER', {
      order_id: id,
      expected_version: '2',
      execution_id: randomUUID(),
      source_event_id: randomUUID(),
      par_amount: '1.00',
    });
    assert.equal(fill.status, 201);
    const missing = assessOwned(await source(s), 'FLAT_V1', '2030-01-15');
    assert.equal(missing.status, 'UNAVAILABLE');
    assert.ok(missing.status === 'UNAVAILABLE' && missing.reasons.includes('ROOT_LIMIT_EXCEEDED'));
    assert.ok(!('risk' in missing));
    assert.ok(!('pnl' in missing));
  } finally {
    await s.close();
  }
});
await test('correction restates original FIFO ordering and a full bust removes its entire original root', async () => {
  const s = await fundedBook({ parentPar: '40.00' });
  try {
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          execution_id: s.raw.id,
          expected_revision: 0,
          clean_price: '100.000000000000',
        })
      ).status,
      201,
    );
    const second = await s.additional('60.00');
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          execution_id: second.id,
          expected_revision: 0,
          clean_price: '110.000000000000',
        })
      ).status,
      201,
    );
    const sell = await s.additional('50.00', 'SELL');
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          execution_id: sell.id,
          expected_revision: 0,
          clean_price: '112.000000000000',
        })
      ).status,
      201,
    );
    const oldSource = await source(s),
      old = assessOwned(oldSource, 'FLAT_V1', '2030-01-15');
    assert.equal(old.status, 'AVAILABLE');
    if (old.status !== 'AVAILABLE') throw new Error('Expected ordered inventory.');
    assert.equal(old.pnl.realized_pnl_usd, '5.00');
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          execution_id: s.raw.id,
          expected_revision: 1,
          clean_price: '105.000000000000',
        })
      ).status,
      201,
    );
    const corrected = assessOwned(await source(s), 'FLAT_V1', '2030-01-15');
    assert.equal(corrected.status, 'AVAILABLE');
    if (corrected.status !== 'AVAILABLE') throw new Error('Expected corrected inventory.');
    assert.equal(corrected.pnl.realized_pnl_usd, '3.00');
    assert.equal(corrected.pnl.lots[0]!.remaining_par, '50.00');
    assert.deepEqual(
      assessOwned(await source(s, null, oldSource.posttrade_command_seq), 'FLAT_V1', '2030-01-15'),
      old,
    );
    assert.equal(
      (await s.post('BUST', { execution_id: s.raw.id, expected_revision: 2 })).status,
      201,
    );
    const busted = assessOwned(await source(s), 'FLAT_V1', '2030-01-15');
    assert.equal(busted.status, 'AVAILABLE');
    if (busted.status !== 'AVAILABLE') throw new Error('Expected whole-root bust.');
    assert.equal(busted.pnl.realized_pnl_usd, '1.00');
    assert.equal(busted.pnl.lots[0]!.remaining_par, '10.00');
  } finally {
    await s.close();
  }
});
await test('an admitted failed settlement changes source identity while preserving every financial metric', async () => {
  const s = await fundedBook({ side: 'SELL' });
  try {
    const before = assessOwned(await source(s), 'FLAT_V1', '2030-01-15');
    assert.equal(before.status, 'AVAILABLE');
    assert.equal((await s.post('SETTLE', duePayload(s.raw.id))).status, 409);
    const after = assessOwned(await source(s), 'FLAT_V1', '2030-01-15');
    assert.equal(after.status, 'AVAILABLE');
    if (before.status !== 'AVAILABLE' || after.status !== 'AVAILABLE')
      throw new Error('Expected complete source.');
    assert.deepEqual(after.risk, before.risk);
    assert.deepEqual(after.pnl, before.pnl);
    assert.notEqual(after.assessment_id, before.assessment_id);
  } finally {
    await s.close();
  }
});
