import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { loadPrivate, replacePrivate } from './private-state.js';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export type DatabaseOwner = {
  version: 1;
  nonce: string;
  adminUrl: string;
  appUrl?: string;
  migratorUrl?: string;
  reconcilerUrl?: string;
  maintenanceUrl?: string;
};

export function localDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' ||
    !/^\/tradeflow_(local|ci)_[a-f0-9]{16}$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error('Only an owned loopback TradeFlow database is permitted.');
  return url;
}

export async function readOwner(path: string): Promise<DatabaseOwner> {
  const owner = (await loadPrivate(path)) as DatabaseOwner;
  if (owner.version !== 1 || !/^[a-f0-9]{32}$/.test(owner.nonce))
    throw new Error('Invalid owned database descriptor.');
  localDatabaseUrl(owner.adminUrl);
  return owner;
}

export async function bootstrap(path: string, throughVersion?: 2 | 3 | 4): Promise<void> {
  const owner = await readOwner(path);
  const url = localDatabaseUrl(owner.adminUrl);
  const admin = new pg.Client({ connectionString: owner.adminUrl });
  await admin.connect();
  try {
    const proof = await admin.query<{ marker: string }>(
      "SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
    );
    if (proof.rows[0]?.marker !== `TradeFlow local owner ${owner.nonce}`)
      throw new Error('Database ownership marker mismatch.');
    const roles = await admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_roles WHERE rolname IN ('tf_owner','tf_migrator','tf_app','tf_reconciler','tf_maintenance')",
    );
    if (roles.rows[0]?.count === 0) {
      for (const role of ['migrator', 'app', 'reconciler', 'maintenance'] as const) {
        const roleUrl = new URL(url);
        roleUrl.username = `tf_${role}`;
        roleUrl.password = randomBytes(32).toString('base64url');
        owner[`${role}Url`] = roleUrl.href;
      }
      await replacePrivate(path, owner);
      await admin.query('BEGIN');
      try {
        await admin.query(
          await readFile(new URL('../db/bootstrap/roles.sql', import.meta.url), 'utf8'),
        );
        await admin.query(
          `GRANT CREATE ON DATABASE ${pg.escapeIdentifier(url.pathname.slice(1))} TO tf_owner`,
        );
        for (const role of ['migrator', 'app', 'reconciler', 'maintenance'] as const) {
          const password = new URL(owner[`${role}Url`]!).password;
          await admin.query(
            `ALTER ROLE ${pg.escapeIdentifier(`tf_${role}`)} PASSWORD ${pg.escapeLiteral(password)}`,
          );
        }
        await admin.query('COMMIT');
      } catch (error) {
        await admin.query('ROLLBACK');
        throw error;
      }
    } else if (roles.rows[0]?.count !== 5 || !owner.migratorUrl) {
      throw new Error('Refusing to reuse an unknown database role set.');
    }
  } finally {
    await admin.end();
  }
  await migrate(owner, undefined, throughVersion);
}

export async function migrate(
  owner: DatabaseOwner,
  source?: string,
  throughVersion?: 2 | 3 | 4,
): Promise<void> {
  const directory = new URL('../db/migrations/', import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name))
    .filter((name) => throughVersion === undefined || Number(name.slice(0, 3)) <= throughVersion)
    .sort();
  const migrations = await Promise.all(
    names.map(async (name, index) => {
      const sql =
        index === 0 && source !== undefined
          ? source
          : await readFile(new URL(name, directory), 'utf8');
      return {
        version: Number(name.slice(0, 3)),
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
  if (!owner.migratorUrl) throw new Error('Dedicated migrator is required.');
  localDatabaseUrl(owner.migratorUrl);
  const db = new pg.Client({ connectionString: owner.migratorUrl });
  await db.connect();
  try {
    const marker = await db.query<{ marker: string }>(
      "SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
    );
    if (marker.rows[0]?.marker !== `TradeFlow local owner ${owner.nonce}`)
      throw new Error('Database ownership marker mismatch.');
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE tf_owner');
    await db.query('SELECT pg_advisory_xact_lock(71002001)');
    const exists = await db.query<{ present: boolean }>(
      "SELECT to_regclass('fi_control.schema_migrations') IS NOT NULL AS present",
    );
    const applied = exists.rows[0]?.present
      ? (
          await db.query<{ version: number; checksum: string }>(
            'SELECT version,checksum FROM fi_control.schema_migrations ORDER BY version',
          )
        ).rows
      : [];
    for (const version of applied) {
      if (migrations.find((m) => m.version === version.version)?.checksum !== version.checksum)
        throw new Error('Migration checksum or schema version mismatch.');
    }
    for (const migration of migrations) {
      if (applied.some((v) => v.version === migration.version)) continue;
      await db.query(migration.sql);
      await db.query('INSERT INTO fi_control.schema_migrations(version,checksum) VALUES ($1,$2)', [
        migration.version,
        migration.checksum,
      ]);
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.env.TF_DB_OWNER_FILE;
  if (!path) throw new Error('An owned private database descriptor is required.');
  void bootstrap(path)
    .then(() => console.log('Owned database roles and migration verified.'))
    .catch(() => {
      console.error('Owned database migration failed; credentials and SQL parameters omitted.');
      process.exitCode = 1;
    });
}
