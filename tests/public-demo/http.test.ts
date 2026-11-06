import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { request as nodeRequest } from 'node:http';
import { sandboxBodySchema } from '../../app/domain/workflow/contracts.js';
import { connection } from './database.js';
import { publicHttp } from './http-fixture.js';
import { request as playwrightRequest } from '@playwright/test';
import { OpenApiContracts } from '../contract/openapi-validator.js';

await test('concurrent public starts retain one private workspace and its exact bootstrap response', async () => {
  const f = await publicHttp();
  try {
    const token = await f.login(),
      key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        f.request('/api/public-demo/workspace', token, 'POST', {}, key),
      ),
    );
    assert.deepEqual(
      responses.map((r) => r.status),
      [201, 201, 201, 201],
    );
    const bodies = await Promise.all(responses.map((r) => r.json()));
    const parsed = sandboxBodySchema.parse(bodies[0]);
    assert.equal(parsed.scope, 'trade');
    assert.equal(parsed.sandbox.commit_seq, '1');
    assert.equal(
      Date.parse(parsed.sandbox.write_expires_at) - Date.parse(parsed.sandbox.created_at),
      1_800_000,
    );
    assert.equal(
      Date.parse(parsed.sandbox.retained_until) - Date.parse(parsed.sandbox.created_at),
      3_600_000,
    );
    for (const body of bodies) assert.deepEqual(body, bodies[0]);
    assert.equal(
      responses.filter((r) => r.headers.get('idempotency-replayed') === 'true').length,
      3,
    );
    assert.equal(
      (await f.request('/api/public-demo/workspace', token, 'POST', {}, randomUUID())).status,
      409,
    );
    const admin = await connection('admin');
    try {
      assert.equal(
        (await admin.query<{ count: number }>('SELECT count(*)::int AS count FROM fi.sandboxes'))
          .rows[0]!.count,
        1,
      );
    } finally {
      await admin.end();
    }
  } finally {
    await f.close();
  }
});

await test('published OpenAPI independently validates actual public status and workspace responses', async () => {
  const f = await publicHttp();
  const wire = await playwrightRequest.newContext({ baseURL: f.origin });
  try {
    const contract = await OpenApiContracts.load(wire),
      token = await f.login();
    const status = await f.request('/api/public-demo/status', token);
    assert.equal(status.status, 200);
    assert.equal(
      contract.response('get', '/api/public-demo/status', 200)(await status.json()),
      true,
    );
    const started = await f.request('/api/public-demo/workspace', token, 'POST', {}, randomUUID());
    assert.equal(started.status, 201);
    const body: unknown = await started.json();
    const validate = contract.response('post', '/api/public-demo/workspace', 201);
    assert.equal(validate(body), true);
    assert.equal(
      validate({ ...(body as object), read_capability: 'never-a-public-response' }),
      false,
    );
    const current = await f.request('/api/public-demo/workspace', token);
    assert.equal(current.status, 200);
    assert.equal(
      contract.response('get', '/api/public-demo/workspace', 200)(await current.json()),
      true,
    );
  } finally {
    await wire.dispose();
    await f.close();
  }
});

