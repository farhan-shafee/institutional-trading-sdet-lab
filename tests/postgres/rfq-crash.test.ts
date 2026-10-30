import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connection } from './harness.js';
import { digest, rfqInput, sandbox } from './rfq-fixture.js';

for (const commit of [false, true])
  await test(`SIGKILL ${commit ? 'after' : 'before'} acceptance COMMIT recovers exactly one economic order`, async () => {
    const f = await sandbox(),
      reader = await connection('reconciler');
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const input = rfqInput();
      assert.equal((await f.command('CREATE_RFQ', input)).status, 201);
      const quote = await f.command('RESPOND_DEALER', {
        rfq_id: input.rfq_id,
        expected_version: '1',
        dealer_id: 'ATLAS',
        response: 'QUOTE',
      });
      const payload = {
          rfq_id: input.rfq_id,
          expected_version: '2',
          quote_id: quote.body.quotes[0]!.id,
        },
        key = randomUUID();
      child = spawn(process.execPath, ['--import', 'tsx', 'tests/postgres/rfq-crash-worker.ts'], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: process.env,
      });
      const ready = once(child, 'message');
      child.send({
        commit,
        args: [
          f.id,
          f.proof,
          '1',
          'ACCEPT_QUOTE',
          JSON.stringify(payload),
          digest(JSON.stringify({ action: 'ACCEPT_QUOTE', payload })),
          key,
          f.actor,
        ],
      });
      const [message] = (await ready) as [{ phase: string }];
      assert.equal(message.phase, commit ? 'committed' : 'uncommitted');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const response = await f.command('ACCEPT_QUOTE', payload, key);
      assert.equal(response.status, 201);
      assert.equal(response.replayed, commit);
      assert.equal(
        (await reader.query('SELECT * FROM fi.orders WHERE sandbox_id=$1', [f.id])).rowCount,
        1,
      );
      assert.equal(
        (
          await reader.query(
            "SELECT * FROM fi.commands WHERE sandbox_id=$1 AND operation='ACCEPT_QUOTE'",
            [f.id],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await reader.query(
            "SELECT * FROM fi.audit_events WHERE sandbox_id=$1 AND event_type IN ('QUOTE_ACCEPTED','RFQ_ACCEPTED','ORDER_CREATED')",
            [f.id],
          )
        ).rowCount,
        3,
      );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      await reader.end();
      await f.close();
    }
  });
