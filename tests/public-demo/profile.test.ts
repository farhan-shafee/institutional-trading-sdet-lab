import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connection, roleTarget } from './database.js';
import pg from 'pg';
import { createHash } from 'node:crypto';

await test('optional public profile supplies bounded ownership without changing legacy financial retention', async () => {
  const app = await connection('app');
  const admin = await connection('admin');
  const maintenance = await connection('maintenance');
  const publicId = randomUUID(),
    legacyId = randomUUID(),
    actor = randomUUID();
  try {
    const available = await app.query<{ present: boolean }>(
      "SELECT to_regprocedure('fi_control.create_public_demo_sandbox(uuid,text,text,text,text,uuid)') IS NOT NULL AS present",
    );
    assert.equal(
      available.rows[0]?.present,
      true,
      'Public ownership function must be installed explicitly.',
    );
    const created = await app.query<{
      result: { status: number; body: { sandbox: Record<string, string> }; replayed: boolean };
    }>('SELECT fi_control.create_public_demo_sandbox($1,$2,$3,$4,$5,$6) AS result', [
      publicId,
      '1'.repeat(64),
      '2'.repeat(64),
      '3'.repeat(64),
      'public_profile_case_1',
      actor,
    ]);
    assert.equal(created.rows[0]!.result.status, 201);
    const body = created.rows[0]!.result.body.sandbox;
    assert.equal(body.id, publicId);
    assert.equal(Date.parse(body.write_expires_at!) - Date.parse(body.created_at!), 1_800_000);
    assert.equal(Date.parse(body.retained_until!) - Date.parse(body.created_at!), 3_600_000);
    const replay = await app.query<{
      result: { status: number; body: unknown; replayed: boolean };
    }>('SELECT fi_control.create_public_demo_sandbox($1,$2,$3,$4,$5,$6) AS result', [
      publicId,
      '1'.repeat(64),
      '2'.repeat(64),
      '3'.repeat(64),
      'public_profile_case_1',
      randomUUID(),
    ]);
    assert.equal(replay.rows[0]!.result.replayed, true);
    assert.deepEqual(replay.rows[0]!.result.body, created.rows[0]!.result.body);
    const conflict = await app.query<{ result: { status: number } }>(
      'SELECT fi_control.create_public_demo_sandbox($1,$2,$3,$4,$5,$6) AS result',
      [publicId, '1'.repeat(64), '2'.repeat(64), '4'.repeat(64), 'public_profile_case_1', actor],
    );
    assert.equal(conflict.rows[0]!.result.status, 409);
    assert.equal(
      (
        await maintenance.query<{ removed: number }>(
          'SELECT fi_control.purge_public_demo_expired() AS removed',
        )
      ).rows[0]!.removed,
      0,
    );
    await assert.rejects(app.query('SELECT fi_control.purge_public_demo_expired()'), {
      code: '42501',
    });
    await assert.rejects(app.query('UPDATE fi.audit_events SET payload=payload'), {
      code: '42501',
    });
    const legacy = await app.query<{
      result: { status: number; body: { sandbox: Record<string, string> } };
    }>('SELECT fi_control.create_sandbox($1,$2,$3,$4,$5,$6) AS result', [
      legacyId,
      '5'.repeat(64),
      '6'.repeat(64),
      '7'.repeat(64),
      'legacy_profile_case_1',
      actor,
    ]);
    assert.equal(legacy.rows[0]!.result.status, 201);
    const old = legacy.rows[0]!.result.body.sandbox;
    assert.equal(Date.parse(old.write_expires_at!) - Date.parse(old.created_at!), 604_800_000);
    assert.equal(Date.parse(old.retained_until!) - Date.parse(old.created_at!), 2_592_000_000);
    await assert.rejects(maintenance.query('SELECT fi_control.purge_public_demo_expired()'), {
      code: '42501',
    });
    assert.equal(
      (
        await admin.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM fi.sandboxes WHERE id=ANY($1::uuid[])',
          [[publicId, legacyId]],
        )
      ).rows[0]!.count,
      2,
    );
  } finally {
    await admin.query(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=ANY($1::uuid[])",
      [[publicId, legacyId]],
    );
    await maintenance.query('SELECT fi_control.purge_expired()');
    await app.end();
    await admin.end();
    await maintenance.end();
  }
});

