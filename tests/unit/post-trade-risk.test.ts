import assert from 'node:assert/strict';
import test from 'node:test';
import {
  instrumentDollarRisk,
  aggregateDollarRisk,
  dollarRiskWire,
} from '../../app/domain/post-trade/risk.js';
import { curveSnapshot } from '../../app/domain/fixed-income-v3/curves.js';
import { Rational, decimal80 } from '../../app/domain/fixed-income-v3/numbers.js';

void test('one-year zero dollar PV and central parallel DV01 match literal independent values', () => {
  const risk = instrumentDollarRisk(
    curveSnapshot('FLAT_V1', '2030-01-15'),
    'SYN-ZERO-2031',
    Rational.decimal('1000000'),
  );
  assert.ok(risk.pv.sub('970445.5335485081769325').abs().lt('1e-15'));
  assert.ok(risk.parallel_dv01.sub('97.04455351659174003221').abs().lt('1e-18'));
  assert.equal(dollarRiskWire(risk).pv_usd, '970445.53');
  assert.equal(dollarRiskWire(risk).parallel_dv01_usd, '97.04455352');
  assert.ok(risk.key_rate_dv01[0].eq(risk.parallel_dv01));
  assert.ok(risk.key_rate_dv01.slice(1).every((x) => x.isZero()));
});

void test('signed short dollar measures are the exact negatives of the corresponding long', () => {
  const c = curveSnapshot('BASE_UP_V1', '2028-02-29');
  const long = instrumentDollarRisk(c, 'SYN-UST-2031', Rational.decimal('1000000'));
  const short = instrumentDollarRisk(c, 'SYN-UST-2031', Rational.decimal('-1000000'));
  assert.ok(long.pv.eq(short.pv.neg()));
  assert.ok(long.parallel_dv01.eq(short.parallel_dv01.neg()));
  long.key_rate_dv01.forEach((v, i) => assert.ok(v.eq(short.key_rate_dv01[i]!.neg())));
  for (const key of ['PARALLEL_UP_100', 'PARALLEL_DOWN_100', 'STEEPENER_V1'] as const)
    assert.ok(long.stress_pnl[key].eq(short.stress_pnl[key].neg()));
});

void test('verified empty and zero-position math serializes true zero without negative-zero ambiguity', () => {
  const empty = dollarRiskWire(aggregateDollarRisk([]));
  assert.deepEqual(empty, {
    pv_usd: '0.00',
    parallel_dv01_usd: '0.00000000',
    key_rate_dv01_usd: ['0.00000000', '0.00000000', '0.00000000', '0.00000000'],
    stress_pnl_usd: {
      PARALLEL_UP_100: '0.00000000',
      PARALLEL_DOWN_100: '0.00000000',
      STEEPENER_V1: '0.00000000',
    },
  });
  const zero = instrumentDollarRisk(
    curveSnapshot('FLAT_V1', '2030-01-15'),
    'SYN-UST-2031',
    new Rational(0n),
  );
  assert.deepEqual(dollarRiskWire(zero), empty);
});

void test('offset authoritative-style math remains exact zero across the two original flow profiles', () => {
  const c = curveSnapshot('NEGATIVE_V1', '2028-02-29');
  const offset = aggregateDollarRisk([
    instrumentDollarRisk(c, 'SYN-UST-2031', Rational.decimal('1000000')),
    instrumentDollarRisk(c, 'SYN-CORP-2031', Rational.decimal('-1000000')),
  ]);
  assert.ok(offset.pv.isZero() && offset.parallel_dv01.isZero());
  assert.deepEqual(dollarRiskWire(offset), dollarRiskWire(aggregateDollarRisk([])));
});

void test('finite key-rate central bumps do not assert exact additive equality to parallel', () => {
  const r = instrumentDollarRisk(
    curveSnapshot('BASE_UP_V1', '2025-01-15'),
    'SYN-UST-2031',
    Rational.decimal('1000000000'),
  );
  const sum = r.key_rate_dv01.reduce((total, value) => total.add(value), decimal80(0));
  assert.ok(r.parallel_dv01.sub(sum).abs().gt('0.00000001'));
  assert.ok(r.key_rate_dv01.every((v) => v.gt(0)));
});

void test('approved stresses preserve normal long signs and separate nonparallel steepener', () => {
  const r = instrumentDollarRisk(
    curveSnapshot('FLAT_V1', '2025-01-15'),
    'SYN-CORP-2031',
    Rational.decimal('1000000'),
  );
  assert.ok(r.stress_pnl.PARALLEL_UP_100.lt(0));
  assert.ok(r.stress_pnl.PARALLEL_DOWN_100.gt(0));
  assert.ok(!r.stress_pnl.STEEPENER_V1.eq(r.stress_pnl.PARALLEL_UP_100));
  assert.equal(Object.keys(r.stress_pnl).length, 3);
});

void test('risk aggregates unrounded component PV before reporting money', () => {
  const c = curveSnapshot('FLAT_V1', '2030-01-15');
  const parts = ['SYN-UST-2031', 'SYN-CORP-2031'].map((id) =>
    instrumentDollarRisk(c, id as 'SYN-UST-2031' | 'SYN-CORP-2031', Rational.decimal('0.50')),
  );
  assert.equal(dollarRiskWire(parts[0]!).pv_usd, '0.50');
  assert.equal(dollarRiskWire(parts[1]!).pv_usd, '0.50');
  assert.equal(dollarRiskWire(aggregateDollarRisk(parts)).pv_usd, '1.01');
});

void test('risk kernel rejects non-cent par and amounts beyond the eight-root bound', () => {
  const c = curveSnapshot('FLAT_V1', '2030-01-15');
  for (const par of ['0.001', '-0.001', '8000000000.01', '-8000000000.01'])
    assert.throws(() => instrumentDollarRisk(c, 'SYN-UST-2031', Rational.decimal(par)));
  assert.ok(instrumentDollarRisk(c, 'SYN-UST-2031', Rational.decimal('8000000000')).pv.gt(0));
});

void test('risk numerical helpers reject copied or forged curve snapshots', () => {
  const c = curveSnapshot('FLAT_V1', '2030-01-15');
  assert.throws(() => instrumentDollarRisk({ ...c }, 'SYN-UST-2031', Rational.decimal('100')));
});
