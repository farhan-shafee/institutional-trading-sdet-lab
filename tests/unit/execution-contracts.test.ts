import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  executionCommandSchema,
  orderVersionSchema,
  cancelCommandSchema,
} from '../../app/domain/workflow/execution.js';
await test('fill contracts normalize exact decimal par without binary arithmetic and reject unsolicited economics', () => {
  const v = {
    expected_version: '2',
    execution_id: randomUUID().toUpperCase(),
    source_event_id: randomUUID(),
    par_amount: '0.01',
  };
  assert.equal(executionCommandSchema.parse(v).execution_id, v.execution_id.toLowerCase());
  for (const value of ['0', '-1', '0.001', '1000000000.01', 'NaN', '1e2'])
    assert.equal(executionCommandSchema.safeParse({ ...v, par_amount: value }).success, false);
  assert.equal(executionCommandSchema.parse({ ...v, par_amount: '01.5' }).par_amount, '1.50');
  assert.equal(executionCommandSchema.safeParse({ ...v, clean_price: '100.00' }).success, false);
  assert.equal(executionCommandSchema.safeParse({ ...v, par_amount: 1 }).success, false);
});
await test('lifecycle versions and cancellation identities are explicit and strict', () => {
  assert.equal(orderVersionSchema.safeParse({ expected_version: '0' }).success, false);
  assert.equal(
    orderVersionSchema.safeParse({ expected_version: '2', status: 'NEW' }).success,
    false,
  );
  assert.equal(cancelCommandSchema.safeParse({ expected_version: '2' }).success, false);
  assert.equal(
    cancelCommandSchema.parse({ expected_version: '2', cancel_id: randomUUID() }).expected_version,
    '2',
  );
});
