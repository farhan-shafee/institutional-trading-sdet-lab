import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readConfiguration } from '../../app/server/configuration.js';

const environment = {
  TRADEFLOW_MODE: 'hosted-demo',
  TRADEFLOW_PUBLIC_DEMO: 'on',
  TRADEFLOW_PUBLIC_DEMO_DATABASE_CA: readFileSync('test-data/public-demo/test-ca.pem', 'utf8'),
  TRADEFLOW_PUBLIC_DEMO_DATABASE_URL:
    'postgresql://tf_app:synthetic-app-password@public-postgres.railway.internal:5432/tradeflow_public_demo_0123456789abcdef',
  TRADEFLOW_PUBLIC_DEMO_RECONCILER_URL:
    'postgresql://tf_reconciler:synthetic-reconciler-password@public-postgres.railway.internal:5432/tradeflow_public_demo_0123456789abcdef',
  TRADEFLOW_PUBLIC_DEMO_MAINTENANCE_URL:
    'postgresql://tf_maintenance:synthetic-maintenance-password@public-postgres.railway.internal:5432/tradeflow_public_demo_0123456789abcdef',
};

await test('public post-trade requires explicit activation and preserves the default public profile', () => {
  assert.equal('postTrade' in readConfiguration(environment).publicDemo!, false);
  assert.equal(
    'postTrade' in
      readConfiguration({ ...environment, TRADEFLOW_PUBLIC_POSTTRADE: 'off' }).publicDemo!,
    false,
  );
  assert.equal(
    Reflect.get(
      readConfiguration({ ...environment, TRADEFLOW_PUBLIC_POSTTRADE: 'on' }).publicDemo!,
      'postTrade',
    ),
    true,
  );
});

await test('public post-trade cannot activate outside the complete verified public profile', () => {
  for (const input of [
    { TRADEFLOW_PUBLIC_POSTTRADE: 'on' },
    { ...environment, TRADEFLOW_PUBLIC_POSTTRADE: 'yes' },
    { ...environment, TRADEFLOW_PUBLIC_POSTTRADE: '' },
    { ...environment, TRADEFLOW_PUBLIC_POSTTRADE: 'on', TRADEFLOW_PUBLIC_DEMO: 'off' },
    { ...environment, TRADEFLOW_PUBLIC_POSTTRADE: 'on', TRADEFLOW_MODE: 'local' },
    {
      ...environment,
      TRADEFLOW_PUBLIC_POSTTRADE: 'on',
      TRADEFLOW_PUBLIC_DEMO_DATABASE_CA: undefined,
    },
  ])
    assert.throws(
      () => readConfiguration(input),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes('synthetic-'), false);
        return true;
      },
    );
});
