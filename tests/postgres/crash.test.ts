import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { connection } from './harness.js';

for (const commit of [false, true])
  await test(`real process termination ${commit ? 'after' : 'before'} COMMIT permits exactly one eventual creation`, async () => {
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const id = randomUUID();
    const material = {
      id,
      read: hash('read' + id),
      trade: hash('trade' + id),
      hash: hash('create'),
      key: randomUUID(),
      actor: randomUUID(),
      commit,
    };
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/postgres/crash-worker.ts'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: process.env,
    });
    const ready = once(child, 'message');
    child.send(material);
    const db = await connection('app');
    const admin = await connection('admin');
    try {
      const [message] = (await ready) as [{ phase: string }];
      assert.equal(message.phase, commit ? 'committed' : 'uncommitted');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const replay = await db.query<{ result: { status: number; replayed: boolean } }>(
        'SELECT fi_control.create_sandbox($1,$2,$3,$4,$5,$6) AS result',
        [material.id, material.read, material.trade, material.hash, material.key, material.actor],
      );
      assert.equal(replay.rows[0]?.result.status, 201);
      assert.equal(replay.rows[0]?.result.replayed, commit);
      assert.equal(
        (await admin.query('SELECT id FROM fi.commands WHERE sandbox_id=$1', [id])).rowCount,
        1,
      );
      assert.equal(
        (await admin.query('SELECT command_id FROM fi.audit_events WHERE sandbox_id=$1', [id]))
          .rowCount,
        1,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await db.end();
      await admin.query(
        "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
        [id],
      );
      await admin.end();
      const maint = await connection('maintenance');
      try {
        await maint.query('SELECT fi_control.purge_expired()');
      } finally {
        await maint.end();
      }
    }
  });
