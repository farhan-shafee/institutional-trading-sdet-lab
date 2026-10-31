import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applicationFixture } from './fix-application-fixture.js';
import { connection } from './harness.js';
void test('entire25-command41-audit lifecycle spends only actual effects at protected512 boundary; manual writer and rotation retain safeguards', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin');
  try {
    const other = await s.createOrder();
    const actual = (
      await admin.query<{ n: number }>('SELECT command_count n FROM fi.sandboxes WHERE id=$1', [
        s.id,
      ])
    ).rows[0]!.n;
    for (let i = actual; i < 485; i++)
      assert.equal(
        (await s.command('ACK_ORDER', { order_id: other, expected_version: '999' })).status,
        409,
      );
    await s.claim();
    assert.equal((await s.apply((await s.prepare()).work)).status, 200);
    const px = (
      await s.app.query<{ contract: Record<string, string> }>(
        'SELECT contract FROM fi.orders WHERE sandbox_id=$1 AND id=$2',
        [s.id, s.order],
      )
    ).rows[0]!.contract['clean_price']!;
    for (let i = 1; i <= 8; i++) {
      const cancel = randomUUID(),
        base = { '11': cancel, '41': s.order };
      assert.equal(
        (
          await s.apply(
            (await s.prepare({ '35': 'F', '49': 'TRADEFLOW', '56': 'ATLAS', ...base })).work,
          )
        ).status,
        200,
      );
      const cum = (BigInt(i) * 1250n).toString().padStart(3, '0'),
        left = (10000n - BigInt(i) * 1250n).toString().padStart(3, '0');
      const fmt = (v: string) => v.slice(0, -2) + '.' + v.slice(-2);
      assert.equal(
        (
          await s.apply(
            (
              await s.prepare({
                '150': 'F',
                '39': i === 8 ? '2' : '1',
                '14': fmt(cum),
                '151': fmt(left),
                '32': '12.50',
                '31': px,
                '6': px,
              })
            ).work,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await s.apply(
            (
              await s.prepare({
                '35': '9',
                ...base,
                '39': i === 8 ? '2' : '1',
                '434': '1',
                '102': i === 8 ? '0' : '99',
              })
            ).work,
          )
        ).status,
        200,
      );
    }
    assert.deepEqual(
      (
        await admin.query(
          'SELECT count(*)::int commands,sum(events)::int events FROM fi.fix_consumptions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows,
      [{ commands: 25, events: 41 }],
    );
    assert.equal(
      (
        await admin.query<{ command_count: number }>(
          'SELECT command_count FROM fi.sandboxes WHERE id=$1',
          [s.id],
        )
      ).rows[0]!.command_count,
      510,
    );
    assert.equal(
      (await s.command('ACK_ORDER', { order_id: other, expected_version: '1' })).status,
      429,
    );
    const rotated = (
      await s.app.query<{ r: { status: number } }>(
        'SELECT fi_control.rotate_capabilities($1,$2,1,1,$3,$4,$5,$6,$7) r',
        [s.id, s.proof, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), randomUUID(), s.actor],
      )
    ).rows[0]!.r;
    assert.equal(rotated.status, 200);
    assert.equal(
      (
        await admin.query<{ n: number }>('SELECT command_count n FROM fi.sandboxes WHERE id=$1', [
          s.id,
        ])
      ).rows[0]!.n,
      511,
    );
  } finally {
    await admin.end();
    await s.close();
  }
});
void test('rotation spends one shared recovery slot without stranding already protected prepared financial work at quota', async () => {
  const s = await applicationFixture(),
    admin = await connection('admin');
  try {
    const other = await s.createOrder(),
      p = await s.prepare();
    const actual = (
      await admin.query<{ n: number }>('SELECT command_count n FROM fi.sandboxes WHERE id=$1', [
        s.id,
      ])
    ).rows[0]!.n;
    for (let i = actual; i < 485; i++)
      assert.equal(
        (await s.command('ACK_ORDER', { order_id: other, expected_version: '999' })).status,
        409,
      );
    const proof = 'b'.repeat(64);
    assert.equal(
      (
        await s.app.query<{ r: { status: number } }>(
          'SELECT fi_control.rotate_capabilities($1,$2,1,1,$3,$4,$5,$6,$7) r',
          [s.id, s.proof, 'a'.repeat(64), proof, 'c'.repeat(64), randomUUID(), s.actor],
        )
      ).rows[0]!.r.status,
      200,
    );
    const owner = randomUUID(),
      lease = (
        await s.app.query<{ r: { body: { fence: string } } }>(
          'SELECT fi_control.fix_command($1,$2,2,$3,$4,$5,$6) r',
          [
            s.id,
            proof,
            'CLAIM',
            JSON.stringify({ order_id: s.order, owner_id: owner }),
            randomUUID(),
            s.actor,
          ],
        )
      ).rows[0]!.r.body;
    const r = (
      await s.app.query<{ r: { status: number } }>(
        'SELECT fi_control.apply_fix($1,$2,2,$3,$4,$5) r',
        [
          s.id,
          proof,
          JSON.stringify({
            order_id: s.order,
            owner_id: owner,
            fence: lease.fence,
            work_id: p.work,
          }),
          randomUUID(),
          s.actor,
        ],
      )
    ).rows[0]!.r;
    assert.equal(r.status, 200);
  } finally {
    await admin.end();
    await s.close();
  }
});
