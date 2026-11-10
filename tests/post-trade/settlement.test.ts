import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connection, randomUUID } from './fixture.js';
import { fundedBook, available, duePayload } from './settlement-fixture.js';

await test('gross BUY DVP and exact inverse are atomic, conservative, replayable and terminal per revision', async () => {
  const s = await fundedBook(),
    admin = await connection('admin');
  try {
    const payload = duePayload(s.raw.id),
      key = randomUUID(),
      cash = BigInt(s.raw.consideration_cents);
    const before = await s.read();
    const posted = await s.post('SETTLE', payload, key);
    assert.equal(posted.status, 200);
    const after = await s.read();
    assert.equal(after.available_cash_cents, String(10000000000n - cash));
    assert.equal(Number(available(after)), 100);
    assert.equal(after.roots[0]!.settlement_state, 'SETTLED');
    assert.equal((await s.post('SETTLE', payload, key)).replayed, true);
    assert.equal((await s.post('SETTLE', payload)).status, 409);
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          execution_id: s.raw.id,
          expected_revision: 0,
          clean_price: '100.000000000000',
        })
      ).status,
      409,
    );
    assert.equal(
      (await s.post('BUST', { execution_id: s.raw.id, expected_revision: 0 })).status,
      409,
    );
    const reverseKey = randomUUID();
    const reversed = await s.post('REVERSE', payload, reverseKey);
    assert.equal(reversed.status, 200);
    const final = await s.read();
    assert.equal(final.available_cash_cents, before.available_cash_cents);
    assert.equal(Number(available(final)), 0);
    assert.equal(final.roots[0]!.settlement_state, 'REVERSED');
    assert.equal((await s.post('REVERSE', payload, reverseKey)).replayed, true);
    assert.equal((await s.post('REVERSE', payload)).status, 409);
    assert.equal((await s.post('SETTLE', payload)).status, 409);
    const conservation = (
      await admin.query<{ cash: string; par: string; events: number }>(
        'SELECT sum(cash_cents+counterparty_cash_cents)::text cash,sum(par_amount+counterparty_par)::text par,count(*)::int events FROM fi.posttrade_events WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!;
    assert.equal(BigInt(conservation.cash), 0n);
    assert.equal(Number(conservation.par), 0);
    assert.equal(conservation.events, 6);
    const oldSource = await s.read('3');
    assert.equal(oldSource.available_cash_cents, after.available_cash_cents);
    assert.equal(oldSource.roots[0]!.settlement_state, 'SETTLED');
  } finally {
    await admin.end();
    await s.close();
  }
});
await test('gross SELL has no partial delivery, failed original keys replay and two failures do not bar a funded success', async () => {
  const s = await fundedBook({ side: 'SELL' }),
    admin = await connection('admin');
  try {
    const payload = duePayload(s.raw.id),
      keys = [randomUUID(), randomUUID()];
    const before = await s.read();
    for (const key of keys) {
      const failed = await s.post('SETTLE', payload, key);
      assert.equal(failed.status, 409);
      assert.equal(failed.body['settlement_state'], 'FAILED');
      assert.equal((await s.post('SETTLE', payload, key)).replayed, true);
    }
    assert.equal((await s.post('SETTLE', payload)).status, 429);
    const failed = await s.read();
    assert.equal(failed.available_cash_cents, before.available_cash_cents);
    assert.equal(Number(available(failed)), 0);
    const buy = await s.additional('50.00');
    assert.equal((await s.post('SETTLE', duePayload(buy.id))).status, 200);
    const partial = await s.read();
    assert.equal(Number(available(partial)), 50);
    assert.equal((await s.post('SETTLE', payload)).status, 429);
    assert.equal(Number(available(await s.read())), 50);
    const buy2 = await s.additional('50.00');
    assert.equal((await s.post('SETTLE', duePayload(buy2.id))).status, 200);
    assert.equal((await s.post('SETTLE', payload)).status, 200);
    assert.equal(Number(available(await s.read())), 0);
    assert.equal((await s.post('SETTLE', payload, keys[0])).status, 409);
    const counts = (
      await admin.query<{ failures: number; settled: number }>(
        "SELECT count(*) FILTER(WHERE outcome='FAILED')::int failures,count(*) FILTER(WHERE outcome='SETTLED')::int settled FROM fi.posttrade_settlement_outcomes WHERE sandbox_id=$1 AND execution_id=$2",
        [s.id, s.raw.id],
      )
    ).rows[0]!;
    assert.deepEqual(counts, { failures: 2, settled: 1 });
  } finally {
    await admin.end();
    await s.close();
  }
});
await test('correcting a failed obligation preserves the lifetime failed-attempt cap and creates a fresh revision', async () => {
  const s = await fundedBook({ parentPar: '200000000.00', dueDate: '2025-01-15' });
  try {
    for (let i = 0; i < 2; i++)
      assert.equal((await s.post('SETTLE', duePayload(s.raw.id, 0, '2025-01-15'))).status, 409);
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          execution_id: s.raw.id,
          expected_revision: 0,
          clean_price: '10.000000000000',
        })
      ).status,
      201,
    );
    assert.equal((await s.read()).roots[0]!.settlement_state, 'PENDING');
    assert.equal((await s.post('SETTLE', duePayload(s.raw.id, 1, '2025-01-15'))).status, 200);
    assert.equal((await s.read()).available_cash_cents, '8000000000');
  } finally {
    await s.close();
  }
});
await test('inverse DVP refuses unavailable securities or cash and changes neither balance nor receipt count', async () => {
  const s = await fundedBook({ parentPar: '60000000.00' });
  try {
    assert.equal((await s.post('SETTLE', duePayload(s.raw.id))).status, 200);
    const sell = await s.additional('60000000.00', 'SELL');
    assert.equal((await s.post('SETTLE', duePayload(sell.id))).status, 200);
    const noPar = await s.read();
    assert.equal((await s.post('REVERSE', duePayload(s.raw.id))).status, 409);
    assert.deepEqual(await s.read(), noPar);
    const larger = await s.additional('90000000.00');
    assert.equal((await s.post('SETTLE', duePayload(larger.id))).status, 200);
    const noCash = await s.read();
    assert.ok(BigInt(noCash.available_cash_cents) < BigInt(sell.consideration_cents));
    assert.equal((await s.post('REVERSE', duePayload(sell.id))).status, 409);
    assert.deepEqual(await s.read(), noCash);
  } finally {
    await s.close();
  }
});
await test('processing uses explicit weekday due/window dates and admitted attempts cannot move the watermark backwards', async () => {
  const s = await fundedBook({ dueDate: '2030-01-17', windowStart: '2030-01-15' }),
    admin = await connection('admin');
  try {
    const before = await s.read();
    for (const [date, status] of [
      ['2030-01-16', 409],
      ['2030-01-19', 400],
      ['2030-07-15', 409],
      ['2030-02-30', 400],
    ] as const)
      assert.equal((await s.post('SETTLE', duePayload(s.raw.id, 0, date))).status, status, date);
    assert.deepEqual(await s.read(), before);
    assert.equal((await s.post('SETTLE', duePayload(s.raw.id, 0, '2030-01-18'))).status, 200);
    const posted = await s.read();
    assert.equal(posted.processing_date_watermark, '2030-01-18');
    assert.equal((await s.post('REVERSE', duePayload(s.raw.id, 0, '2030-01-17'))).status, 409);
    assert.deepEqual(await s.read(), posted);
    assert.equal((await s.post('REVERSE', duePayload(s.raw.id, 0, '2030-01-18'))).status, 200);
    const audit = (
      await admin.query<{ actual: boolean }>(
        "SELECT bool_and(recorded_at>=clock_timestamp()-interval '1 minute' AND recorded_at<=clock_timestamp() AND processing_date='2030-01-18') actual FROM fi.posttrade_settlement_outcomes WHERE sandbox_id=$1",
        [s.id],
      )
    ).rows[0]!;
    assert.equal(audit.actual, true);
  } finally {
    await admin.end();
    await s.close();
  }
});
await test('failed simulated processing also advances the watermark without supplying cash or securities', async () => {
  const s = await fundedBook({ side: 'SELL' });
  try {
    assert.equal((await s.post('SETTLE', duePayload(s.raw.id, 0, '2030-01-17'))).status, 409);
    const failed = await s.read();
    assert.equal(failed.processing_date_watermark, '2030-01-17');
    assert.equal((await s.post('SETTLE', duePayload(s.raw.id, 0, '2030-01-16'))).status, 409);
    assert.deepEqual(await s.read(), failed);
    assert.equal(failed.available_cash_cents, '10000000000');
    assert.equal(Number(available(failed)), 0);
  } finally {
    await s.close();
  }
});
await test('zero-cash corrected DVP still posts and reverses both explicit legs', async () => {
  const s = await fundedBook({ parentPar: '1.00', fillPar: '0.01', dueDate: '2025-01-15' });
  try {
    assert.equal(
      (
        await s.post('CORRECT_PRICE', {
          execution_id: s.raw.id,
          expected_revision: 0,
          clean_price: '10.000000000000',
        })
      ).status,
      201,
    );
    assert.equal((await s.post('SETTLE', duePayload(s.raw.id, 1, '2025-01-15'))).status, 200);
    assert.equal((await s.read()).available_cash_cents, '10000000000');
    assert.equal(Number(available(await s.read())), 0.01);
    assert.equal((await s.post('REVERSE', duePayload(s.raw.id, 1, '2025-01-15'))).status, 200);
    assert.equal(Number(available(await s.read())), 0);
    assert.equal((await s.read()).available_cash_cents, '10000000000');
  } finally {
    await s.close();
  }
});
await test('settlement and correction contenders serialize posting or new revision without superseding settled cash', async () => {
  const s = await fundedBook(),
    other = await connection('app');
  try {
    const replies = await Promise.all([
      s.post('SETTLE', duePayload(s.raw.id)),
      s.post(
        'CORRECT_PRICE',
        { execution_id: s.raw.id, expected_revision: 0, clean_price: '100.000000000000' },
        randomUUID(),
        other,
      ),
    ]);
    assert.equal(replies.filter((r) => r.status === 200 || r.status === 201).length, 1);
    assert.equal(replies.filter((r) => r.status === 409).length, 1);
    const root = (await s.read()).roots[0]!;
    assert.ok(
      (root.current_revision === 0 && root.settlement_state === 'SETTLED') ||
        (root.current_revision === 1 && root.settlement_state === 'PENDING'),
    );
  } finally {
    await other.end();
    await s.close();
  }
});

