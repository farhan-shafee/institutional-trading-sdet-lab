import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type pg from 'pg';
import { connection, scalar } from './harness.js';

type Result = {
  status: number;
  body: {
    sandbox?: { id: string; generation: string; commit_seq: string };
    error?: { code: string };
  };
  replayed: boolean;
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const fixture = () => {
  const id = randomUUID();
  return {
    id,
    read: hash(randomBytes(32).toString('hex')),
    trade: hash(randomBytes(32).toString('hex')),
    fingerprint: hash('create'),
    key: randomUUID(),
    actor: randomUUID(),
  };
};
async function create(
  db: pg.Client,
  f: ReturnType<typeof fixture>,
  key = f.key,
  fingerprint = f.fingerprint,
): Promise<Result> {
  const result = await db.query<{ result: Result }>(
    'SELECT fi_control.create_sandbox($1,$2,$3,$4,$5,$6) AS result',
    [f.id, f.read, f.trade, fingerprint, key, f.actor],
  );
  return result.rows[0]!.result;
}
async function cleanup(ids: string[]) {
  const admin = await connection('admin');
  const maintenance = await connection('maintenance');
  try {
    await admin.query(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=ANY($1::uuid[])",
      [ids],
    );
    await maintenance.query('SELECT fi_control.purge_expired()');
  } finally {
    await maintenance.end();
    await admin.end();
  }
}

await test('concurrent bootstrap with a retained ID/key creates one sandbox and one immutable receipt', async () => {
  const admin = await connection('admin');
  try {
    assert.notEqual(
      await scalar(
        admin,
        "SELECT to_regprocedure('fi_control.create_sandbox(uuid,text,text,text,text,uuid)')::text",
      ),
      null,
    );
  } finally {
    await admin.end();
  }
  const f = fixture();
  const clients = await Promise.all(Array.from({ length: 20 }, () => connection('app')));
  try {
    const results = await Promise.all(clients.map((db) => create(db, f)));
    assert.equal(results.filter((r) => r.status === 201).length, 20);
    assert.equal(results.filter((r) => !r.replayed).length, 1);
    assert.equal(results.filter((r) => r.replayed).length, 19);
    const observer = await connection('reconciler');
    try {
      const counts = await observer.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM fi.commands WHERE sandbox_id=$1',
        [f.id],
      );
      assert.equal(counts.rows[0]?.count, 1);
      assert.equal(
        (await observer.query('SELECT * FROM fi.audit_events WHERE sandbox_id=$1', [f.id]))
          .rowCount,
        1,
      );
    } finally {
      await observer.end();
    }
  } finally {
    await Promise.all(clients.map((db) => db.end()));
    await cleanup([f.id]);
  }
});

await test('conflicting bootstrap key never replaces the original receipt or exposes another owner', async () => {
  const db = await connection('app');
  const f = fixture();
  try {
    assert.equal((await create(db, f)).status, 201);
    assert.equal(
      (await create(db, f, f.key, hash('conflict'))).body.error?.code,
      'IDEMPOTENCY_KEY_REUSED',
    );
    assert.equal((await create(db, { ...f, trade: hash('foreign') })).status, 404);
    assert.equal((await create(db, f)).replayed, true);
    assert.equal((await create(db, f)).body.sandbox?.generation, '1');
  } finally {
    await db.end();
    await cleanup([f.id]);
  }
});

await test('lost rotation response is replayable after recovery with the retained new capability', async () => {
  const db = await connection('app');
  const f = fixture();
  const nextRead = hash('new-read-' + randomUUID()),
    nextTrade = hash('new-trade-' + randomUUID());
  const key = randomUUID(),
    fp = hash('rotate');
  try {
    assert.equal((await create(db, f)).status, 201);
    const args = [f.id, f.trade, '1', '1', nextRead, nextTrade, fp, key, f.actor];
    const first = await db.query<{ result: Result }>(
      'SELECT fi_control.rotate_capabilities($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
      args,
    );
    assert.equal(first.rows[0]?.result.status, 200);
    await db.end();
    const restarted = await connection('app');
    try {
      const old = await restarted.query<{ result: Result }>(
        'SELECT fi_control.read_sandbox($1,$2,$3) AS result',
        [f.id, f.trade, 'trade'],
      );
      assert.equal(old.rows[0]?.result.status, 404);
      const recovered = await restarted.query<{ result: Result }>(
        'SELECT fi_control.read_sandbox($1,$2,$3) AS result',
        [f.id, nextTrade, 'trade'],
      );
      assert.equal(recovered.rows[0]?.result.body.sandbox?.generation, '2');
      const replay = await restarted.query<{ result: Result }>(
        'SELECT fi_control.rotate_capabilities($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
        [f.id, nextTrade, '2', ...args.slice(3)],
      );
      assert.equal(replay.rows[0]?.result.replayed, true);
      assert.deepEqual(replay.rows[0]?.result.body, first.rows[0]?.result.body);
      const stale = await restarted.query<{ result: Result }>(
        'SELECT fi_control.rotate_capabilities($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
        [f.id, nextTrade, '1', '2', hash('r3'), hash('t3'), hash('f3'), randomUUID(), f.actor],
      );
      assert.equal(stale.rows[0]?.result.status, 404);
    } finally {
      await restarted.end();
    }
  } finally {
    await db.end();
    await cleanup([f.id]);
  }
});

await test('transaction rollback discards sandbox, capacity, receipt and audit together', async () => {
  const db = await connection('app');
  const admin = await connection('admin');
  const f = fixture();
  try {
    const before = await scalar(admin, 'SELECT retained_count FROM fi_control.service_capacity');
    await db.query('BEGIN');
    assert.equal((await create(db, f)).status, 201);
    await db.query('ROLLBACK');
    assert.equal(
      await scalar(admin, 'SELECT retained_count FROM fi_control.service_capacity'),
      before,
    );
    assert.equal(
      (await admin.query('SELECT id FROM fi.sandboxes WHERE id=$1', [f.id])).rowCount,
      0,
    );
    assert.equal(
      (await admin.query('SELECT id FROM fi.commands WHERE sandbox_id=$1', [f.id])).rowCount,
      0,
    );
    assert.equal(
      (await admin.query('SELECT command_id FROM fi.audit_events WHERE sandbox_id=$1', [f.id]))
        .rowCount,
      0,
    );
  } finally {
    await db.end();
    await admin.end();
  }
});
