import assert from 'node:assert/strict';
import { test } from 'node:test';
import { httpLab } from './http.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { owner, connection } from './harness.js';
import { readConfiguration } from '../../app/server/configuration.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { request as nativeRequest } from 'node:http';
import { once } from 'node:events';

const root = '/api/fixed-income/v1';
const makeInput = () => ({
  sandbox_id: randomUUID(),
  read_capability: randomBytes(32).toString('base64url'),
  trade_capability: randomBytes(32).toString('base64url'),
});
async function enabled() {
  const config = await owner();
  if (!config.appUrl) throw new Error('Missing application role.');
  return readConfiguration({
    TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
    TRADEFLOW_FIXED_INCOME_DATABASE_URL: config.appUrl,
  });
}
async function cleanup(id: string) {
  const admin = await connection('admin');
  const maint = await connection('maintenance');
  try {
    await admin.query(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
      [id],
    );
    await maint.query('SELECT fi_control.purge_expired()');
  } finally {
    await maint.end();
    await admin.end();
  }
}

await test('default-off status works without PostgreSQL and leaves legacy authentication intact', async () => {
  const lab = await httpLab();
  try {
    const token = await lab.login();
    const status = await lab.request('/api/fixed-income/v1/workflow/status', token);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { enabled: false, state: 'disabled' });
    assert.equal((await lab.request('/api/orders', token)).status, 200);
    assert.equal((await lab.request('/api/fixed-income/v1/instruments', token)).status, 200);
    assert.equal(
      (await lab.request('/api/fixed-income/v1/sandboxes', token, 'POST', {})).status,
      404,
    );
  } finally {
    await lab.close();
  }
});

await test('HTTP creation and restart recovery preserve durable history but create a fresh equity book', async () => {
  const input = makeInput();
  const key = randomUUID();
  let lab = await httpLab(await enabled());
  try {
    let token = await lab.login();
    assert.deepEqual(await (await lab.request(`${root}/workflow/status`, token)).json(), {
      enabled: true,
      state: 'ready',
    });
    const first = await lab.request(`${root}/sandboxes`, token, 'POST', input, key);
    assert.equal(first.status, 201);
    const body: unknown = await first.json();
    assert.equal(first.headers.get('Location'), `${root}/sandboxes/${input.sandbox_id}`);
    const replay = await lab.request(`${root}/sandboxes`, token, 'POST', input, key);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(await replay.json(), body);
    await lab.request('/api/orders', token, 'POST', {
      symbol: 'AAPL',
      side: 'BUY',
      quantity: 7,
      type: 'MARKET',
    });
    await lab.close();
    lab = await httpLab(await enabled());
    token = await lab.login();
    assert.equal((await lab.request(`${root}/sandboxes/${input.sandbox_id}`, token)).status, 403);
    const recovered = await lab.request(`${root}/sandboxes/recover`, token, 'POST', {
      sandbox_id: input.sandbox_id,
      capability: input.trade_capability,
      scope: 'trade',
    });
    assert.equal(recovered.status, 200);
    const orders = (await (await lab.request('/api/orders', token)).json()) as {
      orders: unknown[];
    };
    assert.equal(orders.orders.length, 5);
    const receipt = await lab.request(
      `${root}/sandboxes/${input.sandbox_id}/commands/${key}`,
      token,
    );
    assert.equal(receipt.status, 200);
    const audit = await lab.request(`${root}/sandboxes/${input.sandbox_id}/audit-events`, token);
    assert.equal(audit.status, 200);
    const events = (await audit.json()) as { events: Array<{ event_type: string }> };
    assert.deepEqual(
      events.events.map((e) => e.event_type),
      ['SANDBOX_CREATED'],
    );
    const safe = JSON.stringify({ receipt: (await receipt.json()) as unknown, events });
    assert.equal(safe.includes(input.trade_capability), false);
    assert.equal(safe.includes(input.read_capability), false);
  } finally {
    await lab.close();
    await cleanup(input.sandbox_id);
  }
});

