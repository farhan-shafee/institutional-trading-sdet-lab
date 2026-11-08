import { test, expect } from '../fixtures/tradeflow.fixture.js';
import { test as anonymous } from '@playwright/test';
import { OpenApiContracts } from '../contract/openapi-validator.js';
import {
  curveAnalyticsSchema,
  curveSnapshotSchema,
} from '../../app/domain/fixed-income-v3/contracts.js';
import { sessionResponseSchema } from '../../app/domain/schemas.js';
import { credentials } from '../../test-data/fixtures/reference-data.js';

const root = '/api/fixed-income/v3';
const fixtureQuery = 'fixture_id=FLAT_V1&as_of_date=2030-01-15';
const query = fixtureQuery + '&instrument_id=SYN-ZERO-2031&par_amount=1000000&z_spread=0';

anonymous(
  'curve snapshot and analytics require a current authenticated session',
  async ({ request }) => {
    for (const path of ['/curves?' + fixtureQuery, '/analytics?' + query]) {
      const response = await request.get(root + path);
      expect(response.status()).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    }
  },
);

test('curve reads satisfy independent OpenAPI and strict runtime wire contracts', async ({
  apiClient,
}) => {
  const contracts = await OpenApiContracts.load(apiClient);
  for (const path of ['/curves', '/analytics']) {
    const response = await apiClient.get(
      root + path + '?' + (path === '/curves' ? fixtureQuery : query),
    );
    expect(response.status()).toBe(200);
    const body: unknown = await response.json();
    const validate = contracts.response('get', root + path, 200);
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    expect(
      (path === '/curves' ? curveSnapshotSchema : curveAnalyticsSchema).safeParse(body).success,
    ).toBe(true);
    if (path === '/analytics')
      expect(body).toMatchObject({
        model_version: 'DISCOUNT_LOG_LINEAR_ACT365F_V1',
        clean_price: '97.0445533549',
        dirty_price: '97.0445533549',
        accrued_interest: '0.0000000000',
        mark_value_usd: '970445.53',
      });
  }
});

anonymous(
  'viewer can read curve snapshots and analytics and then revoke its session',
  async ({ request }) => {
    const login = await request.post('/api/session', { data: credentials.viewer });
    expect(login.status()).toBe(200);
    const session = sessionResponseSchema.parse(await login.json());
    expect(session.user.role).toBe('viewer');
    const headers = { Authorization: 'Bearer ' + session.token };
    try {
      for (const path of ['/curves?' + fixtureQuery, '/analytics?' + query]) {
        const response = await request.get(root + path, { headers });
        expect(response.status()).toBe(200);
        const body: unknown = await response.json();
        expect(
          (path.startsWith('/curves?') ? curveSnapshotSchema : curveAnalyticsSchema).safeParse(body)
            .success,
        ).toBe(true);
      }
    } finally {
      const cleanup = await request.delete('/api/session', { headers });
      expect(cleanup.status()).toBe(204);
    }
  },
);

test('curve marks preserve the owned book and both existing catalogues', async ({
  apiClient,
  orderFactory,
}) => {
  await orderFactory();
  const before = await apiClient.get('/api/orders');
  expect(before.status()).toBe(200);
  const owned: unknown = await before.json();
  const mark = await apiClient.get(root + '/analytics?' + query);
  expect(mark.status()).toBe(200);
  const after = await apiClient.get('/api/orders');
  expect(after.status()).toBe(200);
  expect(await after.json()).toEqual(owned);
  for (const [version, ids] of [
    ['v1', ['SYN-UST-2031', 'SYN-CORP-2031']],
    ['v2', ['SYN-ZERO-2031']],
  ] as const) {
    const catalogue = await apiClient.get('/api/fixed-income/' + version + '/instruments');
    expect(catalogue.status()).toBe(200);
    const body = (await catalogue.json()) as { instruments: { id: string }[] };
    expect(body.instruments.map((i) => i.id)).toEqual(ids);
  }
});

for (const suffix of [
  '&unexpected=x',
  '&__proto__=x',
  '&fixture_id=FLAT_V1',
  '&par_amount=1',
  '&z_spread=0',
  '&clean_price=100',
]) {
  test('curve analytics rejects query suffix ' + suffix, async ({ apiClient }) => {
    const response = await apiClient.get(root + '/analytics?' + query + suffix);
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
}

test('curve domains and malformed snapshot requests fail with safe real HTTP errors', async ({
  apiClient,
}) => {
  for (const path of [
    '/curves',
    '/curves?' + fixtureQuery + '&extra=x',
    '/curves?' + fixtureQuery + '&as_of_date=2030-01-15',
    '/curves?' + fixtureQuery.replace('FLAT_V1', '__proto__'),
    '/analytics?' + query.replace('2030-01-15', '2031-01-15'),
    '/analytics?' + query.replace('SYN-ZERO-2031', 'OTHER'),
    '/analytics?' + query.replace('z_spread=0', 'z_spread=1e-2'),
    '/analytics?' + query.replace('z_spread=0', 'z_spread=1.000000000001'),
    '/analytics?' + query.replace('&z_spread=0', ''),
    '/analytics?' + query.replace('z_spread=0', 'clean_price=0.000000000001'),
  ]) {
    const response = await apiClient.get(root + path);
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  }
});

test('curve wire validators reject lost or mismatched identity and malformed mark fields', async ({
  apiClient,
}) => {
  const response = await apiClient.get(root + '/analytics?' + query);
  expect(response.status()).toBe(200);
  const original = (await response.json()) as Record<string, unknown>;
  const contracts = await OpenApiContracts.load(apiClient);
  const validate = contracts.response('get', root + '/analytics', 200);
  for (const fault of [
    { model_version: 'unknown' },
    { mark_value_usd: 970445.53 },
    { definition_version: 'UNKNOWN' },
    { instrument_id: 'SYN-CORP-2031' },
    { curve: {} },
    { dirty_price: 'NaN' },
    { conventions: {} },
    { remaining_cash_flows: [] },
    { unexpected: true },
  ]) {
    expect(validate({ ...original, ...fault })).toBe(false);
    expect(curveAnalyticsSchema.safeParse({ ...original, ...fault }).success).toBe(false);
  }
});
