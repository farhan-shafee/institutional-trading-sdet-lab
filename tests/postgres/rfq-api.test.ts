import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { request } from '@playwright/test';
import { readConfiguration } from '../../app/server/configuration.js';
import { connection, owner } from './harness.js';
import { httpLab } from './http.js';
import { rfqInput, type RfqDetail } from './rfq-fixture.js';
import { OpenApiContracts } from '../contract/openapi-validator.js';

export async function rfqHttp(now?: () => number) {
  const owned = await owner();
  const config = readConfiguration({
    TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
    TRADEFLOW_FIXED_INCOME_DATABASE_URL: owned.appUrl!,
  });
  const lab = await httpLab(config, undefined, now);
  const token = await lab.login();
  const keys = {
    sandbox_id: randomUUID(),
    read_capability: randomBytes(32).toString('base64url'),
    trade_capability: randomBytes(32).toString('base64url'),
  };
  const root = `/api/fixed-income/v1/sandboxes/${keys.sandbox_id}`;
  assert.equal(
    (await lab.request('/api/fixed-income/v1/sandboxes', token, 'POST', keys, randomUUID())).status,
    201,
  );
  return {
    lab,
    token,
    keys,
    root,
    config,
    async close() {
      if (lab.server.listening) await lab.close();
      const admin = await connection('admin'),
        maint = await connection('maintenance');
      try {
        await admin.query(
          "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
          [keys.sandbox_id],
        );
        await maint.query('SELECT fi_control.purge_expired()');
      } finally {
        await maint.end();
        await admin.end();
      }
    },
  };
}

await test('RFQ HTTP and independent OpenAPI freeze BUY/SELL contracts and paginate every event within one command', async () => {
  const f = await rfqHttp(),
    context = await request.newContext({ baseURL: f.lab.origin });
  try {
    const contracts = await OpenApiContracts.load(context);
    for (const [side, instrument] of [
      ['BUY', 'SYN-UST-2031'],
      ['SELL', 'SYN-CORP-2031'],
    ]) {
      const input = rfqInput(side, instrument),
        base = `${f.root}/rfqs`;
      const created = await f.lab.request(base, f.token, 'POST', input, randomUUID());
      assert.equal(created.status, 201);
      const initial: unknown = await created.json();
      const validator = contracts.response(
        'post',
        '/api/fixed-income/v1/sandboxes/{sid}/rfqs',
        201,
      );
      assert.equal(validator(initial), true, JSON.stringify(validator.errors));
      assert.equal(validator({ ...(initial as object), order: { status: 'FILLED' } }), false);
      const response = await f.lab.request(
        `${base}/${input.rfq_id}/dealer-responses`,
        f.token,
        'POST',
        { expected_version: '1', dealer_id: 'ATLAS', response: 'QUOTE' },
        randomUUID(),
      );
      assert.equal(response.status, 200);
      const detail = (await response.json()) as RfqDetail;
      const accepted = await f.lab.request(
        `${base}/${input.rfq_id}/accept`,
        f.token,
        'POST',
        { expected_version: '2', quote_id: detail.quotes[0]!.id },
        randomUUID(),
      );
      assert.equal(accepted.status, 201);
      const acceptedBody = (await accepted.json()) as RfqDetail;
      assert.equal(acceptedBody.order?.status, 'PENDING_ACK');
      assert.equal(
        acceptedBody.order?.contract.clean_price,
        side === 'BUY' ? '100.050000000123' : '98.950000000123',
      );
      assert.equal(
        contracts.response(
          'post',
          '/api/fixed-income/v1/sandboxes/{sid}/rfqs/{rid}/accept',
          201,
        )(acceptedBody),
        true,
      );
      const invalid = await f.lab.request(
        base,
        f.token,
        'POST',
        { ...input, rfq_id: randomUUID(), invited_dealers: ['ATLAS', 'ATLAS'] },
        randomUUID(),
      );
      assert.equal(invalid.status, 400);
      assert.equal(
        contracts.response(
          'post',
          '/api/fixed-income/v1/sandboxes/{sid}/rfqs',
          400,
        )(await invalid.json()),
        true,
      );
    }
    const observed: { command_seq: string; event_index: number }[] = [];
    let path: string | null = `${f.root}/audit-events?limit=1`,
      asOf: string | undefined;
    while (path) {
      const response = await f.lab.request(path, f.token);
      assert.equal(response.status, 200);
      const page = (await response.json()) as {
        events: typeof observed;
        next_cursor: string | null;
        as_of_seq: string;
      };
      asOf ??= page.as_of_seq;
      assert.equal(page.as_of_seq, asOf);
      observed.push(...page.events);
      path = page.next_cursor
        ? `${f.root}/audit-events?cursor=${encodeURIComponent(page.next_cursor)}`
        : null;
    }
    const reader = await connection('reconciler');
    try {
      const expected = await reader.query(
        'SELECT command_seq::text,event_index FROM fi.audit_events WHERE sandbox_id=$1 ORDER BY command_seq,event_index',
        [f.keys.sandbox_id],
      );
      assert.deepEqual(
        observed.map((e) => ({ command_seq: e.command_seq, event_index: e.event_index })),
        expected.rows,
      );
      assert.equal(
        new Set(observed.map((e) => `${e.command_seq}:${e.event_index}`)).size,
        observed.length,
      );
      assert.equal(observed.length, 13);
    } finally {
      await reader.end();
    }
  } finally {
    await context.dispose();
    await f.close();
  }
});

