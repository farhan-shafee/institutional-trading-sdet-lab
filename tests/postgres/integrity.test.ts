import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connection } from './harness.js';

await test('independent read-only SQL detects a corrupted sandbox projection and passes only after repair', async () => {
  const admin = await connection('admin'),
    app = await connection('app'),
    reader = await connection('reconciler'),
    maint = await connection('maintenance');
  const id = randomUUID();
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const sql = await readFile(
    new URL('../../verification/sql/foundation.sql', import.meta.url),
    'utf8',
  );
  try {
    await app.query('SELECT fi_control.create_sandbox($1,$2,$3,$4,$5,$6)', [
      id,
      hash('r' + id),
      hash('t' + id),
      hash('create'),
      randomUUID(),
      randomUUID(),
    ]);
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal((await reader.query(sql)).rowCount, 0);
    await reader.query('COMMIT');
    await assert.rejects(reader.query('UPDATE fi.sandboxes SET generation=generation'), {
      code: '42501',
    });
    await admin.query(
      'UPDATE fi.sandboxes SET commit_seq=commit_seq+1,command_count=command_count+1 WHERE id=$1',
      [id],
    );
    const corrupted = await reader.query<{ invariant: string }>(sql);
    assert.equal(
      corrupted.rows.some((r) => r.invariant === 'SANDBOX_LEDGER_MISMATCH'),
      true,
    );
    await admin.query(
      'UPDATE fi.sandboxes SET commit_seq=commit_seq-1,command_count=command_count-1 WHERE id=$1',
      [id],
    );
    assert.equal((await reader.query(sql)).rowCount, 0);
  } finally {
    await app.end();
    await reader.end();
    await admin.query(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
      [id],
    );
    await maint.query('SELECT fi_control.purge_expired()');
    await maint.end();
    await admin.end();
  }
});
