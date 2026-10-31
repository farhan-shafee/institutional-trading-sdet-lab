import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { connection } from './harness.js';
import { rfqInput, sandbox } from './rfq-fixture.js';

for (const field of ['bid_clean_price', 'ask_clean_price', 'model_version'])
  await test(`independent SQL rejects matching quote/order snapshot corruption of ${field}`, async () => {
    const f = await sandbox(),
      admin = await connection('admin'),
      reader = await connection('reconciler');
    let quote: Record<string, unknown> | undefined,
      contract: Record<string, unknown> | undefined,
      disabled = false;
    try {
      const input = rfqInput();
      await f.command('CREATE_RFQ', input);
      const response = await f.command('RESPOND_DEALER', {
        rfq_id: input.rfq_id,
        expected_version: '1',
        dealer_id: 'ATLAS',
        response: 'QUOTE',
      });
      const accepted = await f.command('ACCEPT_QUOTE', {
        rfq_id: input.rfq_id,
        expected_version: '2',
        quote_id: response.body.quotes[0]!.id,
      });
      assert.equal(accepted.status, 201);
      quote = response.body.quotes[0]!.snapshot;
      contract = accepted.body.order!.contract;
      const sql = await readFile(
        new URL('../../verification/sql/rfq.sql', import.meta.url),
        'utf8',
      );
      assert.equal((await reader.query(sql)).rowCount, 0);
      await admin.query('ALTER TABLE fi.quotes DISABLE TRIGGER quote_immutable');
      await admin.query('ALTER TABLE fi.orders DISABLE TRIGGER order_immutable');
      disabled = true;
      const corruptQuote = { ...quote },
        corruptContract = { ...contract };
      if (field === 'model_version') {
        delete corruptQuote[field];
        delete corruptContract[field];
      } else {
        corruptQuote[field] = '97.000000000123';
        corruptContract[field] = '97.000000000123';
      }
      await admin.query('UPDATE fi.quotes SET snapshot=$2 WHERE sandbox_id=$1', [
        f.id,
        JSON.stringify(corruptQuote),
      ]);
      await admin.query('UPDATE fi.orders SET contract=$2 WHERE sandbox_id=$1', [
        f.id,
        JSON.stringify(corruptContract),
      ]);
      const violations = await reader.query<{ invariant: string }>(sql);
      assert.equal(
        violations.rows.some((r) => r.invariant === 'DEALER_GRID_MISMATCH'),
        true,
        'The independent checker must disagree with matching corrupted projections.',
      );
    } finally {
      if (disabled) {
        await admin.query('UPDATE fi.quotes SET snapshot=$2 WHERE sandbox_id=$1', [
          f.id,
          JSON.stringify(quote),
        ]);
        await admin.query('UPDATE fi.orders SET contract=$2 WHERE sandbox_id=$1', [
          f.id,
          JSON.stringify(contract),
        ]);
        await admin.query('ALTER TABLE fi.orders ENABLE TRIGGER order_immutable');
        await admin.query('ALTER TABLE fi.quotes ENABLE TRIGGER quote_immutable');
      }
      await reader.end();
      await admin.end();
      await f.close();
    }
  });
