import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rfqHttp } from './rfq-http-fixture.js';
import { rfqInput, type RfqDetail } from './rfq-fixture.js';
export async function executionHttp(now?: () => number) {
  const f = await rfqHttp(now);
  const input = { ...rfqInput(), par_amount: '100.00' };
  assert.equal(
    (await f.lab.request(`${f.root}/rfqs`, f.token, 'POST', input, randomUUID())).status,
    201,
  );
  const q = await f.lab.request(
    `${f.root}/rfqs/${input.rfq_id}/dealer-responses`,
    f.token,
    'POST',
    { expected_version: '1', dealer_id: 'ATLAS', response: 'QUOTE' },
    randomUUID(),
  );
  assert.equal(q.status, 200);
  const quote = (await q.json()) as RfqDetail;
  const a = await f.lab.request(
    `${f.root}/rfqs/${input.rfq_id}/accept`,
    f.token,
    'POST',
    { expected_version: '2', quote_id: quote.quotes[0]!.id },
    randomUUID(),
  );
  assert.equal(a.status, 201);
  const accepted = (await a.json()) as RfqDetail;
  return { ...f, order: accepted.order!.id, path: `${f.root}/orders/${accepted.order!.id}` };
}
