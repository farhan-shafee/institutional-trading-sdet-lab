import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applicationFixture } from './fix-application-fixture.js';
import { connection } from './harness.js';
void test('all new tables force RLS, private application context and immutable application/consumption writes remain denied', async () => {
  const s = await applicationFixture(),
    other = await applicationFixture(),
    db = await connection('app');
  try {
    await s.apply((await s.prepare()).work);
    const tables = [
      'fix_applications',
      'fix_consumptions',
      'fix_protocol_observations',
      'fix_unresolved_ingest',
    ];
    for (const t of tables) {
      assert.equal(
        (
          await db.query<{ v: boolean }>(
            'SELECT relrowsecurity AND relforcerowsecurity v FROM pg_class WHERE oid=$1::regclass',
            ['fi.' + t],
          )
        ).rows[0]!.v,
        true,
      );
      await db.query("SELECT set_config('tradeflow.sandbox_id',$1,false)", [other.id]);
      assert.equal(
        (await db.query(`SELECT * FROM fi.${t} WHERE sandbox_id=$1`, [s.id])).rowCount,
        0,
      );
      for (const sql of [`UPDATE fi.${t} SET sandbox_id=sandbox_id`, `DELETE FROM fi.${t}`])
        await assert.rejects(
          db.query(sql),
          (e: unknown) => (e as { code?: string }).code === '42501',
        );
    }
    await assert.rejects(
      db.query('INSERT INTO fi_control.fix_apply_context VALUES(NULL,NULL,NULL,NULL,NULL,NULL)'),
      (e: unknown) => (e as { code?: string }).code === '42501',
    );
    const p = { order_id: s.order, owner_id: s.owner, fence: s.fence, work_id: randomUUID() };
    const denied = (
      await db.query<{ r: { status: number } }>('SELECT fi_control.apply_fix($1,$2,1,$3,$4,$5) r', [
        s.id,
        other.proof,
        JSON.stringify(p),
        randomUUID(),
        s.actor,
      ])
    ).rows[0]!.r;
    assert.equal(denied.status, 404);
  } finally {
    await db.end();
    await s.close();
    await other.close();
  }
});
void test('a capability rotation invalidates the old prepared owner; new owner reclaims original key/payload/UUIDs under a new fence', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin');
  try {
    const prepared = await s.prepare(),
      newProof = 'b'.repeat(64);
    const before = (await admin.query('SELECT * FROM fi.fix_prepared WHERE sandbox_id=$1', [s.id]))
      .rows;
    const rotated = await s.app.query<{ r: { status: number } }>(
      'SELECT fi_control.rotate_capabilities($1,$2,1,1,$3,$4,$5,$6,$7) r',
      [s.id, s.proof, 'a'.repeat(64), newProof, 'c'.repeat(64), randomUUID(), s.actor],
    );
    assert.equal(rotated.rows[0]!.r.status, 200);
    assert.equal((await s.apply(prepared.work)).status, 404);
    const owner = randomUUID(),
      lease = (
        await s.app.query<{ r: { body: { fence: string } } }>(
          'SELECT fi_control.fix_command($1,$2,2,$3,$4,$5,$6) r',
          [
            s.id,
            newProof,
            'CLAIM',
            JSON.stringify({ order_id: s.order, owner_id: owner }),
            randomUUID(),
            s.actor,
          ],
        )
      ).rows[0]!.r.body;
    assert.equal((await s.apply(prepared.work, randomUUID(), s.app, '2', newProof)).status, 409);
    const p = { order_id: s.order, owner_id: owner, fence: lease.fence, work_id: prepared.work };
    const applied = (
      await s.app.query<{ r: { status: number } }>(
        'SELECT fi_control.apply_fix($1,$2,2,$3,$4,$5) r',
        [s.id, newProof, JSON.stringify(p), randomUUID(), s.actor],
      )
    ).rows[0]!.r;
    assert.equal(applied.status, 200);
    assert.deepEqual(
      (await admin.query('SELECT * FROM fi.fix_prepared WHERE sandbox_id=$1', [s.id])).rows,
      before,
    );
  } finally {
    await admin.end();
    await s.close();
  }
});
