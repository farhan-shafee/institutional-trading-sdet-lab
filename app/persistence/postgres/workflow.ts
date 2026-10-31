import pg from 'pg';
import { DomainError } from '../../domain/errors.js';
import { financialSource, migrationChecksums } from '../../domain/workflow/database-contract.js';

export type TransactionHooks = {
  beforeCommit?: () => void | Promise<void>;
  afterCommit?: () => void | Promise<void>;
};

export class WorkflowDatabase {
  readonly pool: pg.Pool;
  private pending = 0;
  private closing: Promise<void> | undefined;
  constructor(
    databaseUrl: string,
    private readonly hooks: TransactionHooks = {},
  ) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 500,
      query_timeout: 2000,
      idleTimeoutMillis: 1000,
      allowExitOnIdle: true,
    });
    this.pool.on('error', () => {
      /* The next request revalidates availability; no sensitive driver error is logged. */
    });
  }
  close(): Promise<void> {
    return (this.closing ??= this.pool.end());
  }
  async transaction<T>(
    readOnly: boolean,
    verify: () => void,
    work: (db: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    if (this.pending >= 12 || this.closing)
      throw new DomainError(
        503,
        'DATABASE_UNAVAILABLE',
        'Fixed-income persistence is unavailable.',
      );
    this.pending++;
    const deadline = performance.now() + 5000;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        let db: pg.PoolClient | undefined;
        let commitDispatched = false;
        try {
          verify();
          db = await this.pool.connect();
          await db.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
          await db.query("SET LOCAL statement_timeout='1500ms'");
          await db.query("SET LOCAL lock_timeout='750ms'");
          await db.query("SET LOCAL idle_in_transaction_session_timeout='2000ms'");
          await this.compatible(db);
          verify();
          const result = await work(db);
          if (!readOnly) await this.hooks.beforeCommit?.();
          verify();
          if (performance.now() > deadline)
            throw new DomainError(
              503,
              'DATABASE_TIMEOUT',
              'The fixed-income transaction deadline elapsed.',
            );
          commitDispatched = true;
          await db.query('COMMIT');
          if (!readOnly) await this.hooks.afterCommit?.();
          db.release();
          db = undefined;
          return result;
        } catch (error: unknown) {
          if (db) {
            if (!commitDispatched) await db.query('ROLLBACK').catch(() => undefined);
            db.release(true);
          }
          if (error instanceof DomainError) throw error;
          const code =
            typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
          if (
            !commitDispatched &&
            ['40P01', '40001'].includes(String(code)) &&
            attempt < 2 &&
            performance.now() < deadline
          )
            continue;
          throw new DomainError(
            503,
            !readOnly && commitDispatched ? 'OUTCOME_UNKNOWN' : 'DATABASE_UNAVAILABLE',
            !readOnly && commitDispatched
              ? 'The commit outcome is unknown. Recover and retry the original key.'
              : 'Fixed-income persistence is unavailable.',
          );
        }
      }
      throw new DomainError(
        503,
        'DATABASE_UNAVAILABLE',
        'Fixed-income persistence is unavailable.',
      );
    } finally {
      this.pending--;
    }
  }
  private async compatible(db: pg.PoolClient): Promise<void> {
    const role = await db.query<{ valid: boolean }>(`SELECT current_user='tf_app'
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT pg_has_role(current_user,'tf_owner','MEMBER')
      AND NOT has_table_privilege(current_user,'fi.audit_events','UPDATE') AS valid
      FROM pg_roles WHERE rolname=current_user`);
    const source = await db.query<{ schema_version: number; financial_source: string }>(
      'SELECT schema_version,financial_source FROM fi_control.compatibility WHERE singleton',
    );
    const versions = await db.query<{ version: number; checksum: string }>(
      'SELECT version,checksum FROM fi_control.schema_migrations ORDER BY version',
    );
    if (
      !role.rows[0]?.valid ||
      source.rows[0]?.schema_version !== 1 ||
      source.rows[0].financial_source !== financialSource ||
      JSON.stringify(versions.rows) !== JSON.stringify(migrationChecksums)
    )
      throw new DomainError(
        503,
        'SCHEMA_INCOMPATIBLE',
        'Fixed-income schema or role is incompatible.',
      );
  }
}
