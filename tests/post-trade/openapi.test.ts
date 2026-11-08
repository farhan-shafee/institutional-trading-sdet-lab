import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { request } from '@playwright/test';
import { OpenApiContracts } from '../contract/openapi-validator.js';
import { postTradeHttp } from './http-fixture.js';

await test('published independent post-trade contracts validate actual owned HTTP outcomes and reject added financial fields', async () => {
  const s = await postTradeHttp();
  const client = await request.newContext({ baseURL: s.lab.origin });
  try {
    const contracts = await OpenApiContracts.load(client);
    const template = '/api/fixed-income/v1/sandboxes/{sandboxId}/posttrade';
    const execution = template + '/executions/{executionId}';
    async function check(response: Response, method: 'get' | 'post', path: string, status: number) {
      assert.equal(response.status, status);
      const body: unknown = await response.json();
      const validate = contracts.response(method, path, status);
      assert.equal(validate(body), true, JSON.stringify(validate.errors));
      assert.equal(validate({ ...(body as Record<string, unknown>), client_positions: [] }), false);
      return body as Record<string, unknown>;
    }
    const query = '?fixture_id=FLAT_V1&as_of_date=2030-01-15';
    const unavailable = await check(
      await s.lab.request(s.path + '/risk' + query, s.token),
      'get',
      template + '/risk',
      200,
    );
    assert.equal(unavailable['status'], 'UNAVAILABLE');
    assert.ok(!Object.hasOwn(unavailable, 'risk'));
    await check(await s.lab.request(s.path, s.token), 'get', template, 200);
    const initKey = randomUUID();
    await check(
      await s.lab.request(
        s.path + '/initialize',
        s.token,
        'POST',
        { economic_start_date: '2030-01-15' },
        initKey,
      ),
      'post',
      template + '/initialize',
      201,
    );
    await check(
      await s.lab.request(s.path + '/commands/' + initKey, s.token),
      'get',
      template + '/commands/{key}',
      200,
    );
    await check(
      await s.lab.request(s.path + '/pnl' + query, s.token),
      'get',
      template + '/pnl',
      200,
    );
    const buy = await s.execution();
    const root = s.path + '/executions/' + buy.execution_id;
    await check(
      await s.lab.request(root + '/history', s.token),
      'get',
      execution + '/history',
      200,
    );
    await check(
      await s.lab.request(root + '/register', s.token, 'POST', {}, randomUUID()),
      'post',
      execution + '/register',
      201,
    );
    await check(
      await s.lab.request(
        root + '/corrections',
        s.token,
        'POST',
        { expected_revision: 0, clean_price: '100.880000000000' },
        randomUUID(),
      ),
      'post',
      execution + '/corrections',
      201,
    );
    await check(
      await s.lab.request(s.path + '/risk' + query, s.token),
      'get',
      template + '/risk',
      200,
    );
    await check(
      await s.lab.request(s.path + '/pnl' + query, s.token),
      'get',
      template + '/pnl',
      200,
    );
    const sell = await s.execution('40.00', 'SELL');
    const shortRoot = s.path + '/executions/' + sell.execution_id;
    await check(
      await s.lab.request(shortRoot + '/register', s.token, 'POST', {}, randomUUID()),
      'post',
      execution + '/register',
      201,
    );
    await check(
      await s.lab.request(
        shortRoot + '/settlements',
        s.token,
        'POST',
        { expected_revision: 0, processing_date: '2030-01-15' },
        randomUUID(),
      ),
      'post',
      execution + '/settlements',
      409,
    );
    await check(
      await s.lab.request(
        root + '/settlements',
        s.token,
        'POST',
        { expected_revision: 1, processing_date: '2030-01-15' },
        randomUUID(),
      ),
      'post',
      execution + '/settlements',
      200,
    );
    await check(
      await s.lab.request(
        shortRoot + '/settlements',
        s.token,
        'POST',
        { expected_revision: 0, processing_date: '2030-01-15' },
        randomUUID(),
      ),
      'post',
      execution + '/settlements',
      200,
    );
    await check(
      await s.lab.request(
        shortRoot + '/reversals',
        s.token,
        'POST',
        { expected_revision: 0, processing_date: '2030-01-15' },
        randomUUID(),
      ),
      'post',
      execution + '/reversals',
      200,
    );
    await check(
      await s.lab.request(
        root + '/reversals',
        s.token,
        'POST',
        { expected_revision: 1, processing_date: '2030-01-15' },
        randomUUID(),
      ),
      'post',
      execution + '/reversals',
      200,
    );
    await check(
      await s.lab.request(root + '/busts', s.token, 'POST', { expected_revision: 1 }, randomUUID()),
      'post',
      execution + '/busts',
      201,
    );
    await check(
      await s.lab.request(root + '/history', s.token),
      'get',
      execution + '/history',
      200,
    );
    await check(await s.lab.request(s.path, s.token), 'get', template, 200);
    await check(
      await s.lab.request(s.path + '/audit-events?limit=1', s.token),
      'get',
      template + '/audit-events',
      200,
    );
    const pnl = await check(
      await s.lab.request(s.path + '/pnl' + query, s.token),
      'get',
      template + '/pnl',
      200,
    );
    const validate = contracts.response('get', template + '/pnl', 200);
    const metrics = pnl['pnl'] as Record<string, unknown>;
    assert.equal(validate({ ...pnl, pnl: { ...metrics, available_cash_usd: '-1.00' } }), false);
    assert.equal(validate({ ...pnl, pnl: { ...metrics, total_pnl_usd: 0 } }), false);
    assert.equal(validate({ ...pnl, status: 'UNAVAILABLE' }), false);
  } finally {
    await client.dispose();
    await s.close();
  }
});
