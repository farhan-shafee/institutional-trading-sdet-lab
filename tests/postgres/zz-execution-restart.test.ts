import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { restartOwnedPostgres } from '../../scripts/owned-postgres.js';
import { executionHttp } from './execution-http-fixture.js';
import { orderDetailSchema, positionsSchema } from '../../app/domain/workflow/execution.js';
await test('database stop/restart preserves exact committed executions and positions and never falls back to memory', async () => {
  const f = await executionHttp();
  try {
    assert.equal(
      (
        await f.lab.request(
          `${f.path}/acknowledgment`,
          f.token,
          'POST',
          { expected_version: '1' },
          randomUUID(),
        )
      ).status,
      200,
    );
    const input = {
        expected_version: '2',
        execution_id: randomUUID(),
        source_event_id: randomUUID(),
        par_amount: '40.00',
      },
      key = randomUUID();
    const r = await f.lab.request(`${f.path}/executions`, f.token, 'POST', input, key);
    assert.equal(r.status, 201);
    const original: unknown = await r.json();
    const detail = orderDetailSchema.parse(await (await f.lab.request(f.path, f.token)).json()),
      positions = positionsSchema.parse(
        await (await f.lab.request(`${f.root}/positions`, f.token)).json(),
      );
    await restartOwnedPostgres(process.env.TF_DB_OWNER_FILE!, async () => {
      for (const path of [f.path, `${f.root}/positions`])
        assert.equal((await f.lab.request(path, f.token)).status, 503);
      assert.equal(
        (await f.lab.request(`${f.path}/executions`, f.token, 'POST', input, key)).status,
        503,
      );
      assert.equal((await f.lab.request('/api/orders', f.token)).status, 200);
    });
    assert.deepEqual(
      orderDetailSchema.parse(await (await f.lab.request(f.path, f.token)).json()),
      detail,
    );
    assert.deepEqual(
      positionsSchema.parse(await (await f.lab.request(`${f.root}/positions`, f.token)).json()),
      positions,
    );
    const replay = await f.lab.request(`${f.path}/executions`, f.token, 'POST', input, key);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(await replay.json(), original);
  } finally {
    await f.close();
  }
});
