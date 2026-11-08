import assert from 'node:assert/strict';
import test from 'node:test';
import { Decimal } from 'decimal.js';
import { Rational } from '../../app/domain/fixed-income-v3/numbers.js';
import {
  curveCashFlows,
  type CurveInstrumentId,
} from '../../app/domain/fixed-income-v3/cash-flows.js';

void test('exact rational arithmetic normalizes signs and preserves partial allocations', () => {
  const r = new Rational(60_528n, 1000n);
  assert.equal(r.numerator, 7566n);
  assert.equal(r.denominator, 125n);
  assert.equal(r.div(new Rational(60n)).mul(new Rational(40n)).fixed(3), '40.352');
  assert.equal(Rational.decimal('100.88').sub(Rational.decimal('60.528')).fixed(3), '40.352');
  assert.equal(new Rational(2n, -4n).add(new Rational(1n, 2n)).isZero(), true);
  assert.equal(Object.isFrozen(r), true);
  assert.equal(Reflect.set(r, 'numerator', 0n), false);
  assert.throws(() => new Rational(1n, 0n));
  assert.throws(() => r.div(new Rational(0n)));
});

void test('exact fixed-scale HALF_EVEN handles signed midpoint and near-midpoint values', () => {
  for (const [input, expected] of [
    ['1.275', '1.28'],
    ['1.265', '1.26'],
    ['-1.275', '-1.28'],
    ['-1.265', '-1.26'],
    ['0.005', '0.00'],
    ['-0.005', '0.00'],
    ['1.274999999999999999', '1.27'],
    ['1.275000000000000001', '1.28'],
  ])
    assert.equal(Rational.decimal(input!).fixed(2), expected);
  for (const bad of ['1e3', 'NaN', 'Infinity', ' 1', '1.', '.5', '--1', '0'.repeat(129)])
    assert.throws(() => Rational.decimal(bad));
  for (const bad of [-1, 1.5, 25, NaN]) assert.throws(() => new Rational(1n).fixed(bad));
});

void test('rational decimal conversion retains its isolated 80-digit context', () => {
  const before = { precision: Decimal.precision, rounding: Decimal.rounding };
  try {
    Decimal.set({ precision: 7, rounding: Decimal.ROUND_DOWN });
    const v = new Rational(1n, 3n).toDecimal();
    assert.equal(v.toFixed(70), '0.' + '3'.repeat(70));
    assert.equal(Decimal.precision, 7);
  } finally {
    Decimal.set(before);
  }
});

void test('zero curve cash flow is principal only, immutable and exactly dated', () => {
  const c = curveCashFlows('SYN-ZERO-2031', '2030-01-15');
  assert.equal(c.definition_version, 'SYN-ZERO-2031_V1');
  assert.equal(c.accrued.fixed(10), '0.0000000000');
  assert.equal(c.remaining.length, 1);
  assert.equal(c.remaining[0]!.payment_date, '2031-01-15');
  assert.equal(c.remaining[0]!.days, 365);
  assert.equal(c.remaining[0]!.amount_per_100.fixed(10), '100.0000000000');
  assert.equal(Object.isFrozen(c), true);
  assert.equal(Object.isFrozen(c.remaining), true);
  assert.equal(Object.isFrozen(c.remaining[0]), true);
});

void test('coupon-date valuation excludes same-day payment and preserves maturity principal', () => {
  const c = curveCashFlows('SYN-UST-2031', '2030-01-15');
  assert.equal(c.remaining.length, 2);
  assert.equal(c.remaining[0]!.payment_date, '2030-07-15');
  assert.equal(c.remaining[0]!.amount_per_100.fixed(0), '2');
  assert.equal(c.remaining[1]!.payment_date, '2031-01-15');
  assert.equal(c.remaining[1]!.amount_per_100.fixed(0), '102');
  assert.equal(c.accrued.isZero(), true);
  assert.equal(c.definition_version, '6016fb700840d081fe1fba651c918f0a7e709383/SYN-UST-2031');
  assert.equal(curveCashFlows('SYN-CORP-2031', '2025-01-15').remaining.length, 12);
});

void test('curve accrued interest preserves exact original leap-day convention fractions', () => {
  const u = curveCashFlows('SYN-UST-2031', '2028-02-29');
  const c = curveCashFlows('SYN-CORP-2031', '2028-02-29');
  assert.equal(u.accrued.numerator, 45n);
  assert.equal(u.accrued.denominator, 91n);
  assert.equal(c.accrued.numerator, 22n);
  assert.equal(c.accrued.denominator, 45n);
  assert.equal(u.accrued.fixed(10), '0.4945054945');
  assert.equal(c.accrued.fixed(10), '0.4888888889');
  assert.equal(u.remaining[0]!.payment_date, '2028-07-15');
  assert.equal(u.remaining[0]!.days, 137);
});

void test('near-maturity coupon flow preserves its final one-day amount and accrual', () => {
  for (const id of ['SYN-UST-2031', 'SYN-CORP-2031'] as const) {
    const c = curveCashFlows(id, '2031-01-14');
    assert.equal(c.remaining.length, 1);
    assert.equal(c.remaining[0]!.days, 1);
    assert.equal(c.remaining[0]!.amount_per_100.fixed(0), '102');
    assert.ok(c.accrued.toDecimal().gt(1));
  }
});

void test('curve flow dates and unsupported instrument identity fail closed', () => {
  for (const bad of ['2025-01-14', '2031-01-15', '2027-02-29', '2026-1-15', '2026-01-15T00:00:00Z'])
    assert.throws(() => curveCashFlows('SYN-UST-2031', bad));
  assert.throws(() => curveCashFlows('UNKNOWN' as CurveInstrumentId, '2026-01-15'));
});