await test('viewer and read capabilities cannot rotate or cross into another sandbox', async () => {
  const lab = await httpLab(await enabled());
  const a = makeInput(),
    b = makeInput();
  try {
    const ownerA = await lab.login(),
      ownerB = await lab.login(),
      viewer = await lab.login(true);
    assert.equal(
      (await lab.request(`${root}/sandboxes`, ownerA, 'POST', a, randomUUID())).status,
      201,
    );
    assert.equal(
      (await lab.request(`${root}/sandboxes`, ownerB, 'POST', b, randomUUID())).status,
      201,
    );
    assert.equal((await lab.request(`${root}/sandboxes/${b.sandbox_id}`, ownerA)).status, 404);
    assert.equal(
      (
        await lab.request(`${root}/sandboxes/recover`, viewer, 'POST', {
          sandbox_id: a.sandbox_id,
          capability: a.read_capability,
          scope: 'read',
        })
      ).status,
      200,
    );
    assert.equal((await lab.request(`${root}/sandboxes/${a.sandbox_id}`, viewer)).status, 200);
    const next = makeInput();
    const rotation = {
      expected_generation: '1',
      read_capability: next.read_capability,
      trade_capability: next.trade_capability,
    };
    assert.equal(
      (
        await lab.request(
          `${root}/sandboxes/${a.sandbox_id}/recovery-keys/rotate`,
          viewer,
          'POST',
          rotation,
          randomUUID(),
        )
      ).status,
      403,
    );
    assert.equal(
      (await lab.request(`${root}/sandboxes`, viewer, 'POST', makeInput(), randomUUID())).status,
      403,
    );
    const traderRead = await lab.login();
    assert.equal(
      (
        await lab.request(`${root}/sandboxes/recover`, traderRead, 'POST', {
          sandbox_id: a.sandbox_id,
          capability: a.read_capability,
          scope: 'read',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await lab.request(
          `${root}/sandboxes/${a.sandbox_id}/recovery-keys/rotate`,
          traderRead,
          'POST',
          rotation,
          randomUUID(),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await lab.request(`${root}/sandboxes/recover`, viewer, 'POST', {
          sandbox_id: a.sandbox_id,
          capability: a.trade_capability,
          scope: 'trade',
        })
      ).status,
      403,
    );
  } finally {
    await lab.close();
    await cleanup(a.sandbox_id);
    await cleanup(b.sandbox_id);
  }
});

await test('rotation revokes old bindings and retained new capabilities recover the original operation', async () => {
  const lab = await httpLab(await enabled());
  const input = makeInput(),
    next = makeInput();
  const key = randomUUID();
  try {
    const token = await lab.login(),
      other = await lab.login();
    assert.equal(
      (await lab.request(`${root}/sandboxes`, token, 'POST', input, randomUUID())).status,
      201,
    );
    assert.equal(
      (
        await lab.request(`${root}/sandboxes/recover`, other, 'POST', {
          sandbox_id: input.sandbox_id,
          capability: input.trade_capability,
          scope: 'trade',
        })
      ).status,
      200,
    );
    const body = {
      expected_generation: '1',
      read_capability: next.read_capability,
      trade_capability: next.trade_capability,
    };
    const rotated = await lab.request(
      `${root}/sandboxes/${input.sandbox_id}/recovery-keys/rotate`,
      token,
      'POST',
      body,
      key,
    );
    assert.equal(rotated.status, 200);
    const original: unknown = await rotated.json();
    assert.equal((await lab.request(`${root}/sandboxes/${input.sandbox_id}`, other)).status, 404);
    assert.equal(
      (
        await lab.request(`${root}/sandboxes/recover`, other, 'POST', {
          sandbox_id: input.sandbox_id,
          capability: input.trade_capability,
          scope: 'trade',
        })
      ).status,
      404,
    );
    const fresh = await lab.login();
    assert.equal(
      (
        await lab.request(`${root}/sandboxes/recover`, fresh, 'POST', {
          sandbox_id: input.sandbox_id,
          capability: next.trade_capability,
          scope: 'trade',
        })
      ).status,
      200,
    );
    const replay = await lab.request(
      `${root}/sandboxes/${input.sandbox_id}/recovery-keys/rotate`,
      fresh,
      'POST',
      body,
      key,
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(await replay.json(), original);
  } finally {
    await lab.close();
    await cleanup(input.sandbox_id);
  }
});

await test('unavailable database fails workflow safely while equity, health and analytics remain available', async () => {
  const config = await enabled();
  if (!config.workflow) throw new Error('Missing workflow config');
  const url = new URL(config.workflow.databaseUrl);
  url.port = '1';
  config.workflow.databaseUrl = url.href;
  const lab = await httpLab(config);
  try {
    const token = await lab.login();
    const input = makeInput();
    assert.equal(
      (await lab.request(`${root}/sandboxes`, token, 'POST', input, randomUUID())).status,
      503,
    );
    assert.deepEqual(await (await lab.request(`${root}/workflow/status`, token)).json(), {
      enabled: true,
      state: 'unavailable',
    });
    assert.equal((await lab.request('/health')).status, 200);
    assert.equal((await lab.request('/api/orders', token)).status, 200);
    assert.equal(
      (
        await lab.request(
          `${root}/analytics?instrument_id=SYN-UST-2031&settlement_date=2026-10-15&par_amount=1000&yield=0.04`,
          token,
        )
      ).status,
      200,
    );
  } finally {
    await lab.close();
  }
});

await test('session logout at a precommit barrier rolls back all durable creation effects', async () => {
  const config = await enabled();
  if (!config.workflow) throw new Error('Missing workflow config');
  let reached!: () => void, release!: () => void;
  const atBarrier = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const db = new WorkflowDatabase(config.workflow.databaseUrl, {
    beforeCommit: async () => {
      reached();
      await gate;
    },
  });
  const lab = await httpLab(config, db);
  const input = makeInput();
  try {
    const token = await lab.login();
    const command = lab.request(`${root}/sandboxes`, token, 'POST', input, randomUUID());
    await atBarrier;
    assert.equal((await lab.request('/api/session', token, 'DELETE')).status, 204);
    release();
    assert.equal((await command).status, 401);
    const observer = await connection('reconciler');
    try {
      assert.equal(
        (await observer.query('SELECT id FROM fi.sandboxes WHERE id=$1', [input.sandbox_id]))
          .rowCount,
        0,
      );
    } finally {
      await observer.end();
    }
  } finally {
    release();
    await lab.close();
    await cleanup(input.sandbox_id);
  }
});

await test('workflow binding expiry leaves the original local equity session valid and permits explicit recovery', async () => {
  let now = 0;
  const lab = await httpLab(await enabled(), undefined, () => now);
  const input = makeInput();
  try {
    const token = await lab.login();
    assert.equal(
      (await lab.request(`${root}/sandboxes`, token, 'POST', input, randomUUID())).status,
      201,
    );
    now = 1_800_000;
    assert.equal((await lab.request(`${root}/sandboxes/${input.sandbox_id}`, token)).status, 403);
    assert.equal((await lab.request('/api/orders', token)).status, 200);
    assert.equal(
      (
        await lab.request(`${root}/sandboxes/recover`, token, 'POST', {
          sandbox_id: input.sandbox_id,
          capability: input.trade_capability,
          scope: 'trade',
        })
      ).status,
      200,
    );
    assert.equal((await lab.request(`${root}/sandboxes/${input.sandbox_id}`, token)).status, 200);
  } finally {
    await lab.close();
    await cleanup(input.sandbox_id);
  }
});

await test('logout during an incomplete creation body cannot authorize a later durable mutation', async () => {
  const lab = await httpLab(await enabled());
  const input = makeInput();
  try {
    const token = await lab.login();
    const bytes = Buffer.from(JSON.stringify(input));
    const arrived = once(lab.server, 'request');
    const pending = new Promise<number>((resolve, reject) => {
      const call = nativeRequest(
        lab.origin + `${root}/sandboxes`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': bytes.length,
            'Idempotency-Key': randomUUID(),
          },
        },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode ?? 0));
        },
      );
      call.once('error', reject);
      call.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      void (async () => {
        await arrived;
        assert.equal((await lab.request('/api/session', token, 'DELETE')).status, 204);
        call.end(bytes.subarray(Math.floor(bytes.length / 2)));
      })().catch(reject);
    });
    assert.equal(await pending, 401);
    const observer = await connection('reconciler');
    try {
      assert.equal(
        (await observer.query('SELECT id FROM fi.sandboxes WHERE id=$1', [input.sandbox_id]))
          .rowCount,
        0,
      );
    } finally {
      await observer.end();
    }
  } finally {
    await lab.close();
    await cleanup(input.sandbox_id);
  }
});