await test('a successfully committed accept with its HTTP response destroyed replays after application restart', async () => {
  const f = await rfqHttp();
  let restarted: Awaited<ReturnType<typeof httpLab>> | undefined;
  try {
    const input = rfqInput(),
      base = `${f.root}/rfqs/${input.rfq_id}`;
    assert.equal(
      (await f.lab.request(`${f.root}/rfqs`, f.token, 'POST', input, randomUUID())).status,
      201,
    );
    const response = await f.lab.request(
      `${base}/dealer-responses`,
      f.token,
      'POST',
      { expected_version: '1', dealer_id: 'ATLAS', response: 'QUOTE' },
      randomUUID(),
    );
    const detail = (await response.json()) as RfqDetail;
    const payload = { expected_version: '2', quote_id: detail.quotes[0]!.id },
      key = randomUUID();
    f.lab.server.prependListener('request', (req, res) => {
      if (req.url === `${base}/accept`)
        res.end = (() => {
          res.destroy();
          return res;
        }) as typeof res.end;
    });
    await assert.rejects(f.lab.request(`${base}/accept`, f.token, 'POST', payload, key));
    const reader = await connection('reconciler');
    try {
      assert.equal(
        (await reader.query('SELECT * FROM fi.orders WHERE sandbox_id=$1', [f.keys.sandbox_id]))
          .rowCount,
        1,
      );
    } finally {
      await reader.end();
    }
    await f.lab.close();
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
    const replay = await restarted.request(`${base}/accept`, token, 'POST', payload, key);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    const body = (await replay.json()) as RfqDetail;
    const receipt = await restarted.request(`${f.root}/commands/${key}`, token);
    assert.equal(receipt.status, 200);
    assert.deepEqual(
      ((await receipt.json()) as { command: { response_body: unknown } }).command.response_body,
      body,
    );
    assert.equal(
      (
        await restarted.request(
          `${base}/accept`,
          token,
          'POST',
          { ...payload, expected_version: '3' },
          key,
        )
      ).status,
      409,
    );
  } finally {
    await restarted?.close();
    await f.close();
  }
});

await test('RFQ routes deny read scopes, foreign IDs, stale versions, expired bindings and rotated capabilities', async () => {
  let clock = 1000;
  const f = await rfqHttp(() => clock);
  try {
    const input = rfqInput(),
      base = `${f.root}/rfqs/${input.rfq_id}`;
    assert.equal(
      (await f.lab.request(`${f.root}/rfqs`, f.token, 'POST', input, randomUUID())).status,
      201,
    );
    assert.equal(
      (await f.lab.request(base.replace(f.keys.sandbox_id, randomUUID()), f.token)).status,
      404,
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
    assert.equal((await f.lab.request(base, viewer)).status, 200);
    assert.equal(
      (
        await f.lab.request(
          `${base}/dealer-responses`,
          viewer,
          'POST',
          { expected_version: '1', dealer_id: 'ATLAS', response: 'QUOTE' },
          randomUUID(),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.lab.request(
          `${base}/dealer-responses`,
          f.token,
          'POST',
          { expected_version: '2', dealer_id: 'ATLAS', response: 'QUOTE' },
          randomUUID(),
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.lab.request(
          `${f.root}/rfqs`,
          f.token,
          'POST',
          { ...input, rfq_id: randomUUID(), settlement_date: '2027-02-29' },
          randomUUID(),
        )
      ).status,
      400,
    );
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
    assert.equal((await f.lab.request(base, viewer)).status, 404);
    assert.equal(
      (
        await f.lab.request('/api/fixed-income/v1/sandboxes/recover', f.token, 'POST', {
          sandbox_id: f.keys.sandbox_id,
          capability: f.keys.trade_capability,
          scope: 'trade',
        })
      ).status,
      404,
    );
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
    clock += 1_800_000;
    assert.equal((await f.lab.request(base, f.token)).status, 403);
    assert.equal((await f.lab.request('/api/orders', f.token)).status, 200);
  } finally {
    await f.close();
  }
});
