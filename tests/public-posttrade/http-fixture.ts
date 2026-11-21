import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  imageMode,
  imageOwner,
  connection,
  freshNativeApplication,
} from '../public-demo/database.js';
import { readConfiguration } from '../../app/server/configuration.js';
import { PublicPostTradeWorkflowDatabase } from '../../app/persistence/postgres/public-post-trade-workflow.js';
import type { TransactionHooks } from '../../app/persistence/postgres/workflow.js';
import { httpLab } from '../postgres/http.js';
import { rfqInput, type RfqDetail } from '../postgres/rfq-fixture.js';
import { sandboxBodySchema } from '../../app/domain/workflow/contracts.js';
import type { RunnerHooks } from '../../app/server/reconciliation/runner.js';

export async function cleanupPublicPostTradeGraphs(): Promise<void> {
  const admin = await connection('admin'),
    maintenance = await connection('maintenance');
  try {
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      "UPDATE fi.reconciliation_runs SET requested_at=requested_at-interval '1 minute',started_at=started_at-interval '1 minute',lease_expires_at=clock_timestamp()-interval '1 second' WHERE state IN ('REQUESTED','RUNNING')",
    );
    await admin.query('COMMIT');
    await admin.query(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days'",
    );
    await maintenance.query('SELECT fi_control.purge_public_demo_expired()');
  } finally {
    await admin.end();
    await maintenance.end();
  }
}

export async function publicPostTradeBrowser() {
  if (!imageMode) throw new Error('Owned public post-trade image required.');
  const metadata = await imageOwner();
  if (!metadata.nativeOrigin) return publicPostTradeHttp(); // Targeted --verify-ui only; full gate supplies the native image.
  await freshNativeApplication();
  return { origin: metadata.nativeOrigin, close: cleanupPublicPostTradeGraphs };
}

export async function publicPostTradeHttp(
  hooks: TransactionHooks = {},
  now?: () => number,
  reconciliationHooks?: RunnerHooks,
) {
  if (!imageMode) throw new Error('Owned public post-trade TLS image required.');
  const metadata = await imageOwner();
  const configuration = readConfiguration({
    TRADEFLOW_MODE: 'hosted-demo',
    TRADEFLOW_HOST: '127.0.0.1',
    TRADEFLOW_PUBLIC_DEMO: 'on',
    TRADEFLOW_PUBLIC_POSTTRADE: 'on',
    TRADEFLOW_PUBLIC_DEMO_DATABASE_CA: metadata.ca,
    TRADEFLOW_PUBLIC_DEMO_DATABASE_URL: metadata.appUrl,
    TRADEFLOW_PUBLIC_DEMO_RECONCILER_URL: metadata.reconcilerUrl,
    TRADEFLOW_PUBLIC_DEMO_MAINTENANCE_URL: metadata.maintenanceUrl,
  });
  assert.ok(configuration.publicDemo);
  // Adapt only TCP routing; CA and private hostname verification are unchanged.
  for (const role of ['app', 'reconciler', 'maintenance'] as const)
    configuration.publicDemo[role].host = '127.0.0.1';
  const database = new PublicPostTradeWorkflowDatabase(configuration.publicDemo.app, hooks);
  const lab = await httpLab(configuration, database, now, reconciliationHooks);
  return {
    ...lab,
    database,
    async workspace(viewer = false) {
      const token = await lab.login(viewer);
      const response = await lab.request(
        '/api/public-demo/workspace',
        token,
        'POST',
        {},
        randomUUID(),
      );
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
      const body = sandboxBodySchema.parse(await response.json());
      return { token, body, root: '/api/fixed-income/v1/sandboxes/' + body.sandbox.id };
    },
    async close() {
      await lab.close();
      await cleanupPublicPostTradeGraphs();
    },
  };
}

export async function publicExecution(
  lab: Awaited<ReturnType<typeof publicPostTradeHttp>>,
  token: string,
  root: string,
  par = '100.00',
  side = 'BUY',
  instrument = 'SYN-UST-2031',
) {
  const input = { ...rfqInput(side, instrument), par_amount: par, settlement_date: '2030-01-15' };
  assert.equal((await lab.request(root + '/rfqs', token, 'POST', input, randomUUID())).status, 201);
  const quoted = await lab.request(
    root + '/rfqs/' + input.rfq_id + '/dealer-responses',
    token,
    'POST',
    { expected_version: '1', dealer_id: 'ATLAS', response: 'QUOTE' },
    randomUUID(),
  );
  assert.equal(quoted.status, 200);
  const detail = (await quoted.json()) as RfqDetail;
  const accepted = await lab.request(
    root + '/rfqs/' + input.rfq_id + '/accept',
    token,
    'POST',
    { expected_version: '2', quote_id: detail.quotes[0]!.id },
    randomUUID(),
  );
  assert.equal(accepted.status, 201);
  const order = ((await accepted.json()) as RfqDetail).order!.id;
  assert.equal(
    (
      await lab.request(
        root + '/orders/' + order + '/acknowledgment',
        token,
        'POST',
        { expected_version: '1' },
        randomUUID(),
      )
    ).status,
    200,
  );
  const execution_id = randomUUID();
  assert.equal(
    (
      await lab.request(
        root + '/orders/' + order + '/executions',
        token,
        'POST',
        { expected_version: '2', execution_id, source_event_id: randomUUID(), par_amount: par },
        randomUUID(),
      )
    ).status,
    201,
  );
  return execution_id;
}
