import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { connection } from './harness.js';
import { rfqInput, sandbox } from './rfq-fixture.js';

await test('quote expiry is checked after waiting for an RFQ lock, not at transaction start', async () => {
  const f = await sandbox(),
    admin = await connection('admin');
  let enabled = true;
  try {
    const input = rfqInput();
    assert.equal((await f.command('CREATE_RFQ', input)).status, 201);
    const result = await f.command('RESPOND_DEALER', {
      rfq_id: input.rfq_id,
      expected_version: '1',
      dealer_id: 'ATLAS',
      response: 'QUOTE',
    });
    const quote = result.body.quotes[0]!;
    // Privileged fixture clock manipulation only. tf_app cannot disable or update these records.
    await admin.query('ALTER TABLE fi.quotes DISABLE TRIGGER quote_immutable');
    enabled = false;
    await admin.query('BEGIN');
    await admin.query('SELECT 1 FROM fi.rfqs WHERE sandbox_id=$1 AND id=$2 FOR UPDATE', [
      f.id,
      input.rfq_id,
    ]);
    await f.app.query("SET application_name='tradeflow-rfq-lock-clock'");
    const accepting = f.command('ACCEPT_QUOTE', {
      rfq_id: input.rfq_id,
      expected_version: '2',
      quote_id: quote.id,
    });
    const deadline = performance.now() + 3000;
    while (true) {
      const waiting = await admin.query<{ waiting: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='tradeflow-rfq-lock-clock' AND wait_event_type='Lock') AS waiting",
      );
      if (waiting.rows[0]?.waiting) break;
      assert.ok(performance.now() < deadline, 'Acceptance must reach the held RFQ lock.');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await admin.query(
      "UPDATE fi.quotes SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE sandbox_id=$1 AND id=$2",
      [f.id, quote.id],
    );
    // Deliberately advance to the database expiry boundary while keeping the lock held.
    await admin.query(
      "SELECT pg_sleep_until(expires_at+interval '10 milliseconds') FROM fi.quotes WHERE sandbox_id=$1 AND id=$2",
      [f.id, quote.id],
    );
    await admin.query('COMMIT');
    const rejected = await accepting;
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error?.code, 'QUOTE_EXPIRED');
    assert.equal(
      (await admin.query('SELECT * FROM fi.orders WHERE sandbox_id=$1', [f.id])).rowCount,
      0,
    );
    await admin.query('ALTER TABLE fi.quotes ENABLE TRIGGER quote_immutable');
    enabled = true;
  } finally {
    await admin.query('ROLLBACK');
    if (!enabled) await admin.query('ALTER TABLE fi.quotes ENABLE TRIGGER quote_immutable');
    await admin.end();
    await f.close();
  }
});

await test('composite RFQ ownership and deferred acceptance constraints reject mismatched orders', async () => {
  const f = await sandbox(),
    foreign = await sandbox(),
    admin = await connection('admin');
  try {
    const a = rfqInput(),
      b = rfqInput();
    assert.equal((await f.command('CREATE_RFQ', a)).status, 201);
    assert.equal((await foreign.command('CREATE_RFQ', b)).status, 201);
    const result = await foreign.command('RESPOND_DEALER', {
      rfq_id: b.rfq_id,
      expected_version: '1',
      dealer_id: 'ATLAS',
      response: 'QUOTE',
    });
    const quote = result.body.quotes[0]!;
    assert.equal(
      (
        await f.command('ACCEPT_QUOTE', {
          rfq_id: a.rfq_id,
          quote_id: quote.id,
          expected_version: '1',
        })
      ).status,
      404,
    );
    await assert.rejects(
      admin.query(
        "INSERT INTO fi.orders VALUES($1,$2,$3,$4,'PENDING_ACK',clock_timestamp(),'{}')",
        [f.id, randomUUID(), a.rfq_id, quote.id],
      ),
      { code: '23503' },
    );
    await admin.query('BEGIN');
    await admin.query(
      "UPDATE fi.rfqs SET state='ACCEPTED',accepted_quote_id=$3 WHERE sandbox_id=$1 AND id=$2",
      [foreign.id, b.rfq_id, quote.id],
    );
    await assert.rejects(admin.query('COMMIT'), { code: '23514' });
    await admin.query('ROLLBACK');
  } finally {
    await admin.end();
    await foreign.close();
    await f.close();
  }
});

await test('RFQ capacity rejects the fifty-first record without consuming a receipt or invitation', async () => {
  const f = await sandbox(),
    reader = await connection('reconciler');
  try {
    for (let n = 0; n < 50; n++)
      assert.equal((await f.command('CREATE_RFQ', rfqInput())).status, 201);
    assert.equal((await f.command('CREATE_RFQ', rfqInput())).status, 429);
    assert.equal(
      (await reader.query('SELECT * FROM fi.rfqs WHERE sandbox_id=$1', [f.id])).rowCount,
      50,
    );
    assert.equal(
      (await reader.query('SELECT * FROM fi.invitations WHERE sandbox_id=$1', [f.id])).rowCount,
      150,
    );
    assert.equal(
      (await reader.query('SELECT * FROM fi.commands WHERE sandbox_id=$1', [f.id])).rowCount,
      51,
    );
  } finally {
    await reader.end();
    await f.close();
  }
});

await test('independent SQL detects exact-price contractual corruption rather than trusting order projections', async () => {
  const f = await sandbox(),
    admin = await connection('admin'),
    reader = await connection('reconciler');
  let original: unknown;
  let disabled = false;
  try {
    const input = rfqInput();
    await f.command('CREATE_RFQ', input);
    const quoted = await f.command('RESPOND_DEALER', {
      rfq_id: input.rfq_id,
      expected_version: '1',
      dealer_id: 'ATLAS',
      response: 'QUOTE',
    });
    const accepted = await f.command('ACCEPT_QUOTE', {
      rfq_id: input.rfq_id,
      expected_version: '2',
      quote_id: quoted.body.quotes[0]!.id,
    });
    assert.equal(accepted.status, 201);
    original = accepted.body.order!.contract;
    const sql = await readFile(new URL('../../verification/sql/rfq.sql', import.meta.url), 'utf8');
    assert.equal((await reader.query(sql)).rowCount, 0);
    await assert.rejects(
      admin.query('UPDATE fi.orders SET contract=contract WHERE sandbox_id=$1', [f.id]),
      { code: '42501' },
    );
    // Deliberate owner-only corruption, proving the independent checker can disagree with stored state.
    await admin.query('ALTER TABLE fi.orders DISABLE TRIGGER order_immutable');
    disabled = true;
    await admin.query(
      "UPDATE fi.orders SET contract=jsonb_set(contract,'{clean_price}',to_jsonb('100.05'::text)) WHERE sandbox_id=$1",
      [f.id],
    );
    const bad = await reader.query<{ invariant: string }>(sql);
    assert.equal(
      bad.rows.some((r) => r.invariant === 'ORDER_CONTRACT_MISMATCH'),
      true,
    );
    await admin.query('UPDATE fi.orders SET contract=$2 WHERE sandbox_id=$1', [
      f.id,
      JSON.stringify(original),
    ]);
    assert.equal((await reader.query(sql)).rowCount, 0);
  } finally {
    if (original && disabled)
      await admin.query('UPDATE fi.orders SET contract=$2 WHERE sandbox_id=$1', [
        f.id,
        JSON.stringify(original),
      ]);
    await admin.query('ALTER TABLE fi.orders ENABLE TRIGGER order_immutable');
    await reader.end();
    await admin.end();
    await f.close();
  }
});
