import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { migrationChecksums } from '../app/domain/workflow/database-contract.js';
import { liveMigrationChecksums } from '../app/domain/workflow/live-database-contract.js';
import { postTradeMigrationChecksums } from '../app/domain/post-trade/database-contract.js';
import { readOwner, localDatabaseUrl } from './workflow-database.js';

export async function migratePostTrade(path: string): Promise<void> {
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
  const migrations = await Promise.all(
    [
      [9, new URL('../db/live-migrations/009_fix_live_ingress.sql', import.meta.url)],
      [10, new URL('../db/posttrade-migrations/010_post_trade.sql', import.meta.url)],
    ].map(async ([version, url]) => {
      const sql = await readFile(url as URL, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (checksum !== postTradeMigrationChecksums[Number(version) - 1]?.checksum)
        throw new Error('Post-trade migration source checksum mismatch.');
      return { version: Number(version), sql, checksum };
    }),
  );
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
    if (
      ![migrationChecksums, liveMigrationChecksums, postTradeMigrationChecksums].some(
        (expected) => JSON.stringify(rows) === JSON.stringify(expected),
      )
    )
      throw new Error('Expected the exact owned schema8,9 or10 boundary.');
    for (const m of migrations) {
      if (rows.some((row) => row.version === m.version)) continue;
      await db.query(m.sql);
      await db.query('INSERT INTO fi_control.schema_migrations(version,checksum) VALUES($1,$2)', [
        m.version,
        m.checksum,
      ]);
    }
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
  void migratePostTrade(path)
    .then(() => console.log('Owned post-trade schema verified.'))
    .catch(() => {
      console.error('Owned post-trade migration failed; private connection material omitted.');
      process.exitCode = 1;
    });
}
