import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zeroAnalytics } from '../../app/domain/fixed-income-v2/zero.js';

void test('zero analytics agrees with independent exact Fraction oracle across dates and amounts', () => {
  const requests = [];
  for (const settlement of ['2025-01-15', '2028-02-29', '2030-01-15', '2031-01-14'])
    for (const par of ['1.01', '1.03', '1000000', '999999999.87'])
      for (const rate of ['-0.10', '0', '0.04', '1'])
        requests.push({
          instrument_id: 'SYN-ZERO-2031',
          settlement_date: settlement,
          par_amount: par,
          yield: rate,
        });
  for (const clean of ['50', '80', '99.875', '100'])
    requests.push({
      instrument_id: 'SYN-ZERO-2031',
      settlement_date: '2030-01-15',
      par_amount: '999999999.87',
      clean_price: clean,
    });
  requests.push({
    instrument_id: 'SYN-ZERO-2031',
    settlement_date: '2030-01-15',
    par_amount: '999999999.83',
    yield: '0.04',
  });
  const expected = JSON.parse(
    execFileSync(
      'python3',
      [fileURLToPath(new URL('../../verification/python/zero_coupon.py', import.meta.url))],
      { input: JSON.stringify(requests), encoding: 'utf8', timeout: 10000 },
    ),
  ) as Record<string, unknown>[];
  assert.equal(expected.length, 69);
  requests.forEach((q, i) => {
    const actual = zeroAnalytics(q) as unknown as Record<string, unknown>;
    for (const [field, value] of Object.entries(expected[i]!))
      assert.equal(actual[field], value, JSON.stringify({ q, field }));
  });
});
