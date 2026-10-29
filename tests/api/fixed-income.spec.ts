import { test, expect } from '../fixtures/tradeflow.fixture.js';
import { test as anonymous } from '@playwright/test';
import { OpenApiContracts } from '../contract/openapi-validator.js';
import {
  analyticsResponseSchema,
  instrumentsResponseSchema,
} from '../../app/domain/fixed-income/analytics.js';
const root = '/api/fixed-income/v1';
const query =
  'instrument_id=SYN-UST-2031&settlement_date=2026-10-15&par_amount=1000000&clean_price=99.875';
anonymous('fixed-income endpoints require an existing session', async ({ request }) => {
  for (const path of ['/instruments', `/analytics?${query}`]) {
    const r = await request.get(root + path);
    expect(r.status()).toBe(401);
    expect(await r.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  }
});
test('fixed-income catalogue and analytics satisfy independent OpenAPI and runtime contracts', async ({
  apiClient,
}) => {
  const contracts = await OpenApiContracts.load(apiClient);
  for (const path of ['/instruments', '/analytics']) {
    const r = await apiClient.get(root + path + (path === '/analytics' ? `?${query}` : ''));
    expect(r.status()).toBe(200);
    const body: unknown = await r.json();
    const validate = contracts.response('get', root + path, 200);
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    expect(
      (path === '/instruments' ? instrumentsResponseSchema : analyticsResponseSchema).safeParse(
        body,
      ).success,
    ).toBe(true);
    if (path === '/analytics')
      expect(body).toMatchObject({
        accrued_interest: '1.0000000000',
        consideration_usd: '1008750.00',
      });
  }
});
test('analytical reads preserve the entire owned equity book', async ({
  apiClient,
  orderFactory,
}) => {
  await orderFactory();
  const before = (await (await apiClient.get('/api/orders')).json()) as unknown;
  expect((await apiClient.get(`${root}/analytics?${query}`)).status()).toBe(200);
  expect(await (await apiClient.get('/api/orders')).json()).toEqual(before);
});
for (const suffix of [
  '&unexpected=x',
  '&__proto__=x',
  '&par_amount=1',
  '&yield=0.04',
  '&clean_price=99.875',
]) {
  test(`strict analytics query rejects ${suffix}`, async ({ apiClient }) => {
    const r = await apiClient.get(`${root}/analytics?${query}${suffix}`);
    expect(r.status()).toBe(400);
    expect(await r.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
}
test('catalogue rejects query fields and analytics errors preserve safe JSON', async ({
  apiClient,
}) => {
  expect((await apiClient.get(`${root}/instruments?x=1`)).status()).toBe(400);
  for (const bad of [
    query.replace('2026-10-15', '2031-01-15'),
    query.replace('SYN-UST-2031', 'unknown'),
    query.replace('99.875', 'NaN'),
  ]) {
    const r = await apiClient.get(`${root}/analytics?${bad}`);
    expect(r.status()).toBe(400);
    expect(await r.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid fixed-income query; check instrument, date, units and supported ranges.',
      },
    });
  }
});

test('independent financial wire contract rejects malformed successful response bodies', async ({
  apiClient,
}) => {
  const response = await apiClient.get(`${root}/analytics?${query}`);
  expect(response.status()).toBe(200);
  const original = (await response.json()) as Record<string, unknown>;
  const contracts = await OpenApiContracts.load(apiClient);
  const validate = contracts.response('get', root + '/analytics', 200);
  for (const fault of [
    { yield: 0.04 },
    { dirty_price: 'NaN' },
    { conventions: {} },
    { settlement_date: '2027-02-29' },
    { unexpected: true },
  ]) {
    const broken = { ...original, ...fault };
    expect(validate(broken)).toBe(false);
    expect(analyticsResponseSchema.safeParse(broken).success).toBe(false);
  }
});
