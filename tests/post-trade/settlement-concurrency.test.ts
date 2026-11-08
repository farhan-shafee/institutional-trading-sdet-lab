import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connection, randomUUID } from './fixture.js';
import { owner } from '../postgres/harness.js';
import { fundedBook, available, duePayload } from './settlement-fixture.js';
import { PostTradeWorkflowDatabase } from '../../app/persistence/postgres/post-trade-workflow.js';
import { DomainError } from '../../app/domain/errors.js';

await test('same-key competing settlements return one posting and exact immutable replay', async () => {
  const s = await fundedBook(),
    other = await connection('app'),
    key = randomUUID();
  try {
    const payload = duePayload(s.raw.id);
    const replies = await Promise.all([
      s.post('SETTLE', payload, key),
      s.post('SETTLE', payload, key, other),
    ]);
    assert.ok(replies.every((reply) => reply.status === 200));
    assert.equal(replies.filter((reply) => reply.replayed).length, 1);
    assert.deepEqual(replies[0].body, replies[1].body);
    assert.equal((await s.read()).posttrade_command_seq, '3');
    assert.equal(Number(available(await s.read())), 100);
    assert.equal((await s.post('REVERSE', payload, key)).status, 409);
  } finally {
    await other.end();
    await s.close();
  }
});
for (const operation of ['CORRECT_PRICE', 'BUST'])
  await test(
    'reversal and ' + operation + ' contenders preserve reverse-before-adjustment ordering',
    async () => {
      const s = await fundedBook(),
        other = await connection('app'),
        admin = await connection('admin');
      try {
        assert.equal((await s.post('SETTLE', duePayload(s.raw.id))).status, 200);
        const adjustment =
          operation === 'CORRECT_PRICE'
            ? { execution_id: s.raw.id, expected_revision: 0, clean_price: '100.000000000000' }
            : { execution_id: s.raw.id, expected_revision: 0 };
        const replies = await Promise.all([
          s.post('REVERSE', duePayload(s.raw.id)),
          s.post(operation, adjustment, randomUUID(), other),
        ]);
        assert.equal(replies[0].status, 200);
        assert.ok([201, 409].includes(replies[1].status));
        const source = await s.read();
        assert.equal(source.available_cash_cents, '10000000000');
        assert.equal(Number(available(source)), 0);
        if (replies[1].status === 201) {
          const sequences = (
            await admin.query<{ op: string; seq: string }>(
              "SELECT operation op,command_seq::text seq FROM fi.posttrade_commands WHERE sandbox_id=$1 AND operation IN ('REVERSE',$2) ORDER BY command_seq",
              [s.id, operation],
            )
          ).rows;
          assert.equal(sequences[0]!.op, 'REVERSE');
          assert.equal(sequences[1]!.op, operation);
          assert.ok(BigInt(sequences[0]!.seq) < BigInt(sequences[1]!.seq));
        }
      } finally {
        await admin.end();
        await other.end();
        await s.close();
      }
    },
  );
await test('settlement and bust contenders cannot retain settled cash beneath a terminal void', async () => {
  const s = await fundedBook(),
    other = await connection('app');
  try {
    const replies = await Promise.all([
      s.post('SETTLE', duePayload(s.raw.id)),
      s.post('BUST', { execution_id: s.raw.id, expected_revision: 0 }, randomUUID(), other),
    ]);
    assert.equal(replies.filter((reply) => reply.status === 200 || reply.status === 201).length, 1);
    assert.equal(replies.filter((reply) => reply.status === 409).length, 1);
    const source = await s.read(),
      root = source.roots[0]!;
    if (root.busted) {
      assert.equal(root.settlement_state, 'VOIDED');
      assert.equal(source.available_cash_cents, '10000000000');
      assert.equal(Number(available(source)), 0);
    } else {
      assert.equal(root.settlement_state, 'SETTLED');
      assert.equal(Number(available(source)), 100);
    }
  } finally {
    await other.end();
    await s.close();
  }
});
for (const boundary of ['before', 'after'] as const)
  await test(boundary + '-COMMIT failure recovers only the original settlement key', async () => {
    const s = await fundedBook(),
      config = await owner(),
      key = randomUUID();
    assert.ok(config.appUrl);
    const fault = new PostTradeWorkflowDatabase(config.appUrl, {
      ...(boundary === 'before'
        ? {
            beforeCommit: () => {
              throw new Error('CONTROLLED_PRECOMMIT');
            },
          }
        : {
            afterCommit: () => {
              throw new Error('CONTROLLED_ACKNOWLEDGEMENT_LOSS');
            },
          }),
    });
    try {
      const payload = duePayload(s.raw.id),
        before = await s.read();
      await assert.rejects(
        fault.transaction(
          false,
          () => undefined,
          async (db) =>
            (
              await db.query<{ result: unknown }>(
                'SELECT fi_control.posttrade_command($1,$2,1,$3,$4,$5,$6)',
                [s.id, s.proof, 'SETTLE', JSON.stringify(payload), key, s.actor],
              )
            ).rows,
        ),
        (error) =>
          error instanceof DomainError &&
          error.code === (boundary === 'before' ? 'DATABASE_UNAVAILABLE' : 'OUTCOME_UNKNOWN'),
      );
      const unresolved = await s.read();
      assert.equal(unresolved.posttrade_command_seq, boundary === 'before' ? '2' : '3');
      if (boundary === 'before')
        assert.equal(unresolved.available_cash_cents, before.available_cash_cents);
      const recovered = await s.post('SETTLE', payload, key);
      assert.equal(recovered.status, 200);
      assert.equal(recovered.replayed, boundary === 'after');
      const after = await s.read();
      assert.equal(after.posttrade_command_seq, '3');
      assert.equal(Number(available(after)), 100);
      assert.equal(
        after.available_cash_cents,
        String(BigInt(before.available_cash_cents) - BigInt(s.raw.consideration_cents)),
      );
    } finally {
      await fault.close();
      await s.close();
    }
  });
