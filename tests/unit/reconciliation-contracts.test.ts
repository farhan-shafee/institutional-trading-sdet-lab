import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  requestReconciliationSchema,
  reconciliationReportSchema,
} from '../../app/domain/workflow/reconciliation.js';
await test('reconciliation requests cannot accept SQL, totals, credentials or arbitrary report data', () => {
  const input = { run_id: randomUUID().toUpperCase() };
  assert.equal(requestReconciliationSchema.parse(input).run_id, input.run_id.toLowerCase());
  for (const key of ['sql', 'findings', 'trade_capability', 'reconciler_url'])
    assert.equal(
      requestReconciliationSchema.safeParse({ ...input, [key]: 'forbidden' }).success,
      false,
    );
});
await test('a clean report requires complete declared coverage and an explicit historical snapshot', () => {
  assert.equal(
    reconciliationReportSchema.safeParse({
      status: 'COMPLETED_CLEAN',
      snapshot: null,
      coverage: [],
      findings: [],
      total_findings: 0,
      failure_reason: null,
    }).success,
    false,
  );
});
await test('server-only reconciler configuration is optional and restricted to the exact owned database', async () => {
  const { readConfiguration } = await import('../../app/server/configuration.js');
  const base = {
    TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
    TRADEFLOW_FIXED_INCOME_DATABASE_URL:
      'postgresql://tf_app:synthetic@127.0.0.1:5432/tradeflow_local_0123456789abcdef',
  };
  const url =
    'postgresql://tf_reconciler:synthetic@127.0.0.1:5432/tradeflow_local_0123456789abcdef';
  assert.equal(
    readConfiguration({ ...base, TRADEFLOW_FIXED_INCOME_RECONCILER_URL: url }).workflow
      ?.reconcilerUrl,
    url,
  );
  assert.equal(readConfiguration({ ...base }).workflow?.reconcilerUrl, undefined);
  for (const bad of [
    url.replace('tf_reconciler', 'tf_owner'),
    url.replace('5432', '5433'),
    url.replace('0123456789abcdef', 'fedcba9876543210'),
    url.replace('127.0.0.1', 'localhost'),
  ])
    assert.throws(() => readConfiguration({ ...base, TRADEFLOW_FIXED_INCOME_RECONCILER_URL: bad }));
  assert.equal(
    readConfiguration({ TRADEFLOW_FIXED_INCOME_RECONCILER_URL: 'invalid-but-off' }).workflow,
    undefined,
  );
});
