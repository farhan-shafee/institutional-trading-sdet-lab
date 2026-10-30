import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { restartOwnedPostgres } from '../../scripts/owned-postgres.js';
import { rfqHttp } from './rfq-http-fixture.js';
import { rfqInput, type RfqDetail } from './rfq-fixture.js';

await test('database outage fails RFQ reads closed and restart preserves the pending order and acceptance receipt', async () => {
  const f = await rfqHttp();
  try {
    const input = rfqInput(),
      base = `${f.root}/rfqs/${input.rfq_id}`;
    assert.equal(
      (await f.lab.request(`${f.root}/rfqs`, f.token, 'POST', input, randomUUID())).status,
      201,
    );
    const quote = (await (
      await f.lab.request(
        `${base}/dealer-responses`,
        f.token,
        'POST',
        { expected_version: '1', dealer_id: 'ATLAS', response: 'QUOTE' },
        randomUUID(),
      )
    ).json()) as RfqDetail;
    const payload = { expected_version: '2', quote_id: quote.quotes[0]!.id },
      key = randomUUID();
    const accepted = await f.lab.request(`${base}/accept`, f.token, 'POST', payload, key);
    assert.equal(accepted.status, 201);
    const original = (await accepted.json()) as RfqDetail;
    await restartOwnedPostgres(process.env.TF_DB_OWNER_FILE!, async () => {
      assert.equal((await f.lab.request(base, f.token)).status, 503);
      assert.equal((await f.lab.request('/api/orders', f.token)).status, 200);
      assert.equal((await f.lab.request('/health')).status, 200);
    });
    const after = await f.lab.request(base, f.token);
    assert.equal(after.status, 200);
    assert.deepEqual(((await after.json()) as RfqDetail).order, original.order);
    const replay = await f.lab.request(`${base}/accept`, f.token, 'POST', payload, key);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(await replay.json(), original);
  } finally {
    await f.close();
  }
});