await test('public persistence transport failure remains explicit while equities and stateless analytics continue', async () => {
  const f = await publicHttp();
  try {
    const token = await f.login();
    const started = await f.request('/api/public-demo/workspace', token, 'POST', {}, randomUUID());
    assert.equal(started.status, 201);
    const body = sandboxBodySchema.parse(await started.json());
    await f.disconnectPersistence();
    assert.equal(
      (await f.request(`/api/fixed-income/v1/sandboxes/${body.sandbox.id}`, token)).status,
      503,
    );
    const status = await f.request('/api/public-demo/status', token);
    assert.equal(status.status, 200);
    assert.equal(((await status.json()) as { state: string }).state, 'unavailable');
    assert.equal((await f.request('/api/orders', token)).status, 200);
    assert.equal(
      (
        await f.request(
          '/api/fixed-income/v1/analytics?instrument_id=SYN-UST-2031&settlement_date=2026-10-15&par_amount=1000000&yield=0.04',
          token,
        )
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});

await test('independent public visitors cannot read each others records and viewer setup supplies read scope', async () => {
  const f = await publicHttp();
  try {
    const trader = await f.login(),
      viewer = await f.login(true);
    const a = await f.request('/api/public-demo/workspace', trader, 'POST', {}, randomUUID());
    const b = await f.request('/api/public-demo/workspace', viewer, 'POST', {}, randomUUID());
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    const first = sandboxBodySchema.parse(await a.json()),
      second = sandboxBodySchema.parse(await b.json());
    assert.equal(first.scope, 'trade');
    assert.equal(second.scope, 'read');
    assert.notEqual(first.sandbox.id, second.sandbox.id);
    const foreign = await f.request(`/api/fixed-income/v1/sandboxes/${first.sandbox.id}`, viewer);
    assert.equal(foreign.status, 404);
    assert.equal(
      ((await foreign.json()) as { error: { code: string } }).error.code,
      'SANDBOX_NOT_FOUND',
    );
    const denied = await f.request(
      `/api/fixed-income/v1/sandboxes/${second.sandbox.id}/rfqs`,
      viewer,
      'POST',
      {},
      randomUUID(),
    );
    assert.equal(denied.status, 403);
    for (const path of [
      '/api/fixed-income/v1/sandboxes',
      '/api/fixed-income/v1/sandboxes/recover',
      `/api/fixed-income/v1/sandboxes/${first.sandbox.id}/recovery-keys/rotate`,
    ])
      assert.equal((await f.request(path, trader, 'POST', {}, randomUUID())).status, 404);
    assert.equal(
      (
        await f.request(
          '/api/public-demo/workspace',
          trader,
          'POST',
          { trade_capability: 'never-accept-browser-ownership' },
          randomUUID(),
        )
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});

await test('public bootstrap retains the original intent after a committed response is lost', async () => {
  let first = true;
  const f = await publicHttp({
    afterCommit: () => {
      if (first) {
        first = false;
        throw new Error('Synthetic lost commit response');
      }
    },
  });
  try {
    const token = await f.login(),
      key = randomUUID();
    const lost = await f.request('/api/public-demo/workspace', token, 'POST', {}, key);
    assert.equal(lost.status, 503);
    assert.equal(
      ((await lost.json()) as { error: { code: string } }).error.code,
      'OUTCOME_UNKNOWN',
    );
    const recovered = await f.request('/api/public-demo/workspace', token, 'POST', {}, key);
    assert.equal(recovered.status, 201);
    assert.equal(recovered.headers.get('idempotency-replayed'), 'true');
    const admin = await connection('admin');
    try {
      assert.equal(
        (await admin.query<{ count: number }>('SELECT count(*)::int AS count FROM fi.sandboxes'))
          .rows[0]!.count,
        1,
      );
    } finally {
      await admin.end();
    }
  } finally {
    await f.close();
  }
});

await test('public session expiry denies financial access without extending the original session', async () => {
  let now = 0;
  const f = await publicHttp(undefined, () => now);
  try {
    const token = await f.login();
    now = 1_700_000;
    const started = await f.request('/api/public-demo/workspace', token, 'POST', {}, randomUUID());
    assert.equal(started.status, 201);
    const body = sandboxBodySchema.parse(await started.json());
    now = 1_800_000;
    assert.equal(
      (await f.request(`/api/fixed-income/v1/sandboxes/${body.sandbox.id}`, token)).status,
      401,
    );
    assert.equal(
      (await f.request('/api/public-demo/workspace', token, 'POST', {}, randomUUID())).status,
      401,
    );
  } finally {
    await f.close();
  }
});

await test('logout during an unfinished public bootstrap body prevents allocation', async () => {
  const f = await publicHttp();
  try {
    const token = await f.login();
    let observed!: () => void;
    const reached = new Promise<void>((resolve) => {
      observed = resolve;
    });
    f.server.once('request', () => observed());
    let client!: ReturnType<typeof nodeRequest>;
    const result = new Promise<number>((resolve, reject) => {
      client = nodeRequest(
        f.origin + '/api/public-demo/workspace',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': '2',
            'Idempotency-Key': randomUUID(),
          },
        },
        (r) => {
          r.resume();
          r.once('end', () => resolve(r.statusCode!));
        },
      );
      client.on('error', reject);
      client.write('{');
    });
    await reached;
    assert.equal((await f.request('/api/session', token, 'DELETE')).status, 204);
    client.end('}');
    assert.equal(await result, 401);
    const admin = await connection('admin');
    try {
      assert.equal(
        (await admin.query<{ count: number }>('SELECT count(*)::int AS count FROM fi.sandboxes'))
          .rows[0]!.count,
        0,
      );
    } finally {
      await admin.end();
    }
  } finally {
    await f.close();
  }
});
