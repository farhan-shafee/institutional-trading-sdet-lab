import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { connection, executionSandbox } from './fixture.js';
await test('216 independent cash/quote cases include both day counts, half-even ties, zero cents and boundary ulps', async () => {
  const oracle = spawnSync('python3', ['verification/python/posttrade_cash.py'], {
    input: JSON.stringify({ generate: true }),
    encoding: 'utf8',
    maxBuffer: 1048576,
    timeout: 10000,
  });
  assert.equal(oracle.status, 0, oracle.stderr);
  const cases = JSON.parse(oracle.stdout) as {
    profile: string;
    value_date: string;
    par: string;
    quote: string;
    elapsed: number;
    period: number;
    cents: string;
    valid: boolean;
  }[];
  assert.equal(cases.length, 216);
  const s = await executionSandbox('1.00', 'BUY', 'SYN-UST-2031', '2030-01-15'),
    admin = await connection('admin');
  try {
    const original = (
      await admin.query<{ contract: Record<string, unknown> }>(
        'SELECT contract FROM fi.orders WHERE sandbox_id=$1 AND id=$2',
        [s.id, s.order],
      )
    ).rows[0]!.contract;
    let zero = false,
      up = false,
      down = false,
      inside = false,
      outside = false;
    for (const c of cases) {
      const contract = {
        ...original,
        instrument_revision: c.profile,
        settlement_date: c.value_date,
        clean_price: c.quote,
        instrument_terms: {
          ...(original['instrument_terms'] as Record<string, unknown>),
          day_count: c.profile === 'phase1-ust-1' ? 'ACT_ACT_ICMA' : 'THIRTY_360_US',
        },
      };
      const observed = (
        await admin.query<{ valid: boolean; cents: string; accrual: number[] }>(
          'SELECT fi_control.posttrade_quote_valid($1,$2) valid,fi_control.execution_cents($1,$3)::text cents,fi_control.execution_accrual($1) accrual',
          [JSON.stringify(contract), c.quote, c.par],
        )
      ).rows[0]!;
      assert.deepEqual(
        observed,
        { valid: c.valid, cents: c.cents, accrual: [c.elapsed, c.period] },
        JSON.stringify(c),
      );
      zero ||= c.valid && c.cents === '0';
      inside ||= c.valid;
      outside ||= !c.valid;
      up ||=
        c.value_date === '2025-01-15' &&
        c.quote === '102.000000000000' &&
        c.par === '1.25' &&
        c.cents === '128';
      down ||=
        c.value_date === '2025-01-15' &&
        c.quote === '102.000000000000' &&
        c.par === '1.75' &&
        c.cents === '178';
    }
    assert.ok(zero && up && down && inside && outside);
    await assert.rejects(
      s.app.query('SELECT fi_control.posttrade_quote_valid($1,$2)', [
        JSON.stringify(original),
        '100.000000000000',
      ]),
      { code: '42501' },
    );
  } finally {
    await admin.end();
    await s.close();
  }
});
