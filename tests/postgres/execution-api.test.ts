import type { httpLab as HttpLab } from './http.js';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { request } from '@playwright/test';
import { OpenApiContracts } from '../contract/openapi-validator.js';
import { executionHttp } from './execution-http-fixture.js';
import {
  orderDetailSchema,
  orderCommandResultSchema,
  positionsSchema,
} from '../../app/domain/workflow/execution.js';
await test('actual order lifecycle HTTP responses satisfy independent OpenAPI and runtime contracts', async () => {
  const f = await executionHttp();
  const context = await request.newContext({ baseURL: f.lab.origin });
  try {
    const contracts = await OpenApiContracts.load(context);
    const initial = await f.lab.request(f.path, f.token);
    assert.equal(initial.status, 200);
    const detail = orderDetailSchema.parse(await initial.json());
    assert.equal(detail.lifecycle.status, 'PENDING_ACK');
    const validate = contracts.response(
      'get',
      '/api/fixed-income/v1/sandboxes/{sid}/orders/{oid}',
      200,
    );
    assert.equal(validate(detail), true, JSON.stringify(validate.errors));
    assert.equal(
      validate({ ...detail, lifecycle: { ...detail.lifecycle, executed_cents: 0 } }),
      false,
    );
    const ack = await f.lab.request(
      `${f.path}/acknowledgment`,
      f.token,
      'POST',
      { expected_version: '1' },
      randomUUID(),
    );
    assert.equal(ack.status, 200);
    const acked = orderCommandResultSchema.parse(await ack.json());
    assert.equal(acked.lifecycle.status, 'NEW');
    assert.equal(
      contracts.response(
        'post',
        '/api/fixed-income/v1/sandboxes/{sid}/orders/{oid}/acknowledgment',
        200,
      )(acked),
      true,
    );
    const input = {
        expected_version: '2',
        execution_id: randomUUID(),
        source_event_id: randomUUID(),
        par_amount: '40',
      },
      key = randomUUID();
    const fill = await f.lab.request(`${f.path}/executions`, f.token, 'POST', input, key);
    assert.equal(fill.status, 201);
    const filled = orderCommandResultSchema.parse(await fill.json());
    assert.equal(
      contracts.response(
        'post',
        '/api/fixed-income/v1/sandboxes/{sid}/orders/{oid}/executions',
        201,
      )(filled),
      true,
    );
    const replay = await f.lab.request(
      `${f.path}/executions`,
      f.token,
      'POST',
      { ...input, par_amount: '40.00' },
      key,
    );
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(await replay.json(), filled);
    const position = await f.lab.request(`${f.root}/positions`, f.token);
    assert.equal(position.status, 200);
    const p = positionsSchema.parse(await position.json());
    assert.equal(p.positions[0]?.signed_par, '40.00');
    assert.equal(
      contracts.response('get', '/api/fixed-income/v1/sandboxes/{sid}/positions', 200)(p),
      true,
    );
    const cid = randomUUID();
    const cancel = await f.lab.request(
      `${f.path}/cancellation-requests`,
      f.token,
      'POST',
      { expected_version: '3', cancel_id: cid },
      randomUUID(),
    );
    assert.equal(cancel.status, 201);
    const canceled = await f.lab.request(
      `${f.path}/cancellations/${cid}/acknowledgment`,
      f.token,
      'POST',
      { expected_version: '4' },
      randomUUID(),
    );
    assert.equal(canceled.status, 200);
    assert.equal(
      orderCommandResultSchema.parse(await canceled.json()).lifecycle.status,
      'CANCELED',
    );
    const history = orderDetailSchema.parse(await (await f.lab.request(f.path, f.token)).json());
    assert.equal(history.executions.length, 1);
    assert.equal(history.history.length, 5);
    assert.equal(history.cancellations[0]?.state, 'ACKNOWLEDGED');
    const seen: string[] = [];
    let cursor: string | null = null;
    let asOf: string | undefined;
    do {
      const res = await f.lab.request(
        `${f.root}/audit-events?${cursor ? 'cursor=' + encodeURIComponent(cursor) : 'limit=1'}`,
        f.token,
      );
      assert.equal(res.status, 200);
      const page = (await res.json()) as {
        events: { command_seq: string; event_index: number }[];
        next_cursor: string | null;
        as_of_seq: string;
      };
      asOf ??= page.as_of_seq;
      assert.equal(page.as_of_seq, asOf);
      seen.push(...page.events.map((e) => `${e.command_seq}:${e.event_index}`));
      cursor = page.next_cursor;
    } while (cursor);
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(seen.length, 13);
  } finally {
    await context.dispose();
    await f.close();
  }
});
await test('order API enforces strict inputs, authorization, expired/rotated bindings and foreign identities', async () => {
  let now = 0;
  const f = await executionHttp(() => now);
  try {
    assert.equal((await f.lab.request(f.path)).status, 401);
    const foreign = await f.lab.login();
    assert.equal((await f.lab.request(f.path, foreign)).status, 403);
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
    assert.equal((await f.lab.request(f.path, viewer)).status, 200);
    assert.equal(
      (
        await f.lab.request(
          `${f.path}/acknowledgment`,
          viewer,
          'POST',
          { expected_version: '1' },
          randomUUID(),
        )
      ).status,
      403,
    );
    assert.equal((await f.lab.request(`${f.root}/orders/${randomUUID()}`, f.token)).status, 404);
    for (const body of [{ expected_version: '0' }, { expected_version: '1', price: '100' }, {}])
      assert.equal(
        (await f.lab.request(`${f.path}/acknowledgment`, f.token, 'POST', body, randomUUID()))
          .status,
        400,
      );
    assert.equal(
      (await f.lab.request(`${f.path}/acknowledgment`, f.token, 'POST', { expected_version: '1' }))
        .status,
      400,
    );
    assert.equal((await f.lab.request(f.path + '?bad=1', f.token)).status, 400);
    const rotate = await f.lab.request(
      `${f.root}/recovery-keys/rotate`,
      f.token,
      'POST',
      {
        expected_generation: '1',
        read_capability: randomBytes(32).toString('base64url'),
        trade_capability: randomBytes(32).toString('base64url'),
      },
      randomUUID(),
    );
    assert.equal(rotate.status, 200);
    assert.equal((await f.lab.request(f.path, viewer)).status, 404);
    now = 1_800_001;
    assert.equal((await f.lab.request(f.path, foreign)).status, 403);
  } finally {
    await f.close();
  }
});
await test('committed fill with destroyed HTTP response replays original receipt after application restart', async () => {
  const f = await executionHttp();
  let restarted: Awaited<ReturnType<typeof HttpLab>> | undefined;
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
    f.lab.server.prependListener('request', (req, res) => {
      if (req.url === `${f.path}/executions`)
        res.end = (() => {
          res.destroy();
          return res;
        }) as typeof res.end;
    });
    await assert.rejects(f.lab.request(`${f.path}/executions`, f.token, 'POST', input, key));
    await f.lab.close();
    const { httpLab } = await import('./http.js');
    restarted = await httpLab(f.config);
    const token = await restarted.login();
    assert.equal(
      (
        await restarted.request('/api/fixed-income/v1/sandboxes/recover', token, 'POST', {
          sandbox_id: f.keys.sandbox_id,
          capability: f.keys.trade_capability,
          scope: 'trade',
        })
      ).status,
      200,
    );
    const r = await restarted.request(`${f.path}/executions`, token, 'POST', input, key);
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('Idempotency-Replayed'), 'true');
    const result = orderCommandResultSchema.parse(await r.json());
    assert.equal(result.lifecycle.execution_count, 1);
    const receipt = await restarted.request(`${f.root}/commands/${key}`, token);
    assert.equal(receipt.status, 200);
    assert.deepEqual(
      ((await receipt.json()) as { command: { response_body: unknown } }).command.response_body,
      result,
    );
  } finally {
    await restarted?.close();
    await f.close();
  }
});
await test('logout during an actual filled but uncommitted transaction rolls back every financial effect', async () => {
  const f = await executionHttp();
  const { WorkflowDatabase } = await import('../../app/persistence/postgres/workflow.js');
  const { httpLab } = await import('./http.js');
  const { owner, connection } = await import('./harness.js');
  const owned = await owner();
  let at!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => {
      at = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  let armed = false;
  const database = new WorkflowDatabase(owned.appUrl!, {
      beforeCommit: async () => {
        if (armed) {
          at();
          await gate;
        }
      },
    }),
    lab = await httpLab(f.config, database);
  try {
    const token = await lab.login();
    assert.equal(
      (
        await lab.request('/api/fixed-income/v1/sandboxes/recover', token, 'POST', {
          sandbox_id: f.keys.sandbox_id,
          capability: f.keys.trade_capability,
          scope: 'trade',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await lab.request(
          `${f.path}/acknowledgment`,
          token,
          'POST',
          { expected_version: '1' },
          randomUUID(),
        )
      ).status,
      200,
    );
    armed = true;
    const fill = lab.request(
      `${f.path}/executions`,
      token,
      'POST',
      {
        expected_version: '2',
        execution_id: randomUUID(),
        source_event_id: randomUUID(),
        par_amount: '40.00',
      },
      randomUUID(),
    );
    await reached;
    assert.equal((await lab.request('/api/session', token, 'DELETE')).status, 204);
    release();
    assert.equal((await fill).status, 401);
    const reader = await connection('reconciler');
    try {
      assert.equal(
        (
          await reader.query<Record<string, unknown>>(
            'SELECT * FROM fi.executions WHERE sandbox_id=$1',
            [f.keys.sandbox_id],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await reader.query<Record<string, unknown>>(
            'SELECT * FROM fi.positions WHERE sandbox_id=$1',
            [f.keys.sandbox_id],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await reader.query<Record<string, unknown>>(
            'SELECT status FROM fi.order_states WHERE sandbox_id=$1',
            [f.keys.sandbox_id],
          )
        ).rows[0].status,
        'NEW',
      );
    } finally {
      await reader.end();
    }
  } finally {
    release();
    await lab.close();
    await f.close();
  }
});
