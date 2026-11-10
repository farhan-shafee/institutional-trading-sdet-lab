import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { publicPostTradeHttp, publicExecution } from './http-fixture.js';
import { request } from '@playwright/test';
import { OpenApiContracts } from '../contract/openapi-validator.js';

await test('public schema10 preserves original reconciliation and declares its exact physical schema and bounded scope', async () => {
  const lab = await publicPostTradeHttp();
  const client = await request.newContext({ baseURL: lab.origin });
  try {
    const contracts = await OpenApiContracts.load(client);
    const { token, root } = await lab.workspace();
    assert.equal(
      (
        await lab.request(
          root + '/posttrade/initialize',
          token,
          'POST',
          { economic_start_date: '2030-01-15' },
          randomUUID(),
        )
      ).status,
      201,
    );
    const execution = await publicExecution(lab, token, root);
    assert.equal(
      (
        await lab.request(
          root + '/posttrade/executions/' + execution + '/register',
          token,
          'POST',
          {},
          randomUUID(),
        )
      ).status,
      201,
    );
    const requested = await lab.request(
      root + '/reconciliation-runs',
      token,
      'POST',
      { run_id: randomUUID() },
      randomUUID(),
    );
    assert.equal(requested.status, 201, JSON.stringify(await requested.clone().json()));
    const ref = (await requested.json()) as { run_id: string };
    const response = await lab.request(root + '/reconciliation-runs/' + ref.run_id, token);
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      run: {
        state: string;
        total_findings: number;
        source_metadata: {
          engine_version: string;
          schema_revision: number;
          schema_checksums: unknown[];
          verification_scope: string;
        };
      };
    };
    assert.equal(result.run.state, 'COMPLETED_CLEAN');
    assert.equal(result.run.total_findings, 0);
    assert.equal(result.run.source_metadata.engine_version, 'reconciliation-public-posttrade-v1');
    assert.equal(result.run.source_metadata.schema_revision, 10);
    assert.equal(result.run.source_metadata.schema_checksums.length, 10);
    assert.equal(result.run.source_metadata.verification_scope, 'RAW_WORKFLOW_BASE_8');
    const validate = contracts.response(
      'get',
      '/api/fixed-income/v1/sandboxes/{sid}/reconciliation-runs/{rid}',
      200,
    );
    assert.equal(validate(result), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...result, invented_financial_verification: true }), false);
    const status = await lab.request('/api/public-demo/posttrade/status', token);
    assert.equal(status.status, 200);
    const statusContract = contracts.response('get', '/api/public-demo/posttrade/status', 200);
    assert.equal(statusContract(await status.json()), true, JSON.stringify(statusContract.errors));
  } finally {
    await client.dispose();
    await lab.close();
  }
});
