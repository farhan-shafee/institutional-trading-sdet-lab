import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { request } from '@playwright/test';
import { OpenApiContracts } from '../contract/openapi-validator.js';
import {
  reconciliationReferenceSchema,
  reconciliationDetailSchema,
  reconciliationListSchema,
  reconciliationFindingsSchema,
} from '../../app/domain/workflow/reconciliation.js';
import { reconciliationHttp } from './reconciliation-http-fixture.js';
await test('reconciliation HTTP independently validates owned durable runs, coverage, replay and finding pages', async () => {
  const f = await reconciliationHttp();
  const context = await request.newContext({ baseURL: f.lab.origin });
  try {
    const run = randomUUID(),
      key = randomUUID(),
      path = `${f.root}/reconciliation-runs`;
    const r = await f.lab.request(path, f.token, 'POST', { run_id: run }, key);
    assert.equal(r.status, 201);
    const ref = reconciliationReferenceSchema.parse(await r.json());
    assert.equal(ref.run_id, run);
    const detailResponse = await f.lab.request(`${path}/${run}`, f.token);
    assert.equal(detailResponse.status, 200);
    const detail = reconciliationDetailSchema.parse(await detailResponse.json());
    assert.equal(detail.run.state, 'COMPLETED_CLEAN');
    assert.equal(detail.run.source_watermark, '1');
    assert.equal(detail.run.coverage.length, 4);
    const contracts = await OpenApiContracts.load(context);
    assert.equal(
      contracts.response(
        'post',
        '/api/fixed-income/v1/sandboxes/{sid}/reconciliation-runs',
        201,
      )(ref),
      true,
    );
    const v = contracts.response(
      'get',
      '/api/fixed-income/v1/sandboxes/{sid}/reconciliation-runs/{rid}',
      200,
    );
    assert.equal(v(detail), true, JSON.stringify(v.errors));
    assert.equal(v({ ...detail, run: { ...detail.run, complete: 'yes' } }), false);
    const replay = await f.lab.request(path, f.token, 'POST', { run_id: run }, key);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(await replay.json(), ref);
    const conflict = await f.lab.request(path, f.token, 'POST', { run_id: randomUUID() }, key);
    assert.equal(conflict.status, 409);
    const list = await f.lab.request(path + '?limit=1', f.token);
    assert.equal(list.status, 200);
    assert.equal(reconciliationListSchema.parse(await list.json()).runs.length, 1);
    const findings = await f.lab.request(`${path}/${run}/findings?limit=1`, f.token);
    assert.equal(findings.status, 200);
    assert.equal(reconciliationFindingsSchema.parse(await findings.json()).findings.length, 0);
  } finally {
    await context.dispose();
    await f.close();
  }
});
await test('sandbox-wide idempotency registry prevents financial/reconciliation key collisions atomically in both directions', async () => {
  const f = await reconciliationHttp();
  const { rfqInput } = await import('./rfq-fixture.js');
  const { connection } = await import('./harness.js');
  const reader = await connection('reconciler');
  try {
    const key = randomUUID();
    assert.equal(
      (
        await f.lab.request(
          `${f.root}/reconciliation-runs`,
          f.token,
          'POST',
          { run_id: randomUUID() },
          key,
        )
      ).status,
      201,
    );
    const conflict = await f.lab.request(`${f.root}/rfqs`, f.token, 'POST', rfqInput(), key);
    assert.equal(conflict.status, 409);
    assert.equal(
      ((await conflict.json()) as { error: { code: string } }).error.code,
      'IDEMPOTENCY_KEY_REUSED',
    );
    assert.equal(
      (await reader.query('SELECT * FROM fi.rfqs WHERE sandbox_id=$1', [f.keys.sandbox_id]))
        .rowCount,
      0,
    );
    const other = randomUUID();
    assert.equal(
      (await f.lab.request(`${f.root}/rfqs`, f.token, 'POST', rfqInput(), other)).status,
      201,
    );
    const reverse = await f.lab.request(
      `${f.root}/reconciliation-runs`,
      f.token,
      'POST',
      { run_id: randomUUID() },
      other,
    );
    assert.equal(reverse.status, 409);
    assert.equal(
      ((await reverse.json()) as { error: { code: string } }).error.code,
      'IDEMPOTENCY_KEY_REUSED',
    );
  } finally {
    await reader.end();
    await f.close();
  }
});
await test('reconciliation rejects unsafe bodies/queries and enforces viewer, foreign, rotated and expired ownership boundaries', async () => {
  let clock = 0;
  const f = await reconciliationHttp(undefined, () => clock);
  try {
    const root = `${f.root}/reconciliation-runs`,
      id = randomUUID();
    assert.equal((await f.lab.request(root)).status, 401);
    const foreign = await f.lab.login();
    assert.equal((await f.lab.request(root, foreign)).status, 403);
    assert.equal(
      (await f.lab.request(root, f.token, 'POST', { run_id: id }, randomUUID())).status,
      201,
    );
    const viewer = await f.lab.login(true);
    assert.equal(
      (
        await f.lab.request('/api/fixed-income/v1/sandboxes/recover', viewer, 'POST', {
          sandbox_id: f.keys.sandbox_id,
          capability: f.keys.read_capability,
          scope: 'read',
        })
      ).status,
      200,
    );
    assert.equal((await f.lab.request(`${root}/${id}`, viewer)).status, 200);
    assert.equal(
      (await f.lab.request(root, viewer, 'POST', { run_id: randomUUID() }, randomUUID())).status,
      403,
    );
    assert.equal((await f.lab.request(`${root}/${randomUUID()}`, f.token)).status, 404);
    for (const bad of [
      { run_id: randomUUID(), sql: 'SELECT 1' },
      { run_id: randomUUID(), findings: [] },
      {},
    ])
      assert.equal((await f.lab.request(root, f.token, 'POST', bad, randomUUID())).status, 400);
    for (const query of ['limit=0', 'limit=21', 'limit=1&limit=2', 'bad=1', 'as_of=20'])
      assert.equal((await f.lab.request(root + '?' + query, f.token)).status, 400);
    const { randomBytes } = await import('node:crypto');
    const next = {
      expected_generation: '1',
      read_capability: randomBytes(32).toString('base64url'),
      trade_capability: randomBytes(32).toString('base64url'),
    };
    assert.equal(
      (await f.lab.request(`${f.root}/recovery-keys/rotate`, f.token, 'POST', next, randomUUID()))
        .status,
      200,
    );
    assert.equal((await f.lab.request(root, viewer)).status, 404);
    assert.equal(
      (
        await f.lab.request('/api/fixed-income/v1/sandboxes/recover', f.token, 'POST', {
          sandbox_id: f.keys.sandbox_id,
          capability: next.trade_capability,
          scope: 'trade',
        })
      ).status,
      200,
    );
    clock += 1_800_001;
    assert.equal((await f.lab.request(root, f.token)).status, 403);
    assert.equal((await f.lab.request('/api/orders', f.token)).status, 200);
  } finally {
    await f.close();
  }
});
await test('run and finding keyset pages have no omissions/duplicates and exclude runs requested after the pinned bound', async () => {
  const f = await reconciliationHttp();
  try {
    const root = `${f.root}/reconciliation-runs`,
      ids: string[] = [];
    for (let n = 0; n < 3; n++) {
      const id = randomUUID();
      ids.push(id);
      assert.equal(
        (await f.lab.request(root, f.token, 'POST', { run_id: id }, randomUUID())).status,
        201,
      );
    }
    const first = reconciliationListSchema.parse(
      await (await f.lab.request(root + '?limit=1', f.token)).json(),
    );
    assert.equal(first.as_of, 3);
    const extra = randomUUID();
    assert.equal(
      (await f.lab.request(root, f.token, 'POST', { run_id: extra }, randomUUID())).status,
      201,
    );
    const seen = first.runs.map((r) => r.id);
    let after = first.next_after;
    while (after !== null) {
      const page = reconciliationListSchema.parse(
        await (
          await f.lab.request(`${root}?limit=1&after=${after}&as_of=${first.as_of}`, f.token)
        ).json(),
      );
      assert.equal(page.as_of, 3);
      seen.push(...page.runs.map((r) => r.id));
      after = page.next_after;
    }
    assert.deepEqual(seen, ids);
    assert.equal(new Set(seen).size, 3);
    assert.ok(!seen.includes(extra));
  } finally {
    await f.close();
  }
});
