import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createRfqSchema,
  dealerResponseSchema,
  quoteCommandSchema,
} from '../../app/domain/workflow/rfq.js';

await test('RFQ canonicalization preserves exact USD par and canonical invitation order', () => {
  const input = {
    rfq_id: randomUUID(),
    instrument_id: 'SYN-UST-2031',
    side: 'BUY',
    par_amount: '0001000.10',
    settlement_date: '2028-02-29',
    invited_dealers: ['CEDAR', 'ATLAS'],
  };
  assert.equal(createRfqSchema.parse(input).par_amount, '1000.10');
  assert.deepEqual(createRfqSchema.parse(input).invited_dealers, ['ATLAS', 'CEDAR']);
  for (const par_amount of ['0', '0.99', '1000000000.01', '1e6', '1.001', 'NaN'])
    assert.equal(createRfqSchema.safeParse({ ...input, par_amount }).success, false);
  for (const settlement_date of ['2027-02-29', '2031-01-15', '2025-01-14'])
    assert.equal(createRfqSchema.safeParse({ ...input, settlement_date }).success, false);
  assert.equal(
    createRfqSchema.safeParse({ ...input, invited_dealers: ['ATLAS', 'ATLAS'] }).success,
    false,
  );
  assert.equal(createRfqSchema.safeParse({ ...input, reference_price: '100' }).success, false);
});
await test('dealer simulation and quote command inputs reject unsolicited prices and invalid versions', () => {
  assert.equal(
    dealerResponseSchema.safeParse({
      expected_version: '1',
      dealer_id: 'ATLAS',
      response: 'QUOTE',
      price: '100',
    }).success,
    false,
  );
  assert.equal(
    dealerResponseSchema.safeParse({
      expected_version: '1',
      dealer_id: 'REAL_BANK',
      response: 'QUOTE',
    }).success,
    false,
  );
  assert.equal(
    quoteCommandSchema.safeParse({ expected_version: 1, quote_id: randomUUID() }).success,
    false,
  );
  assert.equal(
    quoteCommandSchema.safeParse({ expected_version: '0', quote_id: randomUUID() }).success,
    false,
  );
});
