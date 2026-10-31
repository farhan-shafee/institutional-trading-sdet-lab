import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { readOwner } from './workflow-database.js';

const path = process.env.TF_DB_OWNER_FILE;
if (!path) throw new Error('Owned private descriptor required.');
try {
  const owner = await readOwner(path);
  if (!owner.reconcilerUrl) throw new Error('Read-only role required.');
  const db = new pg.Client({ connectionString: owner.reconcilerUrl });
  await db.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL statement_timeout='2000ms'");
    const role = await db.query<{ role: string }>('SELECT current_user AS role');
    if (role.rows[0]?.role !== 'tf_reconciler') throw new Error('Wrong reconciliation role.');
    const result = await db.query(
      await readFile(new URL('../verification/sql/foundation.sql', import.meta.url), 'utf8'),
    );
    if (result.rows.length) throw new Error('Foundation integrity mismatch.');
    await db.query('COMMIT');
    console.log('Independent read-only foundation SQL: zero violations.');
  } finally {
    await db.end();
  }
} catch {
  console.error('Foundation SQL verification failed; private connection material omitted.');
  process.exitCode = 1;
}
