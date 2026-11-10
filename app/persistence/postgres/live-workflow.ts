import type pg from 'pg';
import { WorkflowDatabase } from './workflow.js';
import { DomainError } from '../../domain/errors.js';
import { financialSource } from '../../domain/workflow/database-contract.js';
import { liveMigrationChecksums } from '../../domain/workflow/live-database-contract.js';
import { checkoutClient, type ClientLease } from './client-errors.js';
import { type DatabaseTarget } from '../../server/public-demo/configuration.js';

import type { TransactionHooks } from './workflow.js';

/** Explicit schema9 client; default schema8 clients remain unchanged. */
export class LiveWorkflowDatabase extends WorkflowDatabase {
  private livePending = 0;
  private liveClosing: Promise<void> | undefined;
  constructor(
    databaseUrl: DatabaseTarget,
    private readonly liveHooks: TransactionHooks = {},
  ) {
    super(databaseUrl);
  }
  override close(): Promise<void> {
    return (this.liveClosing ??= this.pool.end());
  }
  override async transaction<T>(
    readOnly: boolean,
    verify: () => void,
    work: (db: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    if (this.livePending >= 12 || this.liveClosing)
      throw new DomainError(
        503,
        'DATABASE_UNAVAILABLE',
        'Fixed-income persistence is unavailable.',
      );
    this.livePending++;
    const deadline = performance.now() + 5000;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        let db: pg.PoolClient | undefined;
        let lease: ClientLease | undefined;
        let commitDispatched = false;
        try {
          verify();
          lease = await checkoutClient(this.pool);
          db = lease.client;
          await db.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
          await db.query("SET LOCAL statement_timeout='1500ms'");
          await db.query("SET LOCAL lock_timeout='750ms'");
          await db.query("SET LOCAL idle_in_transaction_session_timeout='2000ms'");
          await this.liveCompatible(db);
          verify();
          const result = await work(db);
          if (!readOnly) await this.liveHooks.beforeCommit?.();
          verify();
          if (performance.now() > deadline)
            throw new DomainError(
              503,
              'DATABASE_TIMEOUT',
              'The fixed-income transaction deadline elapsed.',
            );
          commitDispatched = true;
          await db.query('COMMIT');
          if (!readOnly) await this.liveHooks.afterCommit?.();
          if (lease.error) throw lease.error;
          lease.release();
          db = undefined;
          return result;
        } catch (error: unknown) {
          if (db) {
            if (!commitDispatched) await db.query('ROLLBACK').catch(() => undefined);
            lease!.release(true);
          }
          if (error instanceof DomainError) throw error;
          if (
            !commitDispatched &&
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'TF409'
          )
            throw new DomainError(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              'The key belongs to another fixed-income command.',
            );
          if (
            !commitDispatched &&
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'TF429'
          )
            throw new DomainError(
              429,
              'PROTECTED_FINANCIAL_CAPACITY',
              'Capacity is reserved for an owned workflow.',
            );
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
      this.livePending--;
    }
  }
  protected async liveCompatible(db: pg.PoolClient): Promise<void> {
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
      JSON.stringify(versions.rows) !== JSON.stringify(liveMigrationChecksums)
    )
      throw new DomainError(
        503,
        'SCHEMA_INCOMPATIBLE',
        'Fixed-income schema or role is incompatible.',
      );
  }
}
