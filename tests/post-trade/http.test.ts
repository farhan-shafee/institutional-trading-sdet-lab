import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { postTradeHttp, retireHttpSandbox } from './http-fixture.js';
import { httpLab } from '../postgres/http.js';
const query = '?fixture_id=FLAT_V1&as_of_date=2030-01-15';

await test('post-trade stays off by default and explicit owned mode exposes unavailable then verified empty reads', async () => {
  const off = await httpLab();
  try {
    const token = await off.login();
    assert.equal(
      (
        await off.request(
          '/api/fixed-income/v1/sandboxes/' + randomUUID() + '/posttrade/risk' + query,
          token,
        )
      ).status,
      404,
    );
  } finally {
    await off.close();
  }
  const s = await postTradeHttp();
  try {
    assert.equal((await s.lab.request(s.path + '/risk' + query)).status, 401);
    const unavailable = await s.lab.request(s.path + '/risk' + query, s.token);
    assert.equal(unavailable.status, 200);
    const disabled = (await unavailable.json()) as Record<string, unknown>;
    assert.equal(disabled['status'], 'UNAVAILABLE');
    assert.ok(!('risk' in disabled));
    const key = randomUUID(),
      payload = { economic_start_date: '2030-01-15' };
    const initialized = await s.lab.request(s.path + '/initialize', s.token, 'POST', payload, key);
    assert.equal(initialized.status, 201);
    const replay = await s.lab.request(s.path + '/initialize', s.token, 'POST', payload, key);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(await replay.json(), await initialized.json());
    const response = await s.lab.request(s.path + '/pnl' + query, s.token);
    assert.equal(response.status, 200);
    const pnl = (await response.json()) as {
      status: string;
      pnl: { equity_usd: string; total_pnl_usd: string };
    };
    assert.equal(pnl.status, 'AVAILABLE');
    assert.equal(pnl.pnl.equity_usd, '100000000.00');
    assert.equal(pnl.pnl.total_pnl_usd, '0.00');
  } finally {
    await s.close();
  }
});
await test('HTTP writer roles, read capabilities and cross-sandbox scopes are checked before replay', async () => {
  const s = await postTradeHttp();
  try {
    const viewer = await s.lab.login(true);
    assert.equal(
      (
        await s.lab.request('/api/fixed-income/v1/sandboxes/recover', viewer, 'POST', {
          sandbox_id: s.keys.sandbox_id,
          scope: 'read',
          capability: s.keys.read_capability,
        })
      ).status,
      200,
    );
    assert.equal((await s.lab.request(s.path + '/risk' + query, viewer)).status, 200);
    const key = randomUUID(),
      payload = { economic_start_date: '2030-01-15' };
    assert.equal(
      (await s.lab.request(s.path + '/initialize', s.token, 'POST', payload, key)).status,
      201,
    );
    assert.equal(
      (await s.lab.request(s.path + '/initialize', viewer, 'POST', payload, key)).status,
      403,
    );
    assert.equal((await s.lab.request(s.path + '/commands/' + key, viewer)).status, 200);
    const stranger = await s.lab.login();
    assert.equal((await s.lab.request(s.path + '/commands/' + key, stranger)).status, 403);
    assert.equal((await s.lab.request(s.path + '/risk' + query, stranger)).status, 403);
    const other = {
      sandbox_id: randomUUID(),
      read_capability: randomBytes(32).toString('base64url'),
      trade_capability: randomBytes(32).toString('base64url'),
    };
    try {
      assert.equal(
        (
          await s.lab.request(
            '/api/fixed-income/v1/sandboxes',
            stranger,
            'POST',
            other,
            randomUUID(),
          )
        ).status,
        201,
      );
      assert.equal((await s.lab.request(s.path + '/commands/' + key, stranger)).status, 404);
      assert.equal((await s.lab.request(s.path + '/risk' + query, stranger)).status, 404);
    } finally {
      await retireHttpSandbox(other.sandbox_id);
    }
  } finally {
    await s.close();
  }
});
await test('HTTP raw execution registration, correction, DVP, history, audit and receipt recovery share source identities', async () => {
  const s = await postTradeHttp();
  try {
    assert.equal(
      (
        await s.lab.request(
          s.path + '/initialize',
          s.token,
          'POST',
          { economic_start_date: '2030-01-15' },
          randomUUID(),
        )
      ).status,
      201,
    );
    const raw = await s.execution(),
      root = s.path + '/executions/' + raw.execution_id;
    assert.equal(
      (await s.lab.request(root + '/register', s.token, 'POST', {}, randomUUID())).status,
      201,
    );
    const key = randomUUID();
    assert.equal(
      (
        await s.lab.request(
          root + '/corrections',
          s.token,
          'POST',
          { expected_revision: 0, clean_price: '100.880000000000' },
          key,
        )
      ).status,
      201,
    );
    const before = await s.lab.request(s.path + '/pnl' + query, s.token);
    assert.equal(before.status, 200);
    const a = (await before.json()) as {
      source: { source_id: string; posttrade_command_seq: string };
      pnl: { total_pnl_usd: string; realized_pnl_usd: string };
    };
    assert.equal(a.source.posttrade_command_seq, '3');
    const posted = await s.lab.request(
      root + '/settlements',
      s.token,
      'POST',
      { expected_revision: 1, processing_date: '2030-01-15' },
      randomUUID(),
    );
    assert.equal(posted.status, 200);
    const after = await s.lab.request(s.path + '/pnl' + query, s.token);
    assert.equal(after.status, 200);
    const b = (await after.json()) as typeof a;
    assert.equal(b.pnl.total_pnl_usd, a.pnl.total_pnl_usd);
    assert.equal(b.pnl.realized_pnl_usd, a.pnl.realized_pnl_usd);
    assert.notEqual(b.source.source_id, a.source.source_id);
    const receipt = await s.lab.request(s.path + '/commands/' + key, s.token);
    assert.equal(receipt.status, 200);
    const command = (await receipt.json()) as {
      command: { operation: string; command_seq: string; http_status: number };
    };
    assert.equal(command.command.operation, 'CORRECT_PRICE');
    assert.equal(command.command.command_seq, '3');
    assert.equal(command.command.http_status, 201);
    const history = await s.lab.request(root + '/history', s.token);
    assert.equal(history.status, 200);
    const h = (await history.json()) as { revisions: unknown[]; settlement_outcomes: unknown[] };
    assert.equal(h.revisions.length, 2);
    assert.equal(h.settlement_outcomes.length, 1);
    const audit = await s.lab.request(s.path + '/audit-events?limit=2', s.token);
    assert.equal(audit.status, 200);
    const events = (await audit.json()) as { events: unknown[]; next_cursor: unknown };
    assert.equal(events.events.length, 2);
    assert.ok(events.next_cursor);
  } finally {
    await s.close();
  }
});
await test('HTTP duplicate/prototype queries and malformed writer payloads cannot submit client positions or terms', async () => {
  const s = await postTradeHttp();
  try {
    for (const suffix of [
      query + '&fixture_id=FLAT_V1',
      query + '&__proto__=x',
      query + '&positions=1',
    ])
      assert.equal((await s.lab.request(s.path + '/risk' + suffix, s.token)).status, 400);
    for (const payload of [
      { economic_start_date: '2030-01-15', positions: [] },
      { economic_start_date: '2030-01-15', side: 'SELL' },
    ])
      assert.equal(
        (await s.lab.request(s.path + '/initialize', s.token, 'POST', payload, randomUUID()))
          .status,
        400,
      );
    for (const body of [
      '{"economic_start_date":"2030-01-15","economic_start_date":"2030-01-16"}',
      '{"economic_start_date":"2030-01-15","__proto__":{"polluted":true}}',
      '{"economic_start_date":',
    ]) {
      const response = await fetch(s.lab.origin + s.path + '/initialize', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + s.token,
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        body,
      });
      assert.equal(response.status, 400);
    }
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  } finally {
    await s.close();
  }
});
await test('current rotated capability is required for known post-trade receipt and replay', async () => {
  const s = await postTradeHttp();
  try {
    const key = randomUUID(),
      payload = { economic_start_date: '2030-01-15' };
    assert.equal(
      (await s.lab.request(s.path + '/initialize', s.token, 'POST', payload, key)).status,
      201,
    );
    const viewer = await s.lab.login(true);
    assert.equal(
      (
        await s.lab.request('/api/fixed-income/v1/sandboxes/recover', viewer, 'POST', {
          sandbox_id: s.keys.sandbox_id,
          scope: 'read',
          capability: s.keys.read_capability,
        })
      ).status,
      200,
    );
    const next = {
      read_capability: randomBytes(32).toString('base64url'),
      trade_capability: randomBytes(32).toString('base64url'),
    };
    assert.equal(
      (
        await s.lab.request(
          s.root + '/recovery-keys/rotate',
          s.token,
          'POST',
          { expected_generation: '1', ...next },
          randomUUID(),
        )
      ).status,
      200,
    );
    assert.equal((await s.lab.request(s.path + '/commands/' + key, viewer)).status, 404);
    assert.equal(
      (
        await s.lab.request('/api/fixed-income/v1/sandboxes/recover', s.token, 'POST', {
          sandbox_id: s.keys.sandbox_id,
          scope: 'trade',
          capability: next.trade_capability,
        })
      ).status,
      200,
    );
    const recovered = await s.lab.request(s.path + '/initialize', s.token, 'POST', payload, key);
    assert.equal(recovered.status, 201);
    assert.equal(recovered.headers.get('Idempotency-Replayed'), 'true');
  } finally {
    await s.close();
  }
});
await test('HTTP audit pagination freezes both source cutoffs and rejects a modified cursor', async () => {
  const s = await postTradeHttp();
  try {
    assert.equal(
      (
        await s.lab.request(
          s.path + '/initialize',
          s.token,
          'POST',
          { economic_start_date: '2030-01-15' },
          randomUUID(),
        )
      ).status,
      201,
    );
    const raw = await s.execution(),
      root = s.path + '/executions/' + raw.execution_id;
    assert.equal(
      (await s.lab.request(root + '/register', s.token, 'POST', {}, randomUUID())).status,
      201,
    );
    assert.equal(
      (
        await s.lab.request(
          root + '/settlements',
          s.token,
          'POST',
          { expected_revision: 0, processing_date: '2030-01-15' },
          randomUUID(),
        )
      ).status,
      200,
    );
    const firstResponse = await s.lab.request(s.path + '/audit-events?limit=1', s.token);
    assert.equal(firstResponse.status, 200);
    type Page = {
      source: { source_id: string; posttrade_command_seq: string };
      as_of_seq: string;
      events: { command_seq: string; event_index: number }[];
      next_cursor: string | null;
    };
    let page = (await firstResponse.json()) as Page;
    const id = page.source.source_id,
      upper = page.as_of_seq;
    const events = [...page.events],
      cursor = page.next_cursor;
    assert.ok(cursor);
    assert.equal(
      (
        await s.lab.request(
          root + '/reversals',
          s.token,
          'POST',
          { expected_revision: 0, processing_date: '2030-01-15' },
          randomUUID(),
        )
      ).status,
      200,
    );
    const modified = (cursor[0] === 'A' ? 'B' : 'A') + cursor.slice(1);
    assert.equal(
      (
        await s.lab.request(
          s.path + '/audit-events?cursor=' + encodeURIComponent(modified),
          s.token,
        )
      ).status,
      409,
    );
    while (page.next_cursor) {
      const response = await s.lab.request(
        s.path + '/audit-events?cursor=' + encodeURIComponent(page.next_cursor),
        s.token,
      );
      assert.equal(response.status, 200);
      page = (await response.json()) as Page;
      assert.equal(page.source.source_id, id);
      assert.equal(page.as_of_seq, upper);
      events.push(...page.events);
    }
    assert.equal(events.length, 4);
    assert.equal(
      new Set(events.map((event) => event.command_seq + ':' + event.event_index)).size,
      4,
    );
  } finally {
    await s.close();
  }
});
await test('logout after SQL effects but before COMMIT rolls back funding and retains the original key for recovery', async () => {
  let armed = false,
    enter: () => void = () => undefined,
    release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const s = await postTradeHttp({
    beforeCommit: async () => {
      if (armed) {
        armed = false;
        enter();
        await gate;
      }
    },
  });
  const key = randomUUID(),
    payload = { economic_start_date: '2030-01-15' };
  let pending: Promise<Response> | undefined;
  try {
    armed = true;
    pending = s.lab.request(s.path + '/initialize', s.token, 'POST', payload, key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entered,
        pending.then((response) => {
          throw new Error('Request finished before controlled COMMIT: ' + response.status);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Controlled COMMIT barrier was not reached.')),
            1000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    assert.equal((await s.lab.request('/api/session', s.token, 'DELETE')).status, 204);
    release();
    assert.equal((await pending).status, 401);
    const fresh = await s.lab.login();
    assert.equal(
      (
        await s.lab.request('/api/fixed-income/v1/sandboxes/recover', fresh, 'POST', {
          sandbox_id: s.keys.sandbox_id,
          scope: 'trade',
          capability: s.keys.trade_capability,
        })
      ).status,
      200,
    );
    const recovered = await s.lab.request(s.path + '/initialize', fresh, 'POST', payload, key);
    assert.equal(recovered.status, 201);
    assert.notEqual(recovered.headers.get('Idempotency-Replayed'), 'true');
    const source = await s.lab.request(s.path, fresh);
    assert.equal(source.status, 200);
    assert.equal(
      ((await source.json()) as { posttrade_command_seq: string }).posttrade_command_seq,
      '1',
    );
  } finally {
    release();
    await pending?.catch(() => undefined);
    await s.close();
  }
});
await test('HTTP unknown COMMIT returns original stored receipt and replays one funding event', async () => {
  let armed = false;
  const s = await postTradeHttp({
    afterCommit: () => {
      if (armed) {
        armed = false;
        throw new Error('CONTROLLED_POST_COMMIT_LOSS');
      }
    },
  });
  try {
    const key = randomUUID(),
      payload = { economic_start_date: '2030-01-15' };
    armed = true;
    const failed = await s.lab.request(s.path + '/initialize', s.token, 'POST', payload, key);
    assert.equal(failed.status, 503);
    const error = (await failed.json()) as { error: { code: string } };
    assert.equal(error.error.code, 'OUTCOME_UNKNOWN');
    const receipt = await s.lab.request(s.path + '/commands/' + key, s.token);
    assert.equal(receipt.status, 200);
    assert.equal(
      ((await receipt.json()) as { command: { http_status: number } }).command.http_status,
      201,
    );
    const replay = await s.lab.request(s.path + '/initialize', s.token, 'POST', payload, key);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    const source = await s.lab.request(s.path, s.token);
    assert.equal(source.status, 200);
    const body = (await source.json()) as {
      posttrade_command_seq: string;
      available_cash_cents: string;
    };
    assert.equal(body.posttrade_command_seq, '1');
    assert.equal(body.available_cash_cents, '10000000000');
  } finally {
    await s.close();
  }
});
