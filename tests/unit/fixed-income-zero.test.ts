import assert from 'node:assert/strict';
import test from 'node:test';
import {
  zeroAnalytics,
  zeroInstruments,
  zeroCashFlows,
} from '../../app/domain/fixed-income-v2/zero.js';

const request = {
  instrument_id: 'SYN-ZERO-2031',
  settlement_date: '2030-01-15',
  par_amount: '1000000',
  yield: '0.04',
};

void test('zero-coupon structure returns only redemption and no coupon accrual', () => {
  assert.deepEqual(zeroCashFlows('2030-01-15'), [
    {
      payment_date: '2031-01-15',
      coupon_per_100: '0.0000000000',
      principal_per_100: '100.0000000000',
    },
  ]);
  const r = zeroAnalytics(request);
  assert.equal(r.clean_price, '96.1538461538');
  assert.equal(r.dirty_price, '96.1538461538');
  assert.equal(r.accrued_interest, '0.0000000000');
  assert.equal(r.consideration_usd, '961538.46');
  assert.equal(r.time_to_maturity_years, '1.000000000000');
  assert.equal(r.model_version, 'ZERO_SIMPLE_ACT365F_V1');
  assert.equal(r.instrument.definition_version, 'SYN-ZERO-2031_V1');
});

void test('zero-coupon inverse uses exact quote and preserves supplied dirty consideration', () => {
  const r = zeroAnalytics({ ...request, yield: undefined, clean_price: '80' });
  assert.equal(r.yield, '0.250000000000');
  assert.equal(r.clean_price, '80.0000000000');
  assert.equal(r.consideration_usd, '800000.00');
});

void test('zero cash rounds rational half cents to even in both directions', () => {
  assert.equal(
    zeroAnalytics({ ...request, yield: '1', par_amount: '1.01' }).consideration_usd,
    '0.50',
  );
  assert.equal(
    zeroAnalytics({ ...request, yield: '1', par_amount: '1.03' }).consideration_usd,
    '0.52',
  );
  assert.equal(
    zeroAnalytics({ ...request, yield: undefined, clean_price: '50', par_amount: '1.01' })
      .consideration_usd,
    '0.50',
  );
  assert.equal(
    zeroAnalytics({ ...request, yield: undefined, clean_price: '50', par_amount: '1.03' })
      .consideration_usd,
    '0.52',
  );
});

void test('zero pricing counts actual leap days with fixed 365 denominator', () => {
  const r = zeroAnalytics({ ...request, settlement_date: '2028-02-29', yield: '0' });
  assert.equal(r.days_to_maturity, 1051);
  assert.equal(r.time_to_maturity_years, '2.879452054795');
  assert.equal(r.clean_price, '100.0000000000');
});

void test('zero-coupon inverse round trips the displayed bracket endpoints', () => {
  for (const yieldText of ['-0.10', '0', '1']) {
    const forward = zeroAnalytics({ ...request, yield: yieldText });
    const inverse = zeroAnalytics({
      ...request,
      yield: undefined,
      clean_price: forward.clean_price,
    });
    assert.ok(Math.abs(Number(inverse.yield) - Number(yieldText)) < 1e-10);
  }
});

void test('zero-coupon inputs fail closed for invalid domains and unsupported fields', () => {
  for (const changes of [
    { instrument_id: 'SYN-UST-2031' },
    { settlement_date: '2027-02-29' },
    { settlement_date: '2031-01-15' },
    { settlement_date: '2025-01-14' },
    { settlement_date: '2030-1-15' },
    { par_amount: '0' },
    { par_amount: '1000000000.01' },
    { par_amount: '1e6' },
    { par_amount: '1.001' },
    { yield: '-0.1001' },
    { yield: '1.0001' },
    { yield: 'NaN' },
    { yield: '0.04', clean_price: '100' },
    { yield: undefined },
    { yield: undefined, clean_price: '0' },
    { yield: undefined, clean_price: '10000' },
    { yield: undefined, clean_price: '49.999999' },
    { yield: undefined, clean_price: '111.111112' },
    { currency: 'EUR' },
  ])
    assert.throws(() => zeroAnalytics({ ...request, ...changes }));
  assert.throws(() => zeroCashFlows('2031-01-15'));
});

void test('zero definitions cannot be mutated across calculations or callers', () => {
  assert.equal(Object.isFrozen(zeroInstruments), true);
  assert.equal(Object.isFrozen(zeroInstruments[0]), true);
  assert.throws(
    () => Reflect.set(zeroInstruments[0]!, 'maturity_date', '2099-01-01') || assert.fail(),
  );
  const r = zeroAnalytics(request);
  assert.equal(Object.isFrozen(r.instrument), true);
  assert.equal(zeroAnalytics(request).instrument.maturity_date, '2031-01-15');
});