await test('runtime schema drift and blocked metadata queries fail closed and recover after repair', async () => {
  const lab = await httpLab(await enabled());
  const admin = await connection('admin');
  const input = makeInput();
  const original = (
    await admin.query<{ checksum: string }>(
      'SELECT checksum FROM fi_control.schema_migrations WHERE version=2',
    )
  ).rows[0]!.checksum;
  try {
    const token = await lab.login();
    await admin.query(
      "UPDATE fi_control.schema_migrations SET checksum=repeat('0',64) WHERE version=2",
    );
    assert.equal(
      (await lab.request(`${root}/sandboxes`, token, 'POST', input, randomUUID())).status,
      503,
    );
    assert.equal((await lab.request('/api/orders', token)).status, 200);
    await admin.query('UPDATE fi_control.schema_migrations SET checksum=$1 WHERE version=2', [
      original,
    ]);
    await admin.query('BEGIN');
    await admin.query('LOCK fi_control.compatibility IN ACCESS EXCLUSIVE MODE');
    const started = performance.now();
    assert.deepEqual(await (await lab.request(`${root}/workflow/status`, token)).json(), {
      enabled: true,
      state: 'unavailable',
    });
    assert.ok(performance.now() - started < 5000);
    await admin.query('ROLLBACK');
    assert.deepEqual(await (await lab.request(`${root}/workflow/status`, token)).json(), {
      enabled: true,
      state: 'ready',
    });
    assert.equal(
      (await lab.request(`${root}/sandboxes`, token, 'POST', input, randomUUID())).status,
      201,
    );
  } finally {
    await admin.query('ROLLBACK');
    await admin.query('UPDATE fi_control.schema_migrations SET checksum=$1 WHERE version=2', [
      original,
    ]);
    await admin.end();
    await lab.close();
    await cleanup(input.sandbox_id);
  }
});

