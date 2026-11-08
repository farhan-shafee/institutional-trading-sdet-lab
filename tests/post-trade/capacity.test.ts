import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { postTradeSandbox, connection, randomUUID, digest } from './fixture.js';

async function counts(db: pg.Client, id: string) {
  const r = (
    await db.query<{
      c: number;
      e: number;
      pc: number;
      pe: number;
      commands: number;
      events: number;
      pt_commands: number;
      pt_events: number;
    }>(
      `SELECT s.command_count c,s.event_count e,COALESCE(b.command_count,0) pc,COALESCE(b.event_count,0) pe,
    (SELECT count(*)::int FROM fi.commands WHERE sandbox_id=s.id) commands,
    (SELECT count(*)::int FROM fi.audit_events WHERE sandbox_id=s.id) events,
    (SELECT count(*)::int FROM fi.posttrade_commands WHERE sandbox_id=s.id) pt_commands,
    (SELECT count(*)::int FROM fi.posttrade_events WHERE sandbox_id=s.id) pt_events
    FROM fi.sandboxes s LEFT JOIN fi.posttrade_books b ON b.sandbox_id=s.id WHERE s.id=$1`,
      [id],
    )
  ).rows[0]!;
  assert.equal(r.c, r.commands);
  assert.equal(r.e, r.events);
  assert.equal(r.pc, r.pt_commands);
  assert.equal(r.pe, r.pt_events);
  return r;
}
// Privileged fixture appends valid rejected-command/audit rows through the original
// writer. Never edit counters or disable triggers to manufacture a boundary.
async function pad(db: pg.Client, id: string, target: number, dimension: 'commands' | 'events') {
  const initial = await counts(db, id),
    difference = target - (dimension === 'commands' ? initial.c : initial.e);
  assert.ok(difference >= 0);
  const rows = dimension === 'commands' ? difference : Math.ceil(difference / 3);
  await db.query('SET ROLE tf_owner');
  try {
    for (let i = 0; i < rows; i++) {
      const n = dimension === 'commands' ? 1 : Math.min(3, difference - i * 3);
      const events = Array.from({ length: n }, () => ({
        type: 'COMMAND_REJECTED',
        payload: { code: 'RFQ_VERSION_CONFLICT' },
      }));
      await db.query(
        'SELECT fi_control.record_rfq_command($1,$2,$3,$4,409,$5,$6,$7,clock_timestamp())',
        [
          id,
          randomUUID(),
          'a'.repeat(64),
          'RESPOND_DEALER',
          JSON.stringify({ error: { code: 'RFQ_VERSION_CONFLICT' } }),
          JSON.stringify(events),
          randomUUID(),
        ],
      );
    }
  } finally {
    await db.query('RESET ROLE');
  }
  const actual = await counts(db, id);
  assert.equal(dimension === 'commands' ? actual.c : actual.e, target);
}
for (const c of [414, 415, 416])
  await test('97-command allocation admits exactly remaining capacity at legacy ' + c, async () => {
    const s = await postTradeSandbox(),
      admin = await connection('admin');
    try {
      await pad(admin, s.id, c, 'commands');
      const before = await counts(admin, s.id);
      if (c <= 415) {
        assert.equal(
          (await s.command('INITIALIZE', { economic_start_date: '2030-01-15' })).status,
          201,
        );
        const after = await counts(admin, s.id);
        assert.equal(after.c, before.c);
        assert.equal(after.pc, 1);
        assert.equal(after.pe, 1);
        assert.ok(after.c + after.pc + (97 - after.pc) <= 512);
        if (c === 415) {
          await assert.rejects(pad(admin, s.id, 416, 'commands'), { code: 'TF429' });
          assert.deepEqual(await counts(admin, s.id), after);
        }
      } else {
        await assert.rejects(s.command('INITIALIZE', { economic_start_date: '2030-01-15' }), {
          code: 'TF429',
        });
        assert.deepEqual(await counts(admin, s.id), before);
      }
    } finally {
      await admin.end();
      await s.close();
    }
  });