await test('public retained capacity is atomic at 50 and only expired public graphs reclaim it', async () => {
  const pool = new pg.Pool({ ...(await roleTarget('app')), max: 4 });
  const admin = await connection('admin'),
    maintenance = await connection('maintenance');
  const ids = Array.from({ length: 51 }, () => randomUUID()),
    actor = randomUUID();
  const hash = (id: string, field: string) =>
    createHash('sha256')
      .update(id + field)
      .digest('hex');
  try {
    const results = await Promise.all(
      ids.map((id) =>
        pool.query<{ result: { status: number; body: { error?: { code: string } } } }>(
          'SELECT fi_control.create_public_demo_sandbox($1,$2,$3,$4,$5,$6) AS result',
          [id, hash(id, 'read'), hash(id, 'trade'), hash(id, 'request'), randomUUID(), actor],
        ),
      ),
    );
    assert.equal(results.filter((r) => r.rows[0]!.result.status === 201).length, 50);
    const rejected = results.filter((r) => r.rows[0]!.result.status !== 201);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.rows[0]!.result.status, 503);
    assert.equal(rejected[0]!.rows[0]!.result.body.error?.code, 'SANDBOX_CAPACITY_REACHED');
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
        await admin.query<{ count: number }>(
          'SELECT retained_count AS count FROM fi_control.service_capacity',
        )
      ).rows[0]!.count,
      50,
    );
    const createdIds = ids.filter((_, index) => results[index]!.rows[0]!.result.status === 201);
    const expired = createdIds.slice(0, 25);
    await admin.query(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '2 hours',write_expires_at=clock_timestamp()-interval '90 minutes',retained_until=clock_timestamp()-interval '1 hour' WHERE id=ANY($1::uuid[])",
      [expired],
    );
    assert.equal(
      (
        await maintenance.query<{ removed: number }>(
          'SELECT fi_control.purge_public_demo_expired() AS removed',
        )
      ).rows[0]!.removed,
      25,
    );
    assert.equal(
      (
        await admin.query<{ count: number }>(
          'SELECT retained_count AS count FROM fi_control.service_capacity',
        )
      ).rows[0]!.count,
      25,
    );
    assert.equal(
      (
        await admin.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM fi_control.public_demo_sandboxes',
        )
      ).rows[0]!.count,
      25,
    );
    assert.equal(
      (
        await admin.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM fi.sandboxes WHERE id=ANY($1::uuid[])',
          [expired],
        )
      ).rows[0]!.count,
      0,
    );
    assert.equal(
      (
        await admin.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM fi.sandboxes WHERE id=ANY($1::uuid[])',
          [createdIds.slice(25)],
        )
      ).rows[0]!.count,
      25,
    );
    const untouched = await admin.query<{ valid: boolean }>(
      "SELECT bool_and(write_expires_at-created_at=interval '30 minutes' AND retained_until-created_at=interval '60 minutes') AS valid FROM fi.sandboxes",
    );
    assert.equal(untouched.rows[0]!.valid, true);
  } finally {
    await pool.end();
    await admin.query(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '2 hours',write_expires_at=clock_timestamp()-interval '90 minutes',retained_until=clock_timestamp()-interval '1 hour' WHERE id=ANY($1::uuid[])",
      [ids],
    );
    await maintenance.query('SELECT fi_control.purge_public_demo_expired()');
    await admin.end();
    await maintenance.end();
  }
});

await test('public cleanup bounds retired UUID metadata while preserving all legacy tombstones', async () => {
  const app = await connection('app'),
    admin = await connection('admin'),
    maintenance = await connection('maintenance');
  const id = randomUUID();
  const old = (
    await admin.query<{ id: string }>('SELECT id FROM fi_control.purged_sandboxes ORDER BY id')
  ).rows;
  try {
    const created = await app.query<{ result: { status: number } }>(
      'SELECT fi_control.create_public_demo_sandbox($1,$2,$3,$4,$5,$6) AS result',
      [id, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), randomUUID(), randomUUID()],
    );
    assert.equal(created.rows[0]!.result.status, 201);
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
      1,
    );
    assert.equal(
      (
        await admin.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM fi_control.purged_sandboxes WHERE id=$1',
          [id],
        )
      ).rows[0]!.count,
      0,
    );
    assert.deepEqual(
      (
        await admin.query<{ id: string }>(
          'SELECT id FROM fi_control.purged_sandboxes WHERE id<>$1 ORDER BY id',
          [id],
        )
      ).rows,
      old,
    );
  } finally {
    await app.end();
    await admin.end();
    await maintenance.end();
  }
});
