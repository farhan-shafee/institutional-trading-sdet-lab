import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { Decimal } from 'decimal.js';
import { assessOwned, type Assessment } from '../../app/domain/post-trade/assessment.js';
import {
  ownedSourceSchema,
  type OwnedPostTradeSnapshot,
} from '../../app/domain/post-trade/source.js';
import { curveFixtureIds, type CurveFixtureId } from '../../app/domain/fixed-income-v3/curves.js';
import { fundedBook, duePayload } from './settlement-fixture.js';

type Frame = { source: OwnedPostTradeSnapshot; fixture_id: CurveFixtureId; as_of_date: string };
type Risk = { pv: string; parallel: string; keys: string[]; stresses: Record<string, string> };
type Oracle = {
  source_id: string;
  curve_snapshot_id: string;
  assessment_id: string;
  pnl: unknown;
  risk: { total: Risk; instruments: (Risk & { instrument_id: string })[] };
};
const D = Decimal.clone({ precision: 150 });
function close(actual: string, expected: string) {
  const difference = new D(actual).sub(expected).abs(),
    tolerance = D.max('0.000001', new D(expected).abs().mul('0.00000001'));
  assert.ok(difference.lte(tolerance), actual + ' vs ' + expected);
}
function compareRisk(
  actual: {
    pv_usd: string;
    parallel_dv01_usd: string;
    key_rate_dv01_usd: readonly string[];
    stress_pnl_usd: Readonly<Record<string, string>>;
  },
  expected: Risk,
) {
  assert.equal(
    actual.pv_usd,
    new D(expected.pv).isZero() ? '0.00' : new D(expected.pv).toFixed(2, Decimal.ROUND_HALF_EVEN),
  );
  close(actual.parallel_dv01_usd, expected.parallel);
  actual.key_rate_dv01_usd.forEach((value, i) => close(value, expected.keys[i]!));
  for (const [name, value] of Object.entries(actual.stress_pnl_usd))
    close(value, expected.stresses[name]!);
}
await test('48 independent125-digit/Fraction owned assessments agree across actual restatements, settlement and short cover', async () => {
  const frames: Frame[] = [],
    results: Assessment[] = [];
  const capture = (source: OwnedPostTradeSnapshot) => {
    assert.ok(source.window);
    const last = new Date(source.window.end + 'T00:00:00.000Z');
    last.setUTCDate(last.getUTCDate() - 1);
    for (const fixture_id of curveFixtureIds)
      for (const as_of_date of [source.window.start, last.toISOString().slice(0, 10)]) {
        frames.push({ source, fixture_id, as_of_date });
        results.push(assessOwned(source, fixture_id, as_of_date));
      }
  };
  const first = await fundedBook();
  try {
    assert.equal(
      (
        await first.post('CORRECT_PRICE', {
          execution_id: first.raw.id,
          expected_revision: 0,
          clean_price: '100.880000000000',
        })
      ).status,
      201,
    );
    const sell = await first.additional('40.00', 'SELL');
    assert.equal(
      (
        await first.post('CORRECT_PRICE', {
          execution_id: sell.id,
          expected_revision: 0,
          clean_price: '109.500000000000',
        })
      ).status,
      201,
    );
    capture(ownedSourceSchema.parse(await first.read()));
    assert.equal((await first.post('SETTLE', duePayload(first.raw.id, 1))).status, 200);
    assert.equal((await first.post('SETTLE', duePayload(sell.id, 1))).status, 200);
    capture(ownedSourceSchema.parse(await first.read()));
    assert.equal((await first.post('REVERSE', duePayload(sell.id, 1))).status, 200);
    assert.equal((await first.post('REVERSE', duePayload(first.raw.id, 1))).status, 200);
    capture(ownedSourceSchema.parse(await first.read()));
    assert.equal(
      (
        await first.post('CORRECT_PRICE', {
          execution_id: first.raw.id,
          expected_revision: 1,
          clean_price: '101.000000000000',
        })
      ).status,
      201,
    );
    capture(ownedSourceSchema.parse(await first.read()));
    assert.equal(
      (await first.post('BUST', { execution_id: sell.id, expected_revision: 1 })).status,
      201,
    );
    capture(ownedSourceSchema.parse(await first.read()));
  } finally {
    await first.close();
  }
  const short = await fundedBook({ side: 'SELL' });
  try {
    assert.equal(
      (
        await short.post('CORRECT_PRICE', {
          execution_id: short.raw.id,
          expected_revision: 0,
          clean_price: '110.000000000000',
        })
      ).status,
      201,
    );
    const cover = await short.additional('40.00');
    assert.equal(
      (
        await short.post('CORRECT_PRICE', {
          execution_id: cover.id,
          expected_revision: 0,
          clean_price: '100.000000000000',
        })
      ).status,
      201,
    );
    assert.equal((await short.post('SETTLE', duePayload(short.raw.id, 1))).status, 409);
    capture(ownedSourceSchema.parse(await short.read()));
    assert.equal((await short.post('SETTLE', duePayload(cover.id, 1))).status, 200);
    const cover2 = await short.additional('60.00');
    assert.equal(
      (
        await short.post('CORRECT_PRICE', {
          execution_id: cover2.id,
          expected_revision: 0,
          clean_price: '100.000000000000',
        })
      ).status,
      201,
    );
    assert.equal((await short.post('SETTLE', duePayload(cover2.id, 1))).status, 200);
    assert.equal((await short.post('SETTLE', duePayload(short.raw.id, 1))).status, 200);
    capture(ownedSourceSchema.parse(await short.read()));
  } finally {
    await short.close();
  }
  const corp = await fundedBook({
    parentPar: '1.25',
    instrument: 'SYN-CORP-2031',
    dueDate: '2028-02-29',
  });
  try {
    await corp.additional('1.00', 'SELL');
    capture(ownedSourceSchema.parse(await corp.read()));
  } finally {
    await corp.close();
  }
  assert.equal(frames.length, 48);
  assert.ok(results.every((result) => result.status === 'AVAILABLE'));
  const oracleRun = spawnSync('python3', ['verification/python/posttrade_assessment.py'], {
    input: JSON.stringify(frames),
    encoding: 'utf8',
    maxBuffer: 1048576,
    timeout: 10000,
  });
  assert.equal(oracleRun.status, 0, oracleRun.stderr);
  const expected = JSON.parse(oracleRun.stdout) as Oracle[];
  assert.equal(expected.length, 48);
  for (let i = 0; i < 48; i++) {
    const actual: Assessment = results[i]!;
    const oracle: Oracle = expected[i]!;
    if (actual.status !== 'AVAILABLE') throw new Error('Independent case unavailable.');
    assert.equal(actual.source.source_id, oracle.source_id);
    assert.equal(actual.curve.snapshot_id, oracle.curve_snapshot_id);
    assert.equal(actual.assessment_id, oracle.assessment_id);
    assert.deepEqual(actual.pnl, oracle.pnl);
    compareRisk(actual.risk.total, oracle.risk.total);
    for (const instrument of actual.risk.instruments) {
      const independent = oracle.risk.instruments.find(
        (row) => row.instrument_id === instrument.instrument_id,
      );
      assert.ok(independent);
      compareRisk(instrument, independent);
    }
  }
});
