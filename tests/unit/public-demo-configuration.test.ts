import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readConfiguration } from '../../app/server/configuration.js';

const ca = readFileSync(
  new URL('../../test-data/public-demo/test-ca.pem', import.meta.url),
  'utf8',
);
const environment = {
  TRADEFLOW_MODE: 'hosted-demo',
  TRADEFLOW_PUBLIC_DEMO: 'on',
  TRADEFLOW_PUBLIC_DEMO_DATABASE_CA: ca,
  TRADEFLOW_PUBLIC_DEMO_DATABASE_URL:
    'postgresql://tf_app:synthetic-app-password@public-postgres.railway.internal:5432/tradeflow_public_demo_0123456789abcdef',
  TRADEFLOW_PUBLIC_DEMO_RECONCILER_URL:
    'postgresql://tf_reconciler:synthetic-reconciler-password@public-postgres.railway.internal:5432/tradeflow_public_demo_0123456789abcdef',
  TRADEFLOW_PUBLIC_DEMO_MAINTENANCE_URL:
    'postgresql://tf_maintenance:synthetic-maintenance-password@public-postgres.railway.internal:5432/tradeflow_public_demo_0123456789abcdef',
};

await test('public activation produces three role-specific verified TLS connections with no URL overrides', () => {
  const config = readConfiguration(environment);
  assert.ok('publicDemo' in config, 'The explicit public profile must be present.');
  const profile = config.publicDemo;
  assert.ok(profile);
  assert.equal(profile.app.database, 'tradeflow_public_demo_0123456789abcdef');
  assert.equal(profile.app.user, 'tf_app');
  assert.equal(profile.reconciler.user, 'tf_reconciler');
  assert.equal(profile.maintenance.user, 'tf_maintenance');
  for (const connection of Object.values(profile)) {
    if (!connection || typeof connection !== 'object') continue;
    assert.equal(connection.connectionString, undefined);
    assert.deepEqual(connection.ssl, {
      ca,
      rejectUnauthorized: true,
      servername: 'public-postgres.railway.internal',
    });
  }
});

await test('public secrets are neither parsed nor activated implicitly in the original hosted profile', () => {
  assert.equal('publicDemo' in readConfiguration({ TRADEFLOW_MODE: 'hosted-demo' }), false);
  assert.throws(() => readConfiguration({ ...environment, TRADEFLOW_PUBLIC_DEMO: 'off' }));
  assert.throws(() => readConfiguration({ ...environment, TRADEFLOW_PUBLIC_DEMO: undefined }));
  assert.throws(() => readConfiguration({ ...environment, TRADEFLOW_MODE: 'local' }));
  assert.throws(() => readConfiguration({ ...environment, TRADEFLOW_PUBLIC_DEMO: 'yes' }));
});

await test('public workflow rejects partial roles, mismatched targets and URL-based TLS overrides privately', () => {
  const bad = [
    { TRADEFLOW_PUBLIC_DEMO_DATABASE_CA: undefined },
    { TRADEFLOW_PUBLIC_DEMO_DATABASE_CA: 'invalid-ca-sensitive-marker' },
    { TRADEFLOW_PUBLIC_DEMO_RECONCILER_URL: undefined },
    { TRADEFLOW_PUBLIC_DEMO_MAINTENANCE_URL: undefined },
    {
      TRADEFLOW_PUBLIC_DEMO_DATABASE_URL:
        environment.TRADEFLOW_PUBLIC_DEMO_DATABASE_URL + '?sslmode=no-verify',
    },
    {
      TRADEFLOW_PUBLIC_DEMO_DATABASE_URL:
        environment.TRADEFLOW_PUBLIC_DEMO_DATABASE_URL + '#fragment',
    },
    {
      TRADEFLOW_PUBLIC_DEMO_DATABASE_URL: environment.TRADEFLOW_PUBLIC_DEMO_DATABASE_URL.replace(
        'tf_app:',
        'postgres:',
      ),
    },
    {
      TRADEFLOW_PUBLIC_DEMO_DATABASE_URL: environment.TRADEFLOW_PUBLIC_DEMO_DATABASE_URL.replace(
        'synthetic-app-password',
        '',
      ),
    },
    {
      TRADEFLOW_PUBLIC_DEMO_RECONCILER_URL:
        environment.TRADEFLOW_PUBLIC_DEMO_RECONCILER_URL.replace(':5432/', ':5433/'),
    },
    {
      TRADEFLOW_PUBLIC_DEMO_MAINTENANCE_URL:
        environment.TRADEFLOW_PUBLIC_DEMO_MAINTENANCE_URL.replace(
          '0123456789abcdef',
          'fedcba9876543210',
        ),
    },
    {
      TRADEFLOW_PUBLIC_DEMO_DATABASE_URL: environment.TRADEFLOW_PUBLIC_DEMO_DATABASE_URL.replace(
        'public-postgres.railway.internal',
        'example.com',
      ),
    },
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    { TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres' },
  ];
  for (const override of bad) {
    assert.throws(
      () => readConfiguration({ ...environment, ...override }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes('synthetic-'), false);
        assert.equal(error.message.includes('sensitive-marker'), false);
        return true;
      },
    );
  }
});

await test('public runtime roles require distinct passwords to preserve separate authority', () => {
  assert.throws(() =>
    readConfiguration({
      ...environment,
      TRADEFLOW_PUBLIC_DEMO_MAINTENANCE_URL:
        environment.TRADEFLOW_PUBLIC_DEMO_MAINTENANCE_URL.replace(
          'synthetic-maintenance-password',
          'synthetic-app-password',
        ),
    }),
  );
});

await test('public CA configuration rejects a certificate bundle containing private key material', () => {
  assert.throws(() =>
    readConfiguration({
      ...environment,
      TRADEFLOW_PUBLIC_DEMO_DATABASE_CA:
        ca + '\n-----BEGIN PRIVATE KEY-----\nsynthetic-key-marker\n-----END PRIVATE KEY-----\n',
    }),
  );
});

await test('public profile cannot outlive ownership bounds while original hosted limits remain available', () => {
  for (const override of [
    { TRADEFLOW_SESSION_TTL_SECONDS: '1801' },
    { TRADEFLOW_MAX_SESSIONS: '51' },
  ])
    assert.throws(() => readConfiguration({ ...environment, ...override }));
  assert.doesNotThrow(() =>
    readConfiguration({
      ...environment,
      TRADEFLOW_SESSION_TTL_SECONDS: '1800',
      TRADEFLOW_MAX_SESSIONS: '50',
    }),
  );
  assert.doesNotThrow(() =>
    readConfiguration({
      TRADEFLOW_MODE: 'hosted-demo',
      TRADEFLOW_SESSION_TTL_SECONDS: '3600',
      TRADEFLOW_MAX_SESSIONS: '100',
    }),
  );
});
