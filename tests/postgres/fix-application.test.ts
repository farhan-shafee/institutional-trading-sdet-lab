import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import { applicationFixture } from './fix-application-fixture.js';
import { connection } from './harness.js';

import { owner } from './harness.js';
import { VerificationDatabase } from '../../app/server/reconciliation/database.js';
import { verifyFixApplication } from '../../app/server/fix/application-reconciliation.js';
async function independentlyConsistent(s: Awaited<ReturnType<typeof applicationFixture>>) {
  const cfg = await owner(),
    db = new VerificationDatabase(cfg.reconcilerUrl!);
  try {
    const r = await verifyFixApplication(
      db,
      { sandboxId: s.id, digest: s.proof, scope: 'trade', generation: '1' },
      () => {},
      true,
    );
    assert.equal(r.assessment, 'OBSERVED_APPLICATION_CONSISTENT', JSON.stringify(r.findings));
    assert.equal(r.delivery_verified, false);
  } finally {
    await db.close();
  }
}
void test('atomic FIX acknowledgment promotes the original key, invokes only the existing kernel and consumes exactly its committed effect', async () => {
  const s = await applicationFixture();
  const admin = await connection('admin');
  try {
    const p = await s.prepare(),
      key = randomUUID(),
      r = await s.apply(p.work, key);
    assert.equal(r.status, 200);
    assert.equal(r.body['financial_applied'], true);
    const a = (
      await admin.query<Record<string, unknown>>(
        'SELECT * FROM fi.fix_applications WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!;
    const c = (
      await admin.query<{ operation: string; request_hash: string }>(
        'SELECT operation,request_hash FROM fi.commands WHERE sandbox_id=$1 AND idempotency_key=$2',
        [s.id, p.financialKey],
      )
    ).rows[0]!;
    const payload = p.prepared['payload'];
    assert.equal(c.operation, 'ACK_ORDER');
    assert.equal(
      c.request_hash,
      createHash('sha256')
        .update(
          JSON.stringify({
            version: 1,
            method: 'POST',
            operation: 'ACK_ORDER',
            sandbox_id: s.id,
            payload: { order_id: s.order, expected_version: '1' },
          }),
        )
        .digest('hex'),
    );
    assert.notEqual(
      c.request_hash,
      (
        await admin.query<{ request_hash: string }>(
          'SELECT request_hash FROM fi.fix_prepared WHERE sandbox_id=$1 AND work_id=$2',
          [s.id, p.work],
        )
      ).rows[0]!.request_hash,
    );
    assert.ok(payload);
    assert.equal(
      (
        await admin.query<{ domain: string }>(
          'SELECT domain FROM fi_control.command_keys WHERE sandbox_id=$1 AND idempotency_key=$2',
          [s.id, p.financialKey],
        )
      ).rows[0]!.domain,
      'FINANCIAL',
    );
    assert.equal(a['work_id'], p.work);
    assert.deepEqual(
      (
        await admin.query('SELECT commands,events FROM fi.fix_consumptions WHERE sandbox_id=$1', [
          s.id,
        ])
      ).rows,
      [{ commands: 1, events: 1 }],
    );
    assert.equal((await s.apply(p.work, key)).replayed, true);
    assert.equal((await s.apply(p.work)).body['financial_applied'], true);
    assert.equal(
      (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_applications WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (
        await s.app.query<{ status: string }>(
          'SELECT status FROM fi.order_states WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.status,
      'NEW',
    );
    assert.equal(
      (
        await s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.positions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      0,
    );
  } finally {
    await admin.end();
    await s.close();
  }
});
void test('explicit partial/full trades create one immutable execution each and twenty competing applies never duplicate an economic event', async () => {
  const s = await applicationFixture();
  const clients = await Promise.all(Array.from({ length: 20 }, () => connection('app')));
  try {
    assert.equal((await s.apply((await s.prepare()).work)).status, 200);
    const c = (
      await s.app.query<{ contract: Record<string, string> }>(
        'SELECT contract FROM fi.orders WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.contract;
    const fill = await s.prepare({
      '150': 'F',
      '39': '1',
      '14': '40.00',
      '151': '60.00',
      '32': '40.00',
      '31': c['clean_price']!,
      '6': c['clean_price']!,
    });
    const keys = Array.from({ length: 20 }, () => randomUUID());
    const r = await Promise.all(clients.map((db, i) => s.apply(fill.work, keys[i], db)));
    assert.equal(r.filter((x) => x.status === 200).length, 20);
    assert.equal(r.filter((x) => !x.replayed).length, 1);
    assert.equal(
      (
        await s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.executions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      1,
    );
    const full = await s.prepare({
      '150': 'F',
      '39': '2',
      '14': '100.00',
      '151': '0.00',
      '32': '60.00',
      '31': c['clean_price']!,
      '6': c['clean_price']!,
    });
    assert.equal((await s.apply(full.work)).status, 200);
    assert.deepEqual(
      (
        await s.app.query(
          'SELECT status,filled_par,remaining_par,execution_count FROM fi.order_states WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows,
      [{ status: 'FILLED', filled_par: '100.00', remaining_par: '0.00', execution_count: 2 }],
    );
    assert.deepEqual(
      (
        await s.app.query(
          'SELECT signed_par,execution_count FROM fi.positions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows,
      [{ signed_par: '100.00', execution_count: 2 }],
    );
  } finally {
    await Promise.all(clients.map((c) => c.end()));
    await s.close();
  }
});
for (const side of ['BUY', 'SELL'])
  void test(`${side}:40 fill, pending cancel,20 fill,cancel acknowledgment preserves60 executed and cancels40`, async () => {
    const s = await applicationFixture('100.00', side);
    try {
      assert.equal((await s.apply((await s.prepare()).work)).status, 200);
      const px = (
        await s.app.query<{ contract: Record<string, string> }>(
          'SELECT contract FROM fi.orders WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.contract['clean_price']!;
      const trade = (q: string, cum: string, left: string, status = '1') =>
        s.prepare({ '150': 'F', '39': status, '14': cum, '151': left, '32': q, '31': px, '6': px });
      assert.equal((await s.apply((await trade('40.00', '40.00', '60.00')).work)).status, 200);
      const cancel = randomUUID(),
        base = { '11': cancel, '41': s.order };
      const f = await s.prepare({ '35': 'F', '49': 'TRADEFLOW', '56': 'ATLAS', ...base });
      assert.equal((await s.apply(f.work)).status, 200);
      const pending = await s.prepare({
        ...base,
        '150': '6',
        '39': '6',
        '14': '40.00',
        '151': '60.00',
        '6': px,
      });
      const key = randomUUID();
      assert.equal((await s.apply(pending.work, key)).status, 200);
      assert.equal((await s.apply(pending.work, key)).replayed, true);
      assert.equal((await s.apply((await trade('20.00', '60.00', '40.00', '6')).work)).status, 200);
      const canceled = await s.prepare({
        ...base,
        '150': '4',
        '39': '4',
        '14': '60.00',
        '151': '0.00',
        '6': px,
      });
      assert.equal((await s.apply(canceled.work)).status, 200);
      assert.deepEqual(
        (
          await s.app.query(
            'SELECT status,filled_par,remaining_par,pending_cancel_id FROM fi.order_states WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows,
        [
          {
            status: 'CANCELED',
            filled_par: '60.00',
            remaining_par: '0.00',
            pending_cancel_id: null,
          },
        ],
      );
      assert.equal(
        (
          await s.app.query<{ signed_par: string }>(
            'SELECT signed_par FROM fi.positions WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0]!.signed_par,
        side === 'BUY' ? '60.00' : '-60.00',
      );
      await independentlyConsistent(s);
    } finally {
      await s.close();
    }
  });
void test('definitive rejection uses the original kernel; duplicate-order rejection stays unresolved without a financial effect', async () => {
  for (const duplicate of [false, true]) {
    const s = await applicationFixture();
    try {
      const p = await s.prepare({
        '150': '8',
        '39': '8',
        '151': '0.00',
        '103': duplicate ? '6' : '99',
        '58': 'SYNTHETIC_REJECTION',
      });
      const r = await s.apply(p.work);
      assert.equal(r.status, duplicate ? 409 : 200);
      assert.equal(
        (
          await s.app.query<{ status: string }>(
            'SELECT status FROM fi.order_states WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0]!.status,
        duplicate ? 'PENDING_ACK' : 'REJECTED',
      );
      assert.equal(
        (
          await s.app.query<{ n: number }>(
            'SELECT count(*)::int n FROM fi.fix_consumptions WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0]!.n,
        duplicate ? 0 : 1,
      );
      assert.equal((await s.command('ACK_ORDER', { expected_version: '1' })).status, 409);
    } finally {
      await s.close();
    }
  }
});
void test('contradictory cumulative quantity remains immutable unresolved evidence and blocks later work without consuming capacity', async () => {
  const s = await applicationFixture();
  const admin = await connection('admin');
  try {
    await s.apply((await s.prepare()).work);
    const px = (
      await s.app.query<{ contract: Record<string, string> }>(
        'SELECT contract FROM fi.orders WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.contract['clean_price']!;
    const p = await s.prepare({
      '150': 'F',
      '39': '1',
      '14': '60.00',
      '151': '40.00',
      '32': '40.00',
      '31': px,
      '6': px,
    });
    assert.equal((await s.apply(p.work)).status, 409);
    const next = await s.stage({
      '150': 'F',
      '39': '1',
      '14': '40.00',
      '151': '60.00',
      '32': '40.00',
      '31': px,
      '6': px,
    });
    const w = randomUUID();
    await s.fix('QUEUE', { order_id: s.order, message_id: next.message, work_id: w });
    assert.equal(
      (
        await s.fix('PREPARE', {
          order_id: s.order,
          owner_id: s.owner,
          fence: s.fence,
          work_id: w,
          financial_key: randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.executions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      0,
    );
    assert.equal(
      (
        await admin.query<{ domain: string }>(
          'SELECT domain FROM fi_control.command_keys WHERE sandbox_id=$1 AND idempotency_key=$2',
          [s.id, p.financialKey],
        )
      ).rows[0]!.domain,
      'FIX_PREPARED',
    );
    assert.equal(
      (
        await s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.fix_consumptions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      1,
    );
  } finally {
    await admin.end();
    await s.close();
  }
});
void test('full fill while cancellation is pending stays FILLED and verified 9 rejects the pending cancellation as TOO_LATE', async () => {
  const s = await applicationFixture();
  try {
    await s.apply((await s.prepare()).work);
    const px = (
      await s.app.query<{ contract: Record<string, string> }>(
        'SELECT contract FROM fi.orders WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.contract['clean_price']!;
    const cancel = randomUUID(),
      base = { '11': cancel, '41': s.order };
    await s.apply((await s.prepare({ '35': 'F', '49': 'TRADEFLOW', '56': 'ATLAS', ...base })).work);
    await s.apply((await s.prepare({ ...base, '150': '6', '39': '6' })).work);
    await s.apply(
      (
        await s.prepare({
          '150': 'F',
          '39': '6',
          '14': '100.00',
          '151': '0.00',
          '32': '100.00',
          '31': px,
          '6': px,
        })
      ).work,
    );
    assert.equal(
      (
        await s.app.query<{ status: string }>(
          'SELECT status FROM fi.order_states WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.status,
      'FILLED',
    );
    const rejected = await s.prepare({ '35': '9', ...base, '39': '2', '434': '1', '102': '0' });
    assert.equal((await s.apply(rejected.work)).status, 200);
    assert.deepEqual(
      (
        await s.app.query(
          'SELECT outcome,reason FROM fi.cancellation_outcomes WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows,
      [{ outcome: 'REJECTED', reason: 'TOO_LATE' }],
    );
    assert.deepEqual(
      (
        await s.app.query(
          'SELECT signed_par,execution_count FROM fi.positions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows,
      [{ signed_par: '100.00', execution_count: 1 }],
    );
    await independentlyConsistent(s);
  } finally {
    await s.close();
  }
});
for (const fillFirst of [false, true])
  void test(`real PostgreSQL barrier: ${fillFirst ? 'partial fill' : 'cancel'} COMMIT precedes competing report admission`, async () => {
    const s = await applicationFixture(),
      first = await connection('app'),
      second = await connection('app'),
      monitor = await connection('admin');
    let pending: Promise<unknown> | undefined;
    try {
      await s.apply((await s.prepare()).work);
      const px = (
        await s.app.query<{ contract: Record<string, string> }>(
          'SELECT contract FROM fi.orders WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.contract['clean_price']!;
      const cancel = randomUUID(),
        base = { '11': cancel, '41': s.order };
      await s.apply(
        (await s.prepare({ '35': 'F', '49': 'TRADEFLOW', '56': 'ATLAS', ...base })).work,
      );
      const fill = {
        '150': 'F',
        '39': '1',
        '14': '40.00',
        '151': '60.00',
        '32': '40.00',
        '31': px,
        '6': px,
      };
      const cancelAck = {
        ...base,
        '150': '4',
        '39': '4',
        '14': fillFirst ? '40.00' : '0.00',
        '151': '0.00',
        '6': fillFirst ? px : '0.000000000000',
      };
      const p = await s.prepare(fillFirst ? fill : cancelAck);
      await first.query('BEGIN');
      assert.equal((await s.apply(p.work, randomUUID(), first)).status, 200);
      const pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
      pending = s.fix('CLAIM', { order_id: s.order, owner_id: s.owner }, randomUUID(), second);
      const deadline = performance.now() + 2000;
      let blocked = false;
      while (performance.now() < deadline) {
        if (
          (
            await monitor.query<{ b: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 b', [
              pid,
            ])
          ).rows[0]!.b
        ) {
          blocked = true;
          break;
        }
        await new Promise<void>((r) => setImmediate(r));
      }
      assert.equal(blocked, true);
      await first.query('COMMIT');
      await pending;
      await s.claim();
      const next = await s.stage(fillFirst ? cancelAck : fill),
        work = randomUUID();
      await s.fix('QUEUE', { order_id: s.order, message_id: next.message, work_id: work });
      const prepared = await s.fix('PREPARE', {
        order_id: s.order,
        owner_id: s.owner,
        fence: s.fence,
        work_id: work,
        financial_key: randomUUID(),
      });
      if (fillFirst) {
        assert.equal(prepared.status, 201);
        assert.equal((await s.apply(work)).status, 200);
      } else assert.equal(prepared.status, 409);
      assert.equal(
        (
          await s.app.query<{ status: string }>(
            'SELECT status FROM fi.order_states WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0]!.status,
        'CANCELED',
      );
      assert.equal(
        (
          await s.app.query<{ n: number }>(
            'SELECT count(*)::int n FROM fi.executions WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0]!.n,
        fillFirst ? 1 : 0,
      );
    } finally {
      await first.query('ROLLBACK').catch(() => {});
      await pending?.catch(() => {});
      await Promise.all([first.end(), second.end(), monitor.end()]);
      await s.close();
    }
  });
void test('untrusted non-profile bytes are retained as bounded hash-only unresolved evidence, never a trusted report or financial rejection', async () => {
  const s = await applicationFixture();
  try {
    const r = (
      await s.app.query<{ r: { status: number; body: { accepted: boolean } } }>(
        'SELECT fi_control.ingest_fix($1,$2,1,$3,$4,$5,false) r',
        [
          s.id,
          s.proof,
          JSON.stringify({
            order_id: s.order,
            attempt_id: randomUUID(),
            raw_hex: Buffer.from('synthetic-unsupported').toString('hex'),
          }),
          randomUUID(),
          s.actor,
        ],
      )
    ).rows[0]!.r;
    assert.equal(r.status, 200);
    assert.equal(r.body.accepted, false);
    assert.equal(
      (await s.app.query('SELECT * FROM fi.fix_unresolved_ingest WHERE sandbox_id=$1', [s.id]))
        .rowCount,
      1,
    );
    assert.equal(
      (await s.app.query('SELECT * FROM fi.fix_applications WHERE sandbox_id=$1', [s.id])).rowCount,
      0,
    );
  } finally {
    await s.close();
  }
});
void test('physical retransmission preserves the original logical report and execution, conflicting ExecID contents never create a second economic effect', async () => {
  const s = await applicationFixture();
  try {
    await s.apply((await s.prepare()).work);
    const px = (
      await s.app.query<{ contract: Record<string, string> }>(
        'SELECT contract FROM fi.orders WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.contract['clean_price']!;
    const p = await s.prepare({
      '150': 'F',
      '39': '2',
      '14': '100.00',
      '151': '0.00',
      '32': '100.00',
      '31': px,
      '6': px,
    });
    await s.apply(p.work);
    const { record } = await import('./fix-fixture.js');
    const retry = await record(s, {
      ...p.f,
      '34': '100',
      '43': 'Y',
      '122': p.f['52']!,
      '52': '20261030-12:01:00.000',
    });
    assert.equal(retry.status, 201);
    assert.equal(retry.body['message_id'], p.message);
    const conflict = await record(s, { ...p.f, '34': '101', '32': '50.00' });
    assert.equal(conflict.status, 409);
    assert.equal(
      (
        await s.app.query<{ n: number }>(
          'SELECT count(*)::int n FROM fi.executions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal((await s.apply(p.work)).replayed, true);
  } finally {
    await s.close();
  }
});
