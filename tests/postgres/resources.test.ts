import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { connection, owner, scalar } from './harness.js';
import { migrate } from '../../scripts/workflow-database.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Result = {
  status: number;
  replayed: boolean;
  body: { sandbox?: { generation: string; read_only: boolean }; error?: { code: string } };
};
const fixture = () => {
  const id = randomUUID();
  return {
    id,
    read: digest('read' + id),
    trade: digest('trade' + id),
    key: randomUUID(),
    actor: randomUUID(),
  };
};
async function create(db: pg.Client, f: ReturnType<typeof fixture>) {
  return (
    await db.query<{ result: Result }>(
      'SELECT fi_control.create_sandbox($1,$2,$3,$4,$5,$6) AS result',
      [f.id, f.read, f.trade, digest('create'), f.key, f.actor],
    )
  ).rows[0]!.result;
}
async function expire(ids: string[]) {
  const admin = await connection('admin');
  const maint = await connection('maintenance');
  try {
    await admin.query(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=ANY($1::uuid[])",
      [ids],
    );
    return Number(await scalar(maint, 'SELECT fi_control.purge_expired()'));
  } finally {
    await maint.end();
    await admin.end();
  }
}

await test('capacity admission and authorized retention cleanup keep the actual row count consistent', async () => {
  const admin = await connection('admin');
  const candidates = Array.from({ length: 5 }, fixture);
  const clients = await Promise.all(candidates.map(() => connection('app')));
  try {
    await admin.query(
      'UPDATE fi_control.service_capacity SET capacity_limit=retained_count+1 WHERE singleton',
    );
    const results = await Promise.all(clients.map((db, index) => create(db, candidates[index]!)));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 503).length, 4);
    assert.equal(
      await scalar(
        admin,
        'SELECT retained_count=(SELECT count(*) FROM fi.sandboxes) FROM fi_control.service_capacity',
      ),
      true,
    );
    const maint = await connection('maintenance');
    try {
      assert.equal(await scalar(maint, 'SELECT fi_control.purge_expired()'), 0);
    } finally {
      await maint.end();
    }
    assert.equal(await expire(candidates.map((f) => f.id)), 1);
    assert.equal(
      await scalar(
        admin,
        'SELECT retained_count=(SELECT count(*) FROM fi.sandboxes) FROM fi_control.service_capacity',
      ),
      true,
    );
  } finally {
    await admin.query('UPDATE fi_control.service_capacity SET capacity_limit=50 WHERE singleton');
    await Promise.all(clients.map((db) => db.end()));
    await expire(candidates.map((f) => f.id));
    await admin.end();
  }
});

await test('write expiry preserves read recovery and receipts until final authorized purge', async () => {
  const db = await connection('app');
  const admin = await connection('admin');
  const f = fixture();
  try {
    assert.equal((await create(db, f)).status, 201);
    await admin.query(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '10 days',write_expires_at=clock_timestamp()-interval '3 days' WHERE id=$1",
      [f.id],
    );
    const read = (
      await db.query<{ result: Result }>('SELECT fi_control.read_sandbox($1,$2,$3) AS result', [
        f.id,
        f.trade,
        'trade',
      ])
    ).rows[0]!.result;
    assert.equal(read.status, 200);
    assert.equal(read.body.sandbox?.read_only, true);
    const mutation = (
      await db.query<{ result: Result }>(
        'SELECT fi_control.rotate_capabilities($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
        [
          f.id,
          f.trade,
          '1',
          '1',
          digest('new-r'),
          digest('new-t'),
          digest('rotate'),
          randomUUID(),
          f.actor,
        ],
      )
    ).rows[0]!.result;
    assert.equal(mutation.body.error?.code, 'SANDBOX_EXPIRED');
    assert.equal((await create(db, f)).replayed, true);
    assert.equal(
      (await admin.query('SELECT id FROM fi.commands WHERE sandbox_id=$1', [f.id])).rowCount,
      1,
    );
    assert.equal(await expire([f.id]), 1);
    assert.equal(
      (
        await db.query<{ result: Result }>('SELECT fi_control.read_sandbox($1,$2,$3) AS result', [
          f.id,
          f.trade,
          'trade',
        ])
      ).rows[0]?.result.status,
      404,
    );
    assert.equal(
      (await admin.query('SELECT id FROM fi.commands WHERE sandbox_id=$1', [f.id])).rowCount,
      0,
    );
    assert.equal(
      (await create(db, f)).status,
      404,
      'A purged bootstrap operation must never recreate its old sandbox ID.',
    );
  } finally {
    await db.end();
    await admin.end();
    await expire([f.id]);
  }
});

