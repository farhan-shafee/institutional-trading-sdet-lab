import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  curveSnapshot,
  curveExponent,
  discountFactor,
  type CurveFixtureId,
} from '../../app/domain/fixed-income-v3/curves.js';
import { Rational } from '../../app/domain/fixed-income-v3/numbers.js';

void test('flat curve has literal independent discount factors and exact as-of anchor', () => {
  const c = curveSnapshot('FLAT_V1', '2030-01-15');
  assert.equal(discountFactor(c, 0).toFixed(20), '1.00000000000000000000');
  assert.equal(discountFactor(c, 365).toFixed(20), '0.97044553354850817693');
  assert.equal(discountFactor(c, 730).toFixed(20), '0.94176453358424870954');
  assert.equal(discountFactor(c, 3650).toFixed(20), '0.74081822068171786607');
  assert.equal(c.nodes[0]!.discount_factor, '0.97044553354850817693');
});

void test('negative rates legitimately produce positive discount factors above one', () => {
  const c = curveSnapshot('NEGATIVE_V1', '2028-02-29');
  assert.equal(discountFactor(c, 365).toFixed(20), '1.01005016708416805754');
  assert.ok(discountFactor(c, 3650).gt(1));
  assert.ok(discountFactor(c, 1).gt(1));
});

void test('log-linear interpolation uses exact integrated-rate rational coefficients', () => {
  const c = curveSnapshot('BASE_UP_V1', '2025-01-15');
  const points = [
    [365, '0.02'],
    [730, '0.025'],
    [1825, '0.03'],
    [3650, '0.035'],
  ] as const;
  for (const [d, rate] of points) {
    const expected = Rational.decimal(rate).mul(new Rational(BigInt(-d), 365n));
    const actual = curveExponent(c, d, new Rational(0n));
    assert.equal(actual.numerator, expected.numerator);
    assert.equal(actual.denominator, expected.denominator);
  }
  const midpoint = curveExponent(c, 547, new Rational(0n));
  assert.equal(midpoint.numerator, -319n);
  assert.equal(midpoint.denominator, 9125n);
  for (const d of [1, 182, 547, 1277, 2737, 3649]) {
    const value = discountFactor(c, d);
    assert.ok(value.isFinite() && value.gt(0) && value.lt(1));
    assert.ok(value.gt(discountFactor(c, d + 1)));
  }
});

void test('flat zero rate and exactly opposite spread cancel before exponentiation', () => {
  const c = curveSnapshot('FLAT_V1', '2028-02-29');
  for (const d of [0, 1, 182, 365, 547, 730, 1277, 1825, 2737, 3650]) {
    assert.equal(curveExponent(c, d, Rational.decimal('-0.03')).isZero(), true);
    assert.equal(discountFactor(c, d, '-0.03').toString(), '1');
  }
});

void test('named risk node shocks preserve interpolation and apply finite annual bp units', () => {
  const c = curveSnapshot('FLAT_V1', '2030-01-15');
  const up = [1, 1, 1, 1].map((n) => new Rational(BigInt(n)));
  assert.equal(curveExponent(c, 365, new Rational(0n), up).fixed(6), '-0.030100');
  assert.equal(curveExponent(c, 730, new Rational(0n), up).fixed(6), '-0.060200');
  const key = [1, 0, 0, 0].map((n) => new Rational(BigInt(n)));
  assert.equal(curveExponent(c, 730, new Rational(0n), key).fixed(6), '-0.060000');
  assert.equal(curveExponent(c, 365, new Rational(0n), key).fixed(6), '-0.030100');
  assert.throws(() => curveExponent(c, 365, new Rational(0n), []));
  assert.throws(() =>
    curveExponent(c, 365, new Rational(0n), [0, 0, 0, 0] as unknown as Rational[]),
  );
  assert.throws(() =>
    curveExponent(c, 365, new Rational(0n), [new Rational(101n), ...up.slice(1)]),
  );
});

void test('canonical snapshot hash binds exact fixture date currency model and all four nodes', () => {
  const c = curveSnapshot('BASE_UP_V1', '2025-01-15');
  const canonical = {
    version: 1,
    model_version: 'DISCOUNT_LOG_LINEAR_ACT365F_V1',
    currency: 'USD',
    fixture_id: 'BASE_UP_V1',
    as_of_date: '2025-01-15',
    nodes: [
      { offset_days: 365, zero_rate: '0.020000000000' },
      { offset_days: 730, zero_rate: '0.025000000000' },
      { offset_days: 1825, zero_rate: '0.030000000000' },
      { offset_days: 3650, zero_rate: '0.035000000000' },
    ],
  };
  assert.equal(c.snapshot_id, createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
  assert.equal(c.snapshot_id, curveSnapshot('BASE_UP_V1', '2025-01-15').snapshot_id);
  assert.notEqual(c.snapshot_id, curveSnapshot('BASE_UP_V1', '2025-01-16').snapshot_id);
  assert.notEqual(c.snapshot_id, curveSnapshot('FLAT_V1', '2025-01-15').snapshot_id);
  assert.equal(c.model_version, canonical.model_version);
  assert.equal(c.currency, canonical.currency);
});

void test('canonical snapshot metadata is deeply immutable and forged snapshots are rejected', () => {
  const c = curveSnapshot('FLAT_V1', '2030-01-15');
  assert.equal(Object.isFrozen(c), true);
  assert.equal(Object.isFrozen(c.nodes), true);
  assert.equal(Object.isFrozen(c.nodes[0]), true);
  assert.equal(Reflect.set(c, 'snapshot_id', '0'.repeat(64)), false);
  assert.equal(Reflect.set(c.nodes[0]!, 'zero_rate', '0'), false);
  const forged = { ...c, nodes: c.nodes.map((n) => ({ ...n, zero_rate: '0' })) };
  assert.throws(() => discountFactor(forged, 365));
  assert.throws(() => discountFactor({ ...c }, 365));
  assert.equal(curveSnapshot('FLAT_V1', '2030-01-15').snapshot_id, c.snapshot_id);
});

void test('curve domains reject extrapolation invalid day counts dates and spread ranges', () => {
  const c = curveSnapshot('BASE_UP_V1', '2026-01-15');
  for (const days of [-1, 3651, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(() => discountFactor(c, days));
  for (const spread of ['-0.100000000001', '1.000000000001', '1e-2', 'NaN'])
    assert.throws(() => discountFactor(c, 365, spread));
  for (const date of ['2025-01-14', '2031-01-15', '2027-02-29', '2026-1-15'])
    assert.throws(() => curveSnapshot('FLAT_V1', date));
  for (const id of ['MISSING', '__proto__', 'constructor'])
    assert.throws(() => curveSnapshot(id as CurveFixtureId, '2026-01-15'));
});
