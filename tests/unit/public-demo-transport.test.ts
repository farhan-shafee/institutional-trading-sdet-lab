import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { VerificationDatabase } from '../../app/server/reconciliation/database.js';

const tls = {
  ca: readFileSync(new URL('../../test-data/public-demo/test-ca.pem', import.meta.url), 'utf8'),
  rejectUnauthorized: true,
  servername: 'public-postgres.railway.internal',
};

await test('financial and read-only reconciliation pools retain explicit verified transport and original resource bounds', async () => {
  const target = {
    host: 'public-postgres.railway.internal',
    port: 5432,
    database: 'tradeflow_public_demo_0123456789abcdef',
    user: 'tf_app',
    password: 'synthetic-only-password',
    ssl: tls,
  };
  const writer = new WorkflowDatabase(target);
  const reader = new VerificationDatabase({ ...target, user: 'tf_reconciler' });
  try {
    assert.deepEqual(writer.pool.options.ssl, tls);
    assert.deepEqual(reader.pool.options.ssl, tls);
    assert.equal(writer.pool.options.user, 'tf_app');
    assert.equal(reader.pool.options.user, 'tf_reconciler');
    assert.equal(writer.pool.options.connectionString, undefined);
    assert.equal(reader.pool.options.connectionString, undefined);
    assert.equal(writer.pool.options.max, 4);
    assert.equal(reader.pool.options.max, 2);
    assert.equal(writer.pool.options.connectionTimeoutMillis, 500);
    assert.equal(reader.pool.options.connectionTimeoutMillis, 500);
    assert.equal(writer.pool.options.query_timeout, 2000);
    assert.equal(reader.pool.options.query_timeout, 2000);
  } finally {
    await writer.close();
    await reader.close();
  }
});
