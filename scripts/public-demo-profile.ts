import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { readOwner, localDatabaseUrl } from './workflow-database.js';
import { financialSource, migrationChecksums } from '../app/domain/workflow/database-contract.js';
import { publicProfileChecksum, verifyPublicProfile } from '../app/server/public-demo/profile.js';

/** Candidate/test installation only: retains the existing private owned-loopback boundary. */
export async function installOwnedPublicProfile(path: string): Promise<void> {
  const owner = await readOwner(path);
  if (!owner.migratorUrl)
    throw new Error('Owned migrations must complete before profile installation.');
  const target = localDatabaseUrl(owner.migratorUrl);
  const original = localDatabaseUrl(owner.adminUrl);
  if (
    target.host !== original.host ||
    target.pathname !== original.pathname ||
    target.username !== 'tf_migrator'
  )
    throw new Error('Owned profile target mismatch.');
  const sql = await readFile(new URL('../db/public-demo/001_profile.sql', import.meta.url), 'utf8');
  if (createHash('sha256').update(sql).digest('hex') !== publicProfileChecksum)
    throw new Error('Public profile source differs from its reviewed checksum.');
  const admin = new pg.Client({
    connectionString: owner.adminUrl,
    connectionTimeoutMillis: 500,
    query_timeout: 2000,
  });
  await admin.connect();
  try {
    const marker = await admin.query<{ marker: string }>(
      "SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
    );
    if (marker.rows[0]?.marker !== `TradeFlow local owner ${owner.nonce}`)
      throw new Error('Profile database ownership mismatch.');
  } finally {
    await admin.end();
  }
  const db = new pg.Client({
    connectionString: owner.migratorUrl,
    connectionTimeoutMillis: 500,
    query_timeout: 5000,
  });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE tf_owner');
    const versions = await db.query(
      'SELECT version,checksum FROM fi_control.schema_migrations ORDER BY version',
    );
    const source = await db.query<{ financial_source: string }>(
      'SELECT financial_source FROM fi_control.compatibility WHERE singleton',
    );
    if (
      JSON.stringify(versions.rows) !== JSON.stringify(migrationChecksums) ||
      source.rows[0]?.financial_source !== financialSource
    )
      throw new Error('Base financial schema mismatch.');
    const present = await db.query<{ present: boolean }>(
      "SELECT to_regclass('fi_control.public_demo_profile') IS NOT NULL AS present",
    );
    if (present.rows[0]?.present) await verifyPublicProfile(db);
    else {
      const count = await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM fi.sandboxes',
      );
      if (count.rows[0]?.count !== 0)
        throw new Error('Public profile requires an empty dedicated database.');
      await db.query(sql);
      await db.query(
        "INSERT INTO fi_control.public_demo_profile VALUES(true,'public-workflow-v1',1,$1,current_database())",
        [publicProfileChecksum],
      );
      await verifyPublicProfile(db);
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}
