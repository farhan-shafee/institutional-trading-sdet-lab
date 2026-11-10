import assert from 'node:assert/strict';
import test from 'node:test';
import { Decimal } from 'decimal.js';
import {
  curveAnalytics,
  curveMeasure,
  solveSpread,
  roundCurveMark,
  NumericalAmbiguityError,
} from '../../app/domain/fixed-income-v3/analytics.js';
import { curveAnalyticsSchema } from '../../app/domain/fixed-income-v3/contracts.js';
import { curveCashFlows } from '../../app/domain/fixed-income-v3/cash-flows.js';
import { curveSnapshot } from '../../app/domain/fixed-income-v3/curves.js';
import { Rational, decimal80 } from '../../app/domain/fixed-income-v3/numbers.js';

const query = {
  instrument_id: 'SYN-ZERO-2031',
  fixture_id: 'FLAT_V1',
  as_of_date: '2030-01-15',
  par_amount: '1000000',
  z_spread: '0',
};

void test('curve zero PV has literal continuous discount value and mark with no settlement cash', () => {
  const a = curveAnalytics(query);
  assert.equal(a.model_version, 'DISCOUNT_LOG_LINEAR_ACT365F_V1');
  assert.equal(a.clean_price, '97.0445533549');
  assert.equal(a.dirty_price, '97.0445533549');
  assert.equal(a.accrued_interest, '0.0000000000');
  assert.equal(a.mark_value_usd, '970445.53');
  assert.equal(a.z_spread, '0.000000000000');
  assert.equal(a.definition_version, 'SYN-ZERO-2031_V1');
  assert.equal(a.curve.as_of_date, a.as_of_date);
  assert.equal(a.remaining_cash_flows.length, 1);
  assert.equal(a.remaining_cash_flows[0]!.amount_per_100, '100.0000000000');
  assert.equal(a.remaining_cash_flows[0]!.discount_factor, '0.97044553354850817693');
  assert.equal(Object.hasOwn(a, 'consideration_usd'), false);
  assert.equal(curveAnalyticsSchema.safeParse(a).success, true);
});

void test('coupon curve PV uses contractual flows and unrounded original accrual', () => {
  const a = curveAnalytics({ ...query, instrument_id: 'SYN-UST-2031' });
  assert.equal(a.dirty_price, '100.9559112204');
  assert.equal(a.mark_value_usd, '1009559.11');
  const u = curveMeasure(curveSnapshot('FLAT_V1', '2028-02-29'), 'SYN-UST-2031', new Rational(0n));
  const c = curveMeasure(curveSnapshot('FLAT_V1', '2028-02-29'), 'SYN-CORP-2031', new Rational(0n));
  assert.ok(u.dirty.eq(c.dirty));
  assert.equal(u.accrued.numerator, 45n);
  assert.equal(u.accrued.denominator, 91n);
  assert.equal(c.accrued.numerator, 22n);
  assert.equal(c.accrued.denominator, 45n);
  assert.ok(u.clean.eq(u.dirty.sub(u.accrued.toDecimal())));
  assert.ok(c.clean.eq(c.dirty.sub(c.accrued.toDecimal())));
});

void test('large-par curve marks never multiply the rounded display price', () => {
  const a = curveAnalytics({ ...query, par_amount: '999999900.31' });
  assert.equal(a.mark_value_usd, '970445436.80');
  const wrong = decimal80(a.dirty_price).mul('999999900.31').div(100).toFixed(2);
  assert.equal(wrong, '970445436.81');
  assert.notEqual(a.mark_value_usd, wrong);
});

void test('exact cancelling rates admit analytically proven HALF_EVEN marks', () => {
  for (const [par, expected] of [
    ['1.25', '1.28'],
    ['1.75', '1.78'],
  ]) {
    const a = curveAnalytics({
      ...query,
      instrument_id: 'SYN-UST-2031',
      as_of_date: '2030-07-15',
      z_spread: '-0.03',
      par_amount: par,
    });
    assert.equal(a.dirty_price, '102.0000000000');
    assert.equal(a.mark_value_usd, expected);
  }
});

void test('ambiguous numerical half-cent marks fail rather than guess', () => {
  const allowance = decimal80('1e-50');
  assert.throws(() => roundCurveMark(decimal80('1.275'), allowance), NumericalAmbiguityError);
  assert.equal(roundCurveMark(decimal80('1.275'), allowance, Rational.decimal('1.275')), '1.28');
  assert.equal(roundCurveMark(decimal80('1.2749'), allowance), '1.27');
  assert.equal(roundCurveMark(decimal80('-0.0001'), allowance), '0.00');
  assert.throws(() => roundCurveMark(decimal80('1.275'), allowance, Rational.decimal('1.26')));
});