await test('successful rotation preserves the original session admission window and absolute binding expiry', async () => {
  let now = 0;
  const lab = await httpLab(await enabled(), undefined, () => now);
  const input = makeInput(),
    next = makeInput();
  try {
    const token = await lab.login();
    assert.equal(
      (await lab.request(`${root}/sandboxes`, token, 'POST', input, randomUUID())).status,
      201,
    );
    for (let index = 0; index < 24; index++)
      assert.equal(
        (
          await lab.request(
            `${root}/sandboxes/${input.sandbox_id}/recovery-keys/rotate`,
            token,
            'POST',
            {
              expected_generation: '99',
              read_capability: next.read_capability,
              trade_capability: next.trade_capability,
            },
            randomUUID(),
          )
        ).status,
        409,
      );
    now = 1_000_000;
    assert.equal(
      (
        await lab.request(
          `${root}/sandboxes/${input.sandbox_id}/recovery-keys/rotate`,
          token,
          'POST',
          {
            expected_generation: '1',
            read_capability: next.read_capability,
            trade_capability: next.trade_capability,
          },
          randomUUID(),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await lab.request(`${root}/sandboxes/recover`, token, 'POST', {
          sandbox_id: input.sandbox_id,
          capability: next.trade_capability,
          scope: 'trade',
        })
      ).status,
      200,
    );
    // Time advanced beyond the first rate window: fill the current window, then rotate once more.
    for (let index = 0; index < 27; index++)
      assert.equal(
        (
          await lab.request(
            `${root}/sandboxes/${input.sandbox_id}/recovery-keys/rotate`,
            token,
            'POST',
            {
              expected_generation: '99',
              read_capability: input.read_capability,
              trade_capability: input.trade_capability,
            },
            randomUUID(),
          )
        ).status,
        409,
      );
    assert.equal(
      (
        await lab.request(
          `${root}/sandboxes/${input.sandbox_id}/recovery-keys/rotate`,
          token,
          'POST',
          {
            expected_generation: '2',
            read_capability: input.read_capability,
            trade_capability: input.trade_capability,
          },
          randomUUID(),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await lab.request(`${root}/sandboxes/recover`, token, 'POST', {
          sandbox_id: input.sandbox_id,
          capability: input.trade_capability,
          scope: 'trade',
        })
      ).status,
      429,
    );
    now = 1_060_000;
    assert.equal(
      (
        await lab.request(`${root}/sandboxes/recover`, token, 'POST', {
          sandbox_id: input.sandbox_id,
          capability: input.trade_capability,
          scope: 'trade',
        })
      ).status,
      200,
    );
    now = 1_800_000;
    assert.equal((await lab.request(`${root}/sandboxes/${input.sandbox_id}`, token)).status, 403);
    assert.equal((await lab.request('/api/orders', token)).status, 200);
  } finally {
    await lab.close();
    await cleanup(input.sandbox_id);
  }
});
