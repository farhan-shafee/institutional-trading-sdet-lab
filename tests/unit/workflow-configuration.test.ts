import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfiguration, ConfigurationError } from '../../app/server/configuration.js';

const database = 'postgresql://tf_app@127.0.0.1:55472/tradeflow_local_0123456789abcdef';
await test('workflow defaults off without requiring or parsing a database URL', () => {
  const config = readConfiguration({ TRADEFLOW_FIXED_INCOME_DATABASE_URL: 'unavailable' });
  assert.deepEqual(config, { mode: 'local', host: '127.0.0.1', port: 3000 });
});
await test('explicit local PostgreSQL workflow configuration retains the guarded URL', () => {
  const config = readConfiguration({
    TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
    TRADEFLOW_FIXED_INCOME_DATABASE_URL: database,
  });
  assert.equal(config.mode, 'local');
  assert.equal(config.workflow?.databaseUrl, database);
});
await test('workflow refuses hosted mode, external targets, wrong roles and unknown modes', () => {
  for (const env of [
    {
      TRADEFLOW_MODE: 'hosted-demo',
      TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
      TRADEFLOW_FIXED_INCOME_DATABASE_URL: database,
    },
    {
      TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
      TRADEFLOW_FIXED_INCOME_DATABASE_URL: database.replace('127.0.0.1', 'example.com'),
    },
    {
      TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
      TRADEFLOW_FIXED_INCOME_DATABASE_URL: database.replace('tf_app', 'postgres'),
    },
    { TRADEFLOW_FIXED_INCOME_WORKFLOW: 'yes' },
    { TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres' },
  ])
    assert.throws(() => readConfiguration(env), ConfigurationError);
});
