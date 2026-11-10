import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { publicPostTradeHttp } from './http-fixture.js';
import { connection } from '../public-demo/database.js';

await test('logout while a public financial COMMIT is pending rolls back and cannot recover ownership in a new session', async () => {
  let armed = false,
    enter = () => {},
    release = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lab = await publicPostTradeHttp({
    beforeCommit: async () => {
      if (armed) {
        armed = false;
        enter();
        await gate;
      }
    },
  });
  let pending: Promise<Response> | undefined;
  try {
    const { token, root, body } = await lab.workspace();
    const path = root + '/posttrade',
      key = randomUUID();
    armed = true;
    pending = lab.request(
      path + '/initialize',
      token,
      'POST',
      { economic_start_date: '2030-01-15' },
      key,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entered,
        pending.then((response) => {
          throw new Error('COMMIT barrier not reached: ' + response.status);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('COMMIT barrier not reached.')), 1000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    assert.equal((await lab.request('/api/session', token, 'DELETE')).status, 204);
    release();
    assert.equal((await pending).status, 401);
    const admin = await connection('admin');
    try {
      assert.equal(
        (
          await admin.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM fi.posttrade_books WHERE sandbox_id=$1',
            [body.sandbox.id],
          )
        ).rows[0]!.count,
        0,
      );
      assert.equal(
        (
          await admin.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM fi_control.command_keys WHERE sandbox_id=$1 AND idempotency_key=$2',
            [body.sandbox.id, key],
          )
        ).rows[0]!.count,
        0,
      );
    } finally {
      await admin.end();
    }
    const replacement = await lab.workspace();
    assert.notEqual(replacement.body.sandbox.id, body.sandbox.id);
    assert.equal((await lab.request(path + '/commands/' + key, replacement.token)).status, 404);
  } finally {
    release();
    await pending?.catch(() => undefined);
    await lab.close();
  }
});

await test('starting a public financial workspace never extends the original login expiry', async () => {
  let now = 0;
  const lab = await publicPostTradeHttp({}, () => now);
  try {
    const token = await lab.login();
    now = 1_799_000;
    const response = await lab.request(
      '/api/public-demo/workspace',
      token,
      'POST',
      {},
      randomUUID(),
    );
    assert.equal(response.status, 201);
    const id = ((await response.json()) as { sandbox: { id: string } }).sandbox.id;
    now = 1_800_000;
    for (const suffix of [
      '',
      '/risk?fixture_id=FLAT_V1&as_of_date=2030-01-15',
      '/commands/' + randomUUID(),
    ])
      assert.equal(
        (await lab.request('/api/fixed-income/v1/sandboxes/' + id + '/posttrade' + suffix, token))
          .status,
        401,
      );
    assert.equal((await lab.request('/api/public-demo/workspace', token)).status, 401);
  } finally {
    await lab.close();
  }
});

await test('expired public financial graphs survive a live reconciliation lease, then purge all funding, keys and reservations', async () => {
  let enter = () => {},
    release = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lab = await publicPostTradeHttp({}, undefined, {
    afterSnapshot: async () => {
      enter();
      await gate;
    },
  });
  const admin = await connection('admin'),
    maintenance = await connection('maintenance');
  let pending: Promise<Response> | undefined;
  try {
    const { token, root, body } = await lab.workspace();
    const id = body.sandbox.id;
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
    pending = lab.request(
      root + '/reconciliation-runs',
      token,
      'POST',
      { run_id: randomUUID() },
      randomUUID(),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entered,
        pending.then((r) => {
          throw new Error('Snapshot barrier not reached: ' + r.status);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Snapshot barrier not reached.')), 1000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    assert.equal(
      (
        await admin.query<{ active: boolean }>(
          "SELECT state='RUNNING' AND lease_expires_at>clock_timestamp() AS active FROM fi.reconciliation_runs WHERE sandbox_id=$1",
          [id],
        )
      ).rows[0]!.active,
      true,
    );
    await admin.query(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '2 hours',write_expires_at=clock_timestamp()-interval '90 minutes',retained_until=clock_timestamp()-interval '1 hour' WHERE id=$1",
      [id],
    );
    assert.equal(
      (
        await maintenance.query<{ removed: number }>(
          'SELECT fi_control.purge_public_demo_expired() AS removed',
        )
      ).rows[0]!.removed,
      0,
    );
    assert.equal(
      (
        await admin.query<{ present: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM fi.posttrade_books WHERE sandbox_id=$1) AND EXISTS(SELECT 1 FROM fi_control.command_keys WHERE sandbox_id=$1) AS present',
          [id],
        )
      ).rows[0]!.present,
      true,
    );
    release();
    const expired = await pending;
    assert.equal(expired.status, 404);
    assert.equal(
      ((await expired.json()) as { error: { code: string } }).error.code,
      'RECONCILIATION_UNAVAILABLE',
    );
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      "UPDATE fi.reconciliation_runs SET requested_at=requested_at-interval '1 minute',started_at=started_at-interval '1 minute',lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1",
      [id],
    );
    await admin.query('COMMIT');
    assert.equal(
      (
        await maintenance.query<{ removed: number }>(
          'SELECT fi_control.purge_public_demo_expired() AS removed',
        )
      ).rows[0]!.removed,
      1,
    );
    for (const table of [
      'fi.sandboxes',
      'fi.posttrade_books',
      'fi.posttrade_commands',
      'fi.posttrade_events',
      'fi.reconciliation_runs',
      'fi_control.command_keys',
      'fi_control.fix_reservations',
      'fi_control.public_demo_sandboxes',
    ]) {
      const column = table === 'fi.sandboxes' ? 'id' : 'sandbox_id';
      assert.equal(
        (
          await admin.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM ' + table + ' WHERE ' + column + '=$1',
            [id],
          )
        ).rows[0]!.count,
        0,
        table,
      );
    }
    assert.equal(
      (
        await admin.query<{ count: number }>(
          'SELECT retained_count AS count FROM fi_control.service_capacity',
        )
      ).rows[0]!.count,
      0,
    );
  } finally {
    release();
    await pending?.catch(() => undefined);
    await admin.end();
    await maintenance.end();
    await lab.close();
  }
});
