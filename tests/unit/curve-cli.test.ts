import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

void test('curve CLI uses the real typed model and rejects malformed or oversized input', () => {
  const args = ['--import', 'tsx', 'scripts/curve-analytics.ts'];
  const valid = {
    instrument_id: 'SYN-ZERO-2031',
    fixture_id: 'FLAT_V1',
    as_of_date: '2030-01-15',
    par_amount: '999999900.31',
    z_spread: '0',
  };
  const result = spawnSync(process.execPath, args, {
    input: JSON.stringify(valid),
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(body.mark_value_usd, '970445436.80');
  assert.equal(body.model_version, 'DISCOUNT_LOG_LINEAR_ACT365F_V1');
  assert.equal(Object.hasOwn(body, 'consideration_usd'), false);
  for (const input of [
    'not-json',
    JSON.stringify({ ...valid, z_spread: '1e-2' }),
    ' '.repeat(16385),
  ]) {
    const rejected = spawnSync(process.execPath, args, { input, encoding: 'utf8', timeout: 10000 });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
    assert.deepEqual(JSON.parse(rejected.stderr) as unknown, {
      error: { code: 'VALIDATION_ERROR', message: 'Invalid curve request.' },
    });
  }
});
