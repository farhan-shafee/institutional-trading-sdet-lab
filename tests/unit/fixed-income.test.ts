import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { analytics, instruments } from '../../app/domain/fixed-income/analytics.js';
import { couponDates, dayCountUS, parseDate } from '../../app/domain/fixed-income/dates.js';

const request = {
  instrument_id: 'SYN-UST-2031',
  settlement_date: '2026-10-15',
  par_amount: '1000000',
  clean_price: '99.875',
};
void test('synthetic consideration golden case uses unrounded accrued interest', () => {
  const a = analytics(request);
  assert.equal(a.accrued_interest, '1.0000000000');
  assert.equal(a.dirty_price, '100.8750000000');
  assert.equal(a.consideration_usd, '1008750.00');
});
void test('coupon-date par bond and analytic risk have literal one-period values', () => {
  const a = analytics({
    ...request,
    settlement_date: '2030-07-15',
    clean_price: undefined,
    yield: '0.04',
  });
  assert.equal(a.clean_price, '100.0000000000');
  assert.equal(a.accrued_interest, '0.0000000000');
  assert.equal(a.macaulay_duration, '0.5000000000');
  assert.equal(a.modified_duration, '0.4901960784');
  assert.equal(a.convexity, '0.4805843906');
});
void test('Actual/Actual differs from US30/360 at leap-day settlement', () => {
  const u = analytics({ ...request, settlement_date: '2028-02-29' });
  const c = analytics({
    ...request,
    settlement_date: '2028-02-29',
    instrument_id: 'SYN-CORP-2031',
  });
  assert.equal(u.accrued_interest, '0.4945054945');
  assert.equal(c.accrued_interest, '0.4888888889');
});
void test('negative yield, inverse and finite boundary risk are supported', () => {
  for (const y of ['-0.10', '-0.01', '0', '1.00']) {
    const a = analytics({ ...request, clean_price: undefined, yield: y });
    const back = analytics({ ...request, clean_price: a.clean_price });
    assert.ok(Math.abs(Number(back.yield) - Number(y)) < 1e-9);
    assert.ok(Number(a.dv01_usd) > 0);
  }
});
void test('dates, maturity, amount and mutually-exclusive inputs fail closed', () => {
  for (const changes of [
    { settlement_date: '2027-02-29' },
    { settlement_date: '2031-01-15' },
    { settlement_date: '2025-01-14' },
    { par_amount: '1e6' },
    { par_amount: '1.001' },
    { par_amount: '0' },
    { yield: '0.04' },
    { clean_price: '10001' },
    { clean_price: '0.0000000001' },
    { clean_price: undefined, yield: '-0.1001' },
  ])
    assert.throws(() => analytics({ ...request, ...changes }));
  assert.throws(() => parseDate('0000-01-01'));
  assert.throws(() => parseDate('2026-1-15'));
});
void test('US30/360 February and 31st adjustments and EOM coupon schedules', () => {
  assert.equal(dayCountUS('2028-02-29', '2028-08-31'), 180);
  assert.equal(dayCountUS('2027-02-28', '2028-02-29'), 360);
  assert.equal(dayCountUS('2028-01-31', '2028-02-29'), 29);
  assert.deepEqual(couponDates('2025-03-31', '2026-03-31'), ['2025-09-30', '2026-03-31']);
  assert.throws(() => couponDates('2025-03-30', '2026-03-31'));
  assert.equal(instruments.length, 2);
});

void test('cash uses unrounded valuation instead of displayed price at large par', () => {
  assert.equal(
    analytics({
      instrument_id: 'SYN-CORP-2031',
      settlement_date: '2025-01-15',
      par_amount: '999999993.34',
      yield: '-0.02',
    }).consideration_usd,
    '1384534289.28',
  );
  assert.equal(
    analytics({
      instrument_id: 'SYN-UST-2031',
      settlement_date: '2028-02-29',
      par_amount: '999999999.87',
      yield: '0.0875',
    }).consideration_usd,
    '886339405.71',
  );
});

void test('cash half-cent ties follow exact half-even arithmetic for price and yield', () => {
  assert.equal(
    analytics({ ...request, settlement_date: '2025-07-16', par_amount: '46', clean_price: '100' })
      .consideration_usd,
    '46.00',
  );
  assert.equal(
    analytics({ ...request, settlement_date: '2025-07-16', par_amount: '138', clean_price: '100' })
      .consideration_usd,
    '138.02',
  );
  assert.equal(
    analytics({
      ...request,
      settlement_date: '2030-07-15',
      par_amount: '1.30',
      clean_price: undefined,
      yield: '0.08',
    }).consideration_usd,
    '1.28',
  );
  assert.equal(
    analytics({
      ...request,
      settlement_date: '2030-07-15',
      par_amount: '1.82',
      clean_price: undefined,
      yield: '0.08',
    }).consideration_usd,
    '1.78',
  );
});