void test('continuous z-spread inverse uses exact quoted target and strict residual convergence', () => {
  const snapshot = curveSnapshot('BASE_UP_V1', '2028-02-29');
  const flows = curveCashFlows('SYN-UST-2031', '2028-02-29');
  const clean = Rational.decimal('99.875');
  const target = clean.add(flows.accrued);
  const spread = solveSpread(snapshot, flows, target);
  const measure = curveMeasure(snapshot, flows.instrument_id, Rational.decimal(spread.toFixed(80)));
  assert.ok(measure.dirty.sub(target.toDecimal()).abs().lt('1e-24'));
  const q = {
    ...query,
    fixture_id: 'BASE_UP_V1',
    instrument_id: 'SYN-UST-2031',
    as_of_date: '2028-02-29',
    par_amount: '999999999.87',
    z_spread: undefined,
    clean_price: '99.875',
  };
  const a = curveAnalytics(q);
  assert.equal(a.clean_price, '99.8750000000');
  assert.equal(
    a.mark_value_usd,
    target.mul(Rational.decimal(q.par_amount)).div(new Rational(100n)).fixed(2),
  );
  assert.ok(decimal80(a.z_spread).sub(spread).abs().lte('0.0000000000005'));
});

void test('near-maturity endpoint round trips preserve bracket and reject beyond half-quantum', () => {
  for (const id of ['SYN-UST-2031', 'SYN-CORP-2031', 'SYN-ZERO-2031']) {
    for (const spread of ['-0.10', '1']) {
      const base = { ...query, instrument_id: id, as_of_date: '2031-01-14', z_spread: spread };
      const forward = curveAnalytics(base);
      const inverse = curveAnalytics({
        ...base,
        z_spread: undefined,
        clean_price: forward.clean_price,
      });
      assert.equal(inverse.clean_price, forward.clean_price);
      assert.ok(decimal80(inverse.z_spread).gte('-0.10') && decimal80(inverse.z_spread).lte(1));
      assert.ok(decimal80(inverse.z_spread).sub(spread).abs().lt('1e-8'));
      const outside = decimal80(forward.clean_price)
        .add(spread === '-0.10' ? '0.0000000002' : '-0.0000000002')
        .toFixed(12);
      assert.throws(() => curveAnalytics({ ...base, z_spread: undefined, clean_price: outside }));
    }
  }
});

void test('price and spread inverse preserve all three fixture identities', () => {
  for (const fixture_id of ['BASE_UP_V1', 'FLAT_V1', 'NEGATIVE_V1']) {
    for (const z_spread of ['-0.05', '0', '0.0875', '0.75']) {
      const a = curveAnalytics({ ...query, fixture_id, z_spread });
      const back = curveAnalytics({
        ...query,
        fixture_id,
        z_spread: undefined,
        clean_price: a.clean_price,
      });
      assert.equal(back.curve.snapshot_id, a.curve.snapshot_id);
      assert.ok(decimal80(back.z_spread).sub(z_spread).abs().lt('2e-11'));
    }
  }
});

void test('curve analytics input domains and exact quote-mode exclusivity fail closed', () => {
  for (const fault of [
    { z_spread: undefined },
    { clean_price: '100' },
    { extra: 'x' },
    { instrument_id: 'OTHER' },
    { fixture_id: '__proto__' },
    { as_of_date: '2031-01-15' },
    { par_amount: '0.99' },
    { par_amount: '1000000000.01' },
    { par_amount: '1.001' },
    { z_spread: '1e-2' },
    { z_spread: '1.000000000001' },
    { z_spread: '-0.100000000001' },
    { z_spread: undefined, clean_price: '0' },
    { z_spread: undefined, clean_price: '10001' },
    { z_spread: undefined, clean_price: '0.000000000001' },
    { z_spread: 0 },
    { par_amount: 1000000 },
  ])
    assert.throws(() => curveAnalytics({ ...query, ...fault }));
});

void test('wire contracts reject malformed numbers missing identity and unknown fields', () => {
  const a = curveAnalytics(query);
  for (const fault of [
    { model_version: 'UNKNOWN' },
    { mark_value_usd: 970445.53 },
    { curve: {} },
    { definition_version: '' },
    { definition_version: 'UNKNOWN' },
    { instrument_id: 'SYN-CORP-2031' },
    { as_of_date: '2030-01-16' },
    { z_spread: 'NaN' },
    { dirty_price: '97.04' },
    { conventions: {} },
    { remaining_cash_flows: [] },
    { unknown: true },
  ])
    assert.equal(curveAnalyticsSchema.safeParse({ ...a, ...fault }).success, false);
});

void test('curve arithmetic leaves global Decimal settings untouched', () => {
  const original = { precision: Decimal.precision, rounding: Decimal.rounding };
  try {
    Decimal.set({ precision: 6, rounding: Decimal.ROUND_DOWN });
    assert.equal(curveAnalytics(query).mark_value_usd, '970445.53');
    assert.equal(
      curveAnalytics({ ...query, z_spread: undefined, clean_price: '97.0445533549' }).z_spread,
      '-0.000000000001',
    );
    assert.equal(Decimal.precision, 6);
    assert.equal(Decimal.rounding, Decimal.ROUND_DOWN);
  } finally {
    Decimal.set(original);
  }
});
