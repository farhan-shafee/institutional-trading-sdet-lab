import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { owner, connection } from '../postgres/harness.js';
import { httpLab } from '../postgres/http.js';
import { readConfiguration } from '../../app/server/configuration.js';
import { PostTradeWorkflowDatabase } from '../../app/persistence/postgres/post-trade-workflow.js';
import type { TransactionHooks } from '../../app/persistence/postgres/workflow.js';
import { rfqInput, type RfqDetail } from '../postgres/rfq-fixture.js';

export async function retireHttpSandbox(id: string): Promise<void> {
  const admin = await connection('admin'),
    maintenance = await connection('maintenance');
  try {
    await admin.query(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
      [id],
    );
    await maintenance.query('SELECT fi_control.purge_expired()');
  } finally {
    await admin.end();
    await maintenance.end();
  }
}

export async function postTradeHttp(hooks: TransactionHooks = {}) {
  const cfg = await owner();
  assert.ok(cfg.appUrl);
  const database = new PostTradeWorkflowDatabase(cfg.appUrl, hooks);
  const configuration = readConfiguration({
    TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
    TRADEFLOW_FIXED_INCOME_DATABASE_URL: cfg.appUrl,
  });
  const lab = await httpLab(configuration, database),
    token = await lab.login();
  const keys = {
    sandbox_id: randomUUID(),
    read_capability: randomBytes(32).toString('base64url'),
    trade_capability: randomBytes(32).toString('base64url'),
  };
  const root = '/api/fixed-income/v1/sandboxes/' + keys.sandbox_id,
    creationKey = randomUUID();
  assert.equal(
    (await lab.request('/api/fixed-income/v1/sandboxes', token, 'POST', keys, creationKey)).status,
    201,
  );
  async function execution(
    par = '100.00',
    side = 'BUY',
    instrument = 'SYN-UST-2031',
    date = '2030-01-15',
  ) {
    const input = { ...rfqInput(side, instrument), par_amount: par, settlement_date: date };
    assert.equal(
      (await lab.request(root + '/rfqs', token, 'POST', input, randomUUID())).status,
      201,
    );
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
    return { execution_id, order };
  }
  return {
    lab,
    database,
    token,
    keys,
    root,
    path: root + '/posttrade',
    creationKey,
    execution,
    async close() {
      if (lab.server.listening) await lab.close();
      await retireHttpSandbox(keys.sandbox_id);
    },
  };
}
