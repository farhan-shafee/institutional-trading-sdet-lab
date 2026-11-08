import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { curveSnapshot, type CurveFixtureId } from '../../app/domain/fixed-income-v3/curves.js';
import type { CurveInstrumentId } from '../../app/domain/fixed-income-v3/cash-flows.js';
import { Rational, decimal80 } from '../../app/domain/fixed-income-v3/numbers.js';
import {
  instrumentDollarRisk,
  dollarRiskWire,
  type StressId,
} from '../../app/domain/post-trade/risk.js';

interface Query {
  fixture_id: CurveFixtureId;
  instrument_id: CurveInstrumentId;
  as_of_date: string;
  signed_par: string;
}
interface Expected {
  pv: string;
  parallel_dv01: string;
  key_rate_dv01: string[];
  stress_pnl: Record<StressId, string>;
  pv_usd: string;
}
void test('72 signed risk cases agree with independent 125-digit parallel key-rate and stress repricing', () => {
  const queries: Query[] = [];
  for (const fixture_id of ['BASE_UP_V1', 'FLAT_V1', 'NEGATIVE_V1'] as const)
    for (const instrument_id of ['SYN-UST-2031', 'SYN-CORP-2031', 'SYN-ZERO-2031'] as const)
      for (const as_of_date of ['2025-01-15', '2028-02-29', '2030-01-15', '2031-01-14'])
        for (const signed_par of ['1000000', '-999999999.87'])
          queries.push({ fixture_id, instrument_id, as_of_date, signed_par });
  assert.equal(queries.length, 72);
  const expected = JSON.parse(
    execFileSync(
      'python3',
      [fileURLToPath(new URL('../../verification/python/risk.py', import.meta.url))],
      { input: JSON.stringify(queries), encoding: 'utf8', timeout: 10000 },
    ),
  ) as Expected[];
  assert.equal(expected.length, 72);
  queries.forEach((q, i) => {
    const actual = instrumentDollarRisk(
      curveSnapshot(q.fixture_id, q.as_of_date),
      q.instrument_id,
      Rational.decimal(q.signed_par),
    );
    const e = expected[i]!;
    const pairs = [
      [actual.pv, e.pv],
      [actual.parallel_dv01, e.parallel_dv01],
      ...actual.key_rate_dv01.map((v, k) => [v, e.key_rate_dv01[k]!] as const),
      ...(['PARALLEL_UP_100', 'PARALLEL_DOWN_100', 'STEEPENER_V1'] as const).map(
        (key) => [actual.stress_pnl[key], e.stress_pnl[key]] as const,
      ),
    ] as const;
    for (const [value, reference] of pairs) {
      let tolerance = decimal80(reference).abs().mul('1e-8');
      if (tolerance.lt('0.000001')) tolerance = decimal80('0.000001');
      assert.ok(
        value.sub(reference).abs().lte(tolerance),
        JSON.stringify({ q, actual: value.toString(), reference }),
      );
    }
    assert.equal(dollarRiskWire(actual).pv_usd, e.pv_usd);
  });
});
