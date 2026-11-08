/** Explicit opt-in on an already bootstrapped owned schema8 database. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { migrationChecksums } from '../app/domain/workflow/database-contract.js';
import { liveMigrationChecksums } from '../app/domain/workflow/live-database-contract.js';
import { readOwner, localDatabaseUrl } from './workflow-database.js';

export async function migrateLive(path: string): Promise<void> {
  const owner = await readOwner(path);
  if (!owner.migratorUrl) throw new Error('Dedicated owned migrator is required.');
  const target = localDatabaseUrl(owner.migratorUrl),
    admin = localDatabaseUrl(owner.adminUrl);
  if (
    target.pathname !== admin.pathname ||
    target.hostname !== admin.hostname ||
    target.port !== admin.port ||
    target.username !== 'tf_migrator'
  )
    throw new Error('Owned migration target mismatch.');
  const sql = await readFile(
    new URL('../db/live-migrations/009_fix_live_ingress.sql', import.meta.url),
    'utf8',
  );
  const checksum = createHash('sha256').update(sql).digest('hex');
  if (checksum !== liveMigrationChecksums[8]?.checksum)
    throw new Error('Live migration source checksum mismatch.');
  const db = new pg.Client({ connectionString: owner.migratorUrl, query_timeout: 2000 });
  await db.connect();
  try {
    const marker = await db.query<{ marker: string }>(
      "SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()",
    );
    if (marker.rows[0]?.marker !== `TradeFlow local owner ${owner.nonce}`)
      throw new Error('Database ownership marker mismatch.');
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE tf_owner');
    await db.query("SET LOCAL statement_timeout='1500ms'");
    await db.query("SET LOCAL lock_timeout='750ms'");
    await db.query("SET LOCAL idle_in_transaction_session_timeout='2000ms'");
    await db.query('SELECT pg_advisory_xact_lock(71002001)');
    const rows = (
      await db.query<{ version: number; checksum: string }>(
        'SELECT version,checksum FROM fi_control.schema_migrations ORDER BY version',
      )
    ).rows;
    if (JSON.stringify(rows) === JSON.stringify(liveMigrationChecksums)) {
      await db.query('COMMIT');
      return;
    }
    if (JSON.stringify(rows) !== JSON.stringify(migrationChecksums))
      throw new Error('Expected the exact owned schema8 boundary.');
    await db.query(sql);
    await db.query('INSERT INTO fi_control.schema_migrations(version,checksum) VALUES(9,$1)', [
      checksum,
    ]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.env['TF_DB_OWNER_FILE'];
  if (!path) throw new Error('An owned private database descriptor is required.');
  void migrateLive(path)
    .then(() => console.log('Owned live schema verified.'))
    .catch(() => {
      console.error('Owned live migration failed; credentials and parameters omitted.');
      process.exitCode = 1;
    });
}