for (const e of [862, 863, 864])
  await test('161-event allocation admits exactly remaining capacity at legacy ' + e, async () => {
    const s = await postTradeSandbox(),
      admin = await connection('admin');
    try {
      await pad(admin, s.id, e, 'events');
      const before = await counts(admin, s.id);
      if (e <= 863) {
        assert.equal(
          (await s.command('INITIALIZE', { economic_start_date: '2030-01-15' })).status,
          201,
        );
        const after = await counts(admin, s.id);
        assert.equal(after.e, before.e);
        assert.equal(after.pe, 1);
        assert.ok(after.e + after.pe + (161 - after.pe) <= 1024);
        if (e === 863) {
          await assert.rejects(pad(admin, s.id, 864, 'events'), { code: 'TF429' });
          assert.deepEqual(await counts(admin, s.id), after);
        }
      } else {
        await assert.rejects(s.command('INITIALIZE', { economic_start_date: '2030-01-15' }), {
          code: 'TF429',
        });
        assert.deepEqual(await counts(admin, s.id), before);
      }
    } finally {
      await admin.end();
      await s.close();
    }
  });
await test('initialization racing an unrelated financial receipt cannot reserve the same last slot', async () => {
  const s = await postTradeSandbox(),
    admin = await connection('admin'),
    writer = await connection('admin');
  try {
    await pad(admin, s.id, 415, 'commands');
    const outcomes = await Promise.allSettled([
      s.command('INITIALIZE', { economic_start_date: '2030-01-15' }),
      pad(writer, s.id, 416, 'commands'),
    ]);
    assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = outcomes.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal((rejected.reason as { code: string }).code, 'TF429');
    const actual = await counts(admin, s.id);
    assert.ok(actual.c + (actual.pc ? 97 : 0) <= 512);
    assert.equal(actual.c, actual.pc ? 415 : 416);
  } finally {
    await writer.end();
    await admin.end();
    await s.close();
  }
});

import { fixture as fixFixture } from '../postgres/fix-fixture.js';

for (const mode of ['POSTTRADE_FIRST', 'FIX_FIRST'] as const)
  for (const legacy of [388, 389])
    await test(mode + ' shares B2 25/43 and two security slots at legacy ' + legacy, async () => {
      const s = await fixFixture('100.00', 'BUY', 'SYN-UST-2031', '2030-01-15');
      const admin = await connection('admin');
      const initialize = () =>
        s.app.query<{ r: { status: number } }>(
          'SELECT fi_control.posttrade_command($1,$2,1,$3,$4,$5,$6) r',
          [
            s.id,
            s.proof,
            'INITIALIZE',
            JSON.stringify({ economic_start_date: '2030-01-15' }),
            randomUUID(),
            s.actor,
          ],
        );
      try {
        if (mode === 'POSTTRADE_FIRST') assert.equal((await initialize()).rows[0]!.r.status, 201);
        await pad(admin, s.id, legacy, 'commands');
        if (mode === 'POSTTRADE_FIRST') {
          if (legacy === 388) assert.equal((await s.bind()).status, 201);
          else assert.equal((await s.bind()).status, 429);
        } else {
          assert.equal((await s.bind()).status, 201);
          if (legacy === 388) assert.equal((await initialize()).rows[0]!.r.status, 201);
          else await assert.rejects(initialize(), { code: 'TF429' });
        }
        const actual = await counts(admin, s.id);
        const reservation = (
          await admin.query<{ c: number; e: number; h: number }>(
            `SELECT COALESCE(sum(r.commands-x.c),0)::int c,COALESCE(sum(r.events-x.e),0)::int e,
          greatest(2-(SELECT count(*) FROM fi.commands WHERE sandbox_id=$1 AND operation='ROTATE_CAPABILITIES'
          AND created_at >= (SELECT min(created_at) FROM fi.fix_bindings WHERE sandbox_id=$1)),0)::int h
          FROM fi_control.fix_reservations r LEFT JOIN LATERAL(
          SELECT COALESCE(sum(commands),0)::int c,COALESCE(sum(events),0)::int e FROM fi.fix_consumptions
          WHERE sandbox_id=r.sandbox_id AND order_id=r.order_id) x ON true
          WHERE r.sandbox_id=$1 AND r.released_at IS NULL`,
            [s.id],
          )
        ).rows[0]!;
        const head = reservation.c || reservation.e ? reservation.h : 0;
        assert.ok(actual.c + (actual.pc ? 97 : 0) + reservation.c + head <= 512);
        assert.ok(actual.e + (actual.pc ? 161 : 0) + reservation.e + head <= 1024);
        if (legacy === 388) {
          assert.deepEqual(reservation, { c: 25, e: 43, h: 2 });
          const before = await counts(admin, s.id);
          await assert.rejects(pad(admin, s.id, 389, 'commands'), { code: 'TF429' });
          assert.deepEqual(await counts(admin, s.id), before);
        } else if (mode === 'POSTTRADE_FIRST') {
          assert.equal(
            (
              await admin.query<{ n: number }>(
                'SELECT count(*)::int n FROM fi.fix_bindings WHERE sandbox_id=$1',
                [s.id],
              )
            ).rows[0]!.n,
            0,
          );
        } else assert.equal(actual.pc, 0);
      } finally {
        await admin.end();
        await s.close();
      }
    });