await test('command quota rejects additional changes without corrupting generation or the immutable ledger', async () => {
  const db = await connection('app');
  const admin = await connection('admin');
  const f = fixture();
  try {
    assert.equal((await create(db, f)).status, 201);
    for (let index = 0; index < 511; index++) {
      const result = (
        await db.query<{ result: Result }>(
          'SELECT fi_control.rotate_capabilities($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
          [
            f.id,
            f.trade,
            '1',
            '2',
            digest('next-r'),
            digest('next-t'),
            digest('rejection' + index),
            randomUUID(),
            f.actor,
          ],
        )
      ).rows[0]!.result;
      assert.equal(result.body.error?.code, 'GENERATION_CONFLICT');
    }
    const blocked = (
      await db.query<{ result: Result }>(
        'SELECT fi_control.rotate_capabilities($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
        [
          f.id,
          f.trade,
          '1',
          '1',
          digest('next-r'),
          digest('next-t'),
          digest('valid'),
          randomUUID(),
          f.actor,
        ],
      )
    ).rows[0]!.result;
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error?.code, 'SANDBOX_QUOTA_REACHED');
    const row = await admin.query<{
      generation: string;
      command_count: number;
      event_count: number;
    }>('SELECT generation,command_count,event_count FROM fi.sandboxes WHERE id=$1', [f.id]);
    assert.deepEqual(row.rows[0], { generation: '1', command_count: 512, event_count: 512 });
    assert.equal(
      (await admin.query('SELECT id FROM fi.commands WHERE sandbox_id=$1', [f.id])).rowCount,
      512,
    );
    assert.equal((await create(db, f)).replayed, true);
  } finally {
    await db.end();
    await admin.end();
    await expire([f.id]);
  }
});

await test('a reused real pool connection resets transaction-local RLS context on commit and rollback', async () => {
  const config = await owner();
  const pool = new pg.Pool({ connectionString: config.appUrl, max: 1 });
  const f = fixture(),
    g = fixture();
  try {
    let db = await pool.connect();
    assert.equal((await create(db, f)).status, 201);
    assert.equal((await create(db, g)).status, 201);
    const pid = (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await db.query('BEGIN');
    await db.query("SELECT set_config('tradeflow.sandbox_id',$1,true)", [f.id]);
    assert.deepEqual(
      (await db.query<{ id: string }>('SELECT id FROM fi.sandboxes')).rows.map((r) => r.id),
      [f.id],
    );
    await db.query('COMMIT');
    db.release();
    db = await pool.connect();
    assert.equal(
      (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid,
      pid,
    );
    assert.equal((await db.query('SELECT id FROM fi.sandboxes')).rowCount, 0);
    await db.query('BEGIN');
    await db.query("SELECT set_config('tradeflow.sandbox_id',$1,true)", [g.id]);
    assert.equal((await db.query('SELECT id FROM fi.sandboxes WHERE id=$1', [f.id])).rowCount, 0);
    await db.query('ROLLBACK');
    assert.equal((await db.query('SELECT id FROM fi.sandboxes')).rowCount, 0);
    db.release();
  } finally {
    await pool.end();
    await expire([f.id, g.id]);
  }
});

await test('migration reruns are safe and checksums reject changed previously applied SQL', async () => {
  const config = await owner();
  await migrate(config as Parameters<typeof migrate>[0]);
  await assert.rejects(
    migrate(config as Parameters<typeof migrate>[0], 'SELECT 1;'),
    /checksum or schema version mismatch/,
  );
  await migrate(config as Parameters<typeof migrate>[0]);
});
