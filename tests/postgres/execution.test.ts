import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connection } from './harness.js';
import { executionSandbox } from './execution-fixture.js';

await test('immutable contract survives acknowledgment, partial executions, and full execution with exact positions', async () => {
  const s = await executionSandbox();
  const admin = await connection('admin');
  try {
    const contract = (
      await admin.query<Record<string, unknown>>('SELECT * FROM fi.orders WHERE sandbox_id=$1', [
        s.id,
      ])
    ).rows;
    assert.equal((await s.fill('1', '1.00')).body.error?.code, 'ORDER_NOT_EXECUTABLE');
    assert.equal(
      (await s.command('ACK_ORDER', { expected_version: '1' })).body.lifecycle.status,
      'NEW',
    );
    const a = await s.fill('2', '40.00');
    assert.equal(a.status, 201);
    assert.equal(a.body.lifecycle.status, 'PARTIALLY_FILLED');
    const b = await s.fill('3', '60.00');
    assert.equal(b.status, 201);
    assert.equal(b.body.lifecycle.status, 'FILLED');
    assert.equal(b.body.lifecycle.filled_par, '100.00');
    assert.equal(b.body.lifecycle.remaining_par, '0.00');
    assert.equal((await s.fill('4', '1.00')).body.error?.code, 'ORDER_NOT_EXECUTABLE');
    assert.deepEqual(
      (
        await admin.query<Record<string, unknown>>('SELECT * FROM fi.orders WHERE sandbox_id=$1', [
          s.id,
        ])
      ).rows,
      contract,
    );
    const p = (
      await admin.query<Record<string, unknown>>(
        'SELECT signed_par::text,signed_cash_cents::text,execution_count FROM fi.positions WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0];
    assert.equal(p.signed_par, '100.00');
    assert.equal(p.signed_cash_cents, (-BigInt(b.body.lifecycle.executed_cents)).toString());
    assert.equal(p.execution_count, 2);
  } finally {
    await admin.end();
    await s.close();
  }
});
await test('source identity and idempotency replay create exactly one execution', async () => {
  const s = await executionSandbox();
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    const input = {
        expected_version: '2',
        source_event_id: randomUUID(),
        execution_id: randomUUID(),
        par_amount: '25.00',
      },
      key = randomUUID();
    const a = await s.command('EXECUTE_ORDER', input, key);
    assert.equal(a.status, 201);
    assert.deepEqual((await s.command('EXECUTE_ORDER', input, key)).body, a.body);
    const duplicate = await s.command('EXECUTE_ORDER', { ...input, expected_version: '3' });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.execution?.id, input.execution_id);
    assert.equal(
      (await s.command('EXECUTE_ORDER', { ...input, par_amount: '26.00', expected_version: '3' }))
        .body.error?.code,
      'SOURCE_EVENT_CONFLICT',
    );
    assert.equal(
      (await s.command('EXECUTE_ORDER', { ...input, par_amount: '26.00' }, key)).body.error?.code,
      'IDEMPOTENCY_KEY_REUSED',
    );
  } finally {
    await s.close();
  }
});
await test('cancel request preserves executable state, partial fill then cancel retains filled quantity', async () => {
  const s = await executionSandbox();
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    const cid = randomUUID();
    const r = await s.command('REQUEST_CANCEL', { expected_version: '2', cancel_id: cid });
    assert.equal(r.body.lifecycle.status, 'NEW');
    assert.equal(r.body.lifecycle.pending_cancel_id, cid);
    const fill = await s.fill('3', '40.00');
    assert.equal(fill.body.lifecycle.filled_par, '40.00');
    const canceled = await s.command('ACK_CANCEL', { expected_version: '4', cancel_id: cid });
    assert.equal(canceled.body.lifecycle.status, 'CANCELED');
    assert.equal(canceled.body.lifecycle.remaining_par, '0.00');
    assert.equal(canceled.body.lifecycle.filled_par, '40.00');
    assert.equal((await s.fill('5', '1.00')).body.error?.code, 'ORDER_NOT_EXECUTABLE');
  } finally {
    await s.close();
  }
});
await test('business rejection is terminal and acknowledgment alone creates no position', async () => {
  const s = await executionSandbox();
  const db = await connection('reconciler');
  try {
    assert.equal(
      (await s.command('REJECT_ORDER', { expected_version: '1' })).body.lifecycle.status,
      'REJECTED',
    );
    for (const action of ['ACK_ORDER', 'REJECT_ORDER', 'EXECUTE_ORDER', 'REQUEST_CANCEL']) {
      const payload: Record<string, unknown> = { expected_version: '2' };
      if (action === 'EXECUTE_ORDER')
        Object.assign(payload, {
          execution_id: randomUUID(),
          source_event_id: randomUUID(),
          par_amount: '1.00',
        });
      if (action === 'REQUEST_CANCEL') payload.cancel_id = randomUUID();
      assert.equal((await s.command(action, payload)).status, 409);
    }
    assert.equal(
      (
        await db.query<Record<string, unknown>>('SELECT * FROM fi.positions WHERE sandbox_id=$1', [
          s.id,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await db.end();
    await s.close();
  }
});
await test('all active cancellation paths, full-fill too-late outcome, and duplicate outcomes are explicit', async () => {
  for (const partial of [false, true])
    for (const outcome of ['ACK_CANCEL', 'REJECT_CANCEL']) {
      const s = await executionSandbox();
      try {
        await s.command('ACK_ORDER', { expected_version: '1' });
        let version = 2;
        if (partial) {
          await s.fill(String(version++), '10.00');
        }
        const cid = randomUUID();
        assert.equal(
          (
            await s.command('REQUEST_CANCEL', {
              expected_version: String(version++),
              cancel_id: cid,
            })
          ).status,
          201,
        );
        assert.equal(
          (
            await s.command('REQUEST_CANCEL', {
              expected_version: String(version),
              cancel_id: randomUUID(),
            })
          ).body.error?.code,
          'CANCEL_ALREADY_PENDING',
        );
        const r = await s.command(outcome, { expected_version: String(version++), cancel_id: cid });
        assert.equal(r.status, 200);
        assert.equal(
          r.body.lifecycle.status,
          outcome === 'ACK_CANCEL' ? 'CANCELED' : partial ? 'PARTIALLY_FILLED' : 'NEW',
        );
        assert.equal(
          (await s.command(outcome, { expected_version: String(version), cancel_id: cid })).body
            .error?.code,
          'CANCEL_NOT_PENDING',
        );
      } finally {
        await s.close();
      }
    }
  const s = await executionSandbox();
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    const cid = randomUUID();
    await s.command('REQUEST_CANCEL', { expected_version: '2', cancel_id: cid });
    await s.fill('3', '100.00');
    const tooLate = await s.command('ACK_CANCEL', { expected_version: '4', cancel_id: cid });
    assert.equal(tooLate.body.lifecycle.status, 'FILLED');
    assert.equal(tooLate.body.cancellation?.state, 'REJECTED');
    assert.equal(tooLate.body.lifecycle.pending_cancel_id, null);
  } finally {
    await s.close();
  }
});
await test('eight fills are bounded and the eighth must consume the remainder', async () => {
  const s = await executionSandbox();
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    for (let n = 0; n < 7; n++) assert.equal((await s.fill(String(2 + n), '1.00')).status, 201);
    assert.equal((await s.fill('9', '1.00')).body.error?.code, 'FILL_LIMIT_REQUIRES_REMAINDER');
    const r = await s.fill('9', '93.00');
    assert.equal(r.body.lifecycle.execution_count, 8);
    assert.equal(r.body.lifecycle.status, 'FILLED');
  } finally {
    await s.close();
  }
});
await test('offsetting BUY and SELL executions retain zero-net par and both execution counts', async () => {
  const s = await executionSandbox();
  const db = await connection('reconciler');
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    await s.fill('2', '100.00');
    const sell = await s.createOrder('100.00', 'SELL');
    await s.command('ACK_ORDER', { order_id: sell, expected_version: '1' });
    await s.command('EXECUTE_ORDER', {
      order_id: sell,
      expected_version: '2',
      source_event_id: randomUUID(),
      execution_id: randomUUID(),
      par_amount: '100.00',
    });
    const p = (
      await db.query<Record<string, unknown>>(
        'SELECT signed_par::text,execution_count,signed_cash_cents::text FROM fi.positions WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0];
    assert.equal(p.signed_par, '0.00');
    assert.equal(p.execution_count, 2);
    assert.equal(p.signed_cash_cents, '-10');
  } finally {
    await db.end();
    await s.close();
  }
});