await test('only the two remaining real capability rotations consume reserved security headroom', async () => {
  const s = await fixFixture('100.00', 'BUY', 'SYN-UST-2031', '2030-01-15'),
    admin = await connection('admin');
  let proof = s.proof,
    generation = 1;
  try {
    assert.equal(
      (
        await s.app.query<{ r: { status: number } }>(
          'SELECT fi_control.posttrade_command($1,$2,1,$3,$4,$5,$6) r',
          [
            s.id,
            proof,
            'INITIALIZE',
            JSON.stringify({ economic_start_date: '2030-01-15' }),
            randomUUID(),
            s.actor,
          ],
        )
      ).rows[0]!.r.status,
      201,
    );
    await pad(admin, s.id, 388, 'commands');
    assert.equal((await s.bind()).status, 201);
    for (let i = 0; i < 3; i++) {
      const nextRead = digest('new-read-' + randomUUID()),
        nextTrade = digest('new-trade-' + randomUUID());
      const result = (
        await s.app.query<{ r: { status: number } }>(
          'SELECT fi_control.rotate_capabilities($1,$2,$3,$3,$4,$5,$6,$7,$8) r',
          [
            s.id,
            proof,
            String(generation),
            nextRead,
            nextTrade,
            'a'.repeat(64),
            randomUUID(),
            s.actor,
          ],
        )
      ).rows[0]!.r;
      assert.equal(result.status, i < 2 ? 200 : 429);
      if (i < 2) {
        proof = nextTrade;
        generation++;
      }
      const actual = await counts(admin, s.id);
      const rotations = (
        await admin.query<{ n: number }>(
          "SELECT count(*)::int n FROM fi.commands WHERE sandbox_id=$1 AND operation='ROTATE_CAPABILITIES'",
          [s.id],
        )
      ).rows[0]!.n;
      assert.equal(rotations, Math.min(i + 1, 2));
      assert.equal(actual.c, 388 + rotations);
      assert.equal(actual.c + 97 + 25 + Math.max(2 - rotations, 0), 512);
    }
  } finally {
    await admin.end();
    await s.close();
  }
});
await test('new FIX BIND racing initialization serializes one combined reservation', async () => {
  const s = await fixFixture('100.00', 'BUY', 'SYN-UST-2031', '2030-01-15');
  const admin = await connection('admin'),
    other = await connection('app');
  try {
    await pad(admin, s.id, 389, 'commands');
    const outcomes = await Promise.allSettled([
      s.app.query<{ r: { status: number } }>(
        'SELECT fi_control.posttrade_command($1,$2,1,$3,$4,$5,$6) r',
        [
          s.id,
          s.proof,
          'INITIALIZE',
          JSON.stringify({ economic_start_date: '2030-01-15' }),
          randomUUID(),
          s.actor,
        ],
      ),
      s.fix(
        'BIND',
        { order_id: s.order, dealer_id: 'ATLAS', channel_id: s.channel },
        randomUUID(),
        other,
      ),
    ]);
    const statuses = outcomes.map((r) =>
      r.status === 'rejected'
        ? (r.reason as { code: string }).code
        : 'rows' in r.value
          ? r.value.rows[0]!.r.status
          : r.value.status,
    );
    assert.equal(statuses.filter((v) => v === 201).length, 1);
    assert.equal(statuses.filter((v) => v === 429 || v === 'TF429').length, 1);
    const actual = await counts(admin, s.id);
    const reservations = (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM fi_control.fix_reservations WHERE sandbox_id=$1 AND released_at IS NULL',
        [s.id],
      )
    ).rows[0]!.n;
    assert.equal(Number(actual.pc > 0) + reservations, 1);
    assert.ok(actual.c + (actual.pc ? 97 : 0) + reservations * 27 <= 512);
  } finally {
    await other.end();
    await admin.end();
    await s.close();
  }
});
