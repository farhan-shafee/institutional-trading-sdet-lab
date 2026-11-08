import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { curveAnalytics } from '../../app/domain/fixed-income-v3/analytics.js';
import { decimal80 } from '../../app/domain/fixed-income-v3/numbers.js';

interface OracleQuery {
  instrument_id: string;
  fixture_id: string;
  as_of_date: string;
  par_amount: string;
  z_spread?: string;
  clean_price?: string;
}
interface OracleResult {
  dirty: string;
  clean: string;
  accrued: string;
  spread: string;
  mark_value_usd: string;
  remaining: { payment_date: string; days: number; discount_factor: string }[];
}
function oracle(queries: OracleQuery[]): OracleResult[] {
  const result = JSON.parse(
    execFileSync(
      'python3',
      [fileURLToPath(new URL('../../verification/python/curves.py', import.meta.url))],
      { input: JSON.stringify(queries), encoding: 'utf8', timeout: 10000 },
    ),
  ) as OracleResult[];
  assert.equal(result.length, queries.length);
  return result;
}
function compare(q: OracleQuery, expected: OracleResult): void {
  const actual = curveAnalytics(q);
  for (const [field, reference] of [
    ['dirty_price', expected.dirty],
    ['clean_price', expected.clean],
    ['accrued_interest', expected.accrued],
  ] as const) {
    assert.ok(
      decimal80(actual[field]).sub(reference).abs().lte('5e-10'),
      JSON.stringify({ q, field, actual: actual[field], reference }),
    );
  }
  assert.ok(
    decimal80(actual.z_spread).sub(expected.spread).abs().lte('2e-11'),
    JSON.stringify({ q, actual: actual.z_spread, reference: expected.spread }),
  );
  assert.equal(actual.mark_value_usd, expected.mark_value_usd, JSON.stringify(q));
  assert.equal(actual.remaining_cash_flows.length, expected.remaining.length);
  actual.remaining_cash_flows.forEach((flow, index) => {
    const independent = expected.remaining[index]!;
    assert.equal(flow.payment_date, independent.payment_date);
    assert.equal(flow.days, independent.days);
    assert.ok(decimal80(flow.discount_factor).sub(independent.discount_factor).abs().lte('5e-20'));
  });
}

void test('147 forward curve cases agree with independent 125-digit cash-flow and DF oracle', () => {
  const queries: OracleQuery[] = [];
  for (const fixture_id of ['BASE_UP_V1', 'FLAT_V1', 'NEGATIVE_V1'])
    for (const instrument_id of ['SYN-UST-2031', 'SYN-CORP-2031', 'SYN-ZERO-2031'])
      for (const as_of_date of ['2025-01-15', '2028-02-29', '2030-01-15', '2031-01-14'])
        for (const z_spread of ['-0.10', '0', '0.0875', '1'])
          queries.push({
            fixture_id,
            instrument_id,
            as_of_date,
            z_spread,
            par_amount: '999999999.87',
          });
  for (const par_amount of ['1.25', '1.75'])
    queries.push({
      fixture_id: 'FLAT_V1',
      instrument_id: 'SYN-UST-2031',
      as_of_date: '2030-07-15',
      z_spread: '-0.03',
      par_amount,
    });
  queries.push({
    fixture_id: 'FLAT_V1',
    instrument_id: 'SYN-ZERO-2031',
    as_of_date: '2030-01-15',
    z_spread: '0',
    par_amount: '999999900.31',
  });
  assert.equal(queries.length, 147);
  oracle(queries).forEach((expected, index) => compare(queries[index]!, expected));
});

void test('19 exact quote targets agree with independent safeguarded-Newton spread and mark oracle', () => {
  const queries: OracleQuery[] = [];
  for (const fixture_id of ['BASE_UP_V1', 'FLAT_V1', 'NEGATIVE_V1'])
    for (const instrument_id of ['SYN-UST-2031', 'SYN-CORP-2031', 'SYN-ZERO-2031']) {
      queries.push({
        fixture_id,
        instrument_id,
        as_of_date: '2028-02-29',
        clean_price: '99.875',
        par_amount: '999999999.87',
      });
      queries.push({
        fixture_id,
        instrument_id,
        as_of_date: '2031-01-14',
        clean_price: '100',
        par_amount: '1.03',
      });
    }
  queries.push({
    fixture_id: 'FLAT_V1',
    instrument_id: 'SYN-UST-2031',
    as_of_date: '2030-07-15',
    clean_price: '102',
    par_amount: '1.25',
  });
  assert.equal(queries.length, 19);
  oracle(queries).forEach((expected, index) => compare(queries[index]!, expected));
});