await test('failed obligations void on full bust while their original failure receipt remains immutable', async () => {
  const s = await fundedBook({ side: 'SELL' }),
    key = randomUUID(),
    payload = duePayload(s.raw.id);
  try {
    const failed = await s.post('SETTLE', payload, key);
    assert.equal(failed.status, 409);
    assert.equal(
      (await s.post('BUST', { execution_id: s.raw.id, expected_revision: 0 })).status,
      201,
    );
    assert.equal((await s.read()).roots[0]!.settlement_state, 'VOIDED');
    assert.equal((await s.post('SETTLE', payload)).status, 409);
    const replay = await s.post('SETTLE', payload, key);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, failed.body);
    assert.equal((await s.post('SETTLE', payload, key, s.app, '2')).status, 404);
    assert.equal((await s.post('SETTLE', payload, key, s.app, '1', '0'.repeat(64))).status, 404);
    assert.equal((await s.read()).available_cash_cents, '10000000000');
  } finally {
    await s.close();
  }
});
await test('each original eligible instrument uses its own available-security account', async () => {
  const s = await fundedBook({ instrument: 'SYN-CORP-2031' });
  try {
    assert.equal((await s.post('SETTLE', duePayload(s.raw.id))).status, 200);
    const source = await s.read();
    assert.equal(Number(available(source, 'SYN-CORP-2031')), 100);
    assert.equal(Number(available(source, 'SYN-UST-2031')), 0);
    assert.equal((await s.post('REVERSE', duePayload(s.raw.id))).status, 200);
    assert.equal(Number(available(await s.read(), 'SYN-CORP-2031')), 0);
  } finally {
    await s.close();
  }
});
