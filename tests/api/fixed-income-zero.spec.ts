import { test, expect } from '../fixtures/tradeflow.fixture.js';
import { test as anonymous } from '@playwright/test';
import { OpenApiContracts } from '../contract/openapi-validator.js';
import {
  zeroAnalyticsSchema,
  zeroInstrumentsSchema,
} from '../../app/domain/fixed-income-v2/zero.js';

const root = '/api/fixed-income/v2';
const query =
  'instrument_id=SYN-ZERO-2031&settlement_date=2030-01-15&par_amount=1000000&yield=0.04';

anonymous('zero-coupon endpoints require an existing session', async ({ request }) => {
  for (const path of ['/instruments', `/analytics?${query}`]) {
    const r = await request.get(root + path);
    expect(r.status()).toBe(401);
    expect(await r.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  }
});

test('zero-coupon catalogue and analytics satisfy independently authored wire contracts', async ({
  apiClient,
}) => {
  const contracts = await OpenApiContracts.load(apiClient);
  for (const path of ['/instruments', '/analytics']) {
    const response = await apiClient.get(root + path + (path === '/analytics' ? `?${query}` : ''));
    expect(response.status()).toBe(200);
    const body: unknown = await response.json();
    const validate = contracts.response('get', root + path, 200);
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    expect(
      (path === '/instruments' ? zeroInstrumentsSchema : zeroAnalyticsSchema).safeParse(body)
        .success,
    ).toBe(true);
    if (path === '/analytics')
      expect(body).toMatchObject({
        model_version: 'ZERO_SIMPLE_ACT365F_V1',
        clean_price: '96.1538461538',
        accrued_interest: '0.0000000000',
        consideration_usd: '961538.46',
      });
  }
});

test('zero-coupon reads preserve owned books and the accepted v1 catalogue', async ({
  apiClient,
  orderFactory,
}) => {
  await orderFactory();
  const beforeResponse = await apiClient.get('/api/orders');
  expect(beforeResponse.status()).toBe(200);
  const before: unknown = await beforeResponse.json();
  expect((await apiClient.get(`${root}/analytics?${query}`)).status()).toBe(200);
  const afterResponse = await apiClient.get('/api/orders');
  expect(afterResponse.status()).toBe(200);
  expect(await afterResponse.json()).toEqual(before);
  const legacy = await apiClient.get('/api/fixed-income/v1/instruments');
  expect(legacy.status()).toBe(200);
  const body = (await legacy.json()) as { instruments: { id: string }[] };
  expect(body.instruments.map((i) => i.id)).toEqual(['SYN-UST-2031', 'SYN-CORP-2031']);
});

for (const suffix of [
  '&unexpected=x',
  '&__proto__=x',
  '&par_amount=1',
  '&yield=0.04',
  '&clean_price=80',
]) {
  test(`zero-coupon query rejects ${suffix}`, async ({ apiClient }) => {
    const response = await apiClient.get(`${root}/analytics?${query}${suffix}`);
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
}

test('zero-coupon invalid domains return safe errors and catalogue takes no parameters', async ({
  apiClient,
}) => {
  for (const path of [
    '/instruments?x=1',
    '/analytics?' + query.replace('2030-01-15', '2031-01-15'),
    '/analytics?' + query.replace('SYN-ZERO-2031', 'SYN-UST-2031'),
    '/analytics?' + query.replace('yield=0.04', 'yield=NaN'),
  ]) {
    const response = await apiClient.get(root + path);
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  }
});

test('zero-coupon successful wire schema rejects absent identity and malformed amounts', async ({
  apiClient,
}) => {
  const response = await apiClient.get(`${root}/analytics?${query}`);
  expect(response.status()).toBe(200);
  const original = (await response.json()) as Record<string, unknown>;
  const contracts = await OpenApiContracts.load(apiClient);
  const validate = contracts.response('get', root + '/analytics', 200);
  for (const fault of [
    { model_version: 'unknown' },
    { consideration_usd: 961538.46 },
    { instrument: {} },
    { remaining_cash_flows: [] },
    { dirty_price: 'NaN' },
    { conventions: {} },
    { unexpected: true },
  ]) {
    expect(validate({ ...original, ...fault })).toBe(false);
    expect(zeroAnalyticsSchema.safeParse({ ...original, ...fault }).success).toBe(false);
  }
});
