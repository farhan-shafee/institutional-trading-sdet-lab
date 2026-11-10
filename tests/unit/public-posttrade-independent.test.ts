import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyPublicReports } from '../public-posttrade/independent.js';

await test('public independent reconstruction refuses missing source, events and history instead of emitting a passing receipt', () => {
  assert.throws(
    () =>
      verifyPublicReports([
        {
          version: 1,
          source: {
            available_securities: [{ instrument_id: 'SYN-UST-2031', available_par: '1.00' }],
          },
        },
      ]),
    /Independent public accounting reconstruction failed/,
  );
});
