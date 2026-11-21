import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PublicPostTradeWorkflowDatabase } from '../../app/persistence/postgres/public-post-trade-workflow.js';
import { WorkflowRoutes } from '../../app/server/fixed-income-workflow/routes.js';

const target = {
  host: 'public-postgres.railway.internal',
  database: 'tradeflow_public_demo_0123456789abcdef',
  user: 'tf_app',
  password: 'synthetic-app-password',
  ssl: {
    ca: readFileSync('test-data/public-demo/test-ca.pem', 'utf8'),
    rejectUnauthorized: true,
    servername: 'public-postgres.railway.internal',
  },
};

await test('hosted post-trade refuses authority, identity and TLS overrides before opening a pool', () => {
  for (const override of [
    { connectionString: 'postgresql://tf_app:synthetic-secret@example.com/anything' },
    { user: 'tf_owner' },
    { database: 'tradeflow_local_0123456789abcdef' },
    { ssl: false },
    { ssl: { ...target.ssl, rejectUnauthorized: false } },
    { ssl: { ...target.ssl, servername: 'example.com' } },
    { ssl: { ...target.ssl, checkServerIdentity: () => undefined } },
    { ssl: { ...target.ssl, ca: target.ssl.ca + '\nPRIVATE KEY' } },
  ])
    assert.throws(() => new PublicPostTradeWorkflowDatabase({ ...target, ...override }));
});

await test('a hosted database class alone does not activate financial routes', async () => {
  const database = new PublicPostTradeWorkflowDatabase(target);
  const off = new WorkflowRoutes(target, undefined, database);
  const on = new WorkflowRoutes(
    target,
    undefined,
    database,
    undefined,
    undefined,
    'public-posttrade-v1',
  );
  try {
    assert.equal(off.postTrade, undefined);
    assert.ok(on.postTrade);
  } finally {
    await off.close();
    await on.close();
  }
});
