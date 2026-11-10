import pg from 'pg';
import { DomainError } from '../../domain/errors.js';
import { financialSource, migrationChecksums } from '../../domain/workflow/database-contract.js';
import { checkoutClient, type ClientLease } from '../../persistence/postgres/client-errors.js';
import { databaseConnection, type DatabaseTarget } from '../public-demo/configuration.js';
import { postTradeMigrationChecksums } from '../../domain/post-trade/database-contract.js';
import { verifyPublicProfile } from '../public-demo/profile.js';
export type VerificationHooks = {
  beforeCommit?: () => void | Promise<void>;
  afterCommit?: () => void | Promise<void>;
};
/** Credential stays server-side; financial relations remain SELECT-only for this role. */
export class VerificationDatabase {
  readonly pool: pg.Pool;
  private pending = 0;
  private closing: Promise<void> | undefined;
  constructor(
    url: DatabaseTarget,
    private readonly hooks: VerificationHooks = {},
    private readonly profile?: 'public-posttrade-v1',
  ) {
    if (profile) {
      const ssl = typeof url === 'string' ? undefined : url.ssl;
      if (
        typeof url === 'string' ||
        url.connectionString !== undefined ||
        url.user !== 'tf_reconciler' ||
        !/^tradeflow_public_demo_[a-f0-9]{16}$/.test(url.database ?? '') ||
        !url.host ||
        !ssl ||
        typeof ssl !== 'object' ||
        typeof ssl.ca !== 'string' ||
        !ssl.ca.includes('BEGIN CERTIFICATE') ||
        ssl.ca.includes('PRIVATE KEY') ||
        ssl.rejectUnauthorized !== true ||
        !/^[a-z0-9][a-z0-9-]{0,61}\.railway\.internal$/.test(ssl.servername ?? '') ||
        Object.keys(ssl).some((key) => !['ca', 'rejectUnauthorized', 'servername'].includes(key))
      )
        throw new Error('A dedicated public reconciler target with verified TLS is required.');
    }
    this.pool = new pg.Pool({
      ...databaseConnection(url),
      max: 2,
      connectionTimeoutMillis: 500,
      query_timeout: 2000,
      idleTimeoutMillis: 1000,
      allowExitOnIdle: true,
    });
    this.pool.on('error', () => {});
  }
  close() {
    return (this.closing ??= this.pool.end());
  }
  async transaction<T>(
    readOnly: boolean,
    verify: () => void,
    work: (client: pg.PoolClient) => Promise<T>,
    hooks: VerificationHooks = this.hooks,
  ): Promise<T> {
    if (this.pending >= 4 || this.closing)
      throw new DomainError(503, 'RECONCILER_UNAVAILABLE', 'Reconciliation is unavailable.');
    this.pending++;
    let client: pg.PoolClient | undefined,
      committing = false;
    let lease: ClientLease | undefined;
    const deadline = performance.now() + 5000;
    try {
      verify();
      lease = await checkoutClient(this.pool);
      client = lease.client;
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      await client.query("SET LOCAL statement_timeout='1500ms'");
      await client.query("SET LOCAL lock_timeout='750ms'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='2000ms'");
      const role = await client.query<{ valid: boolean }>(
        `SELECT current_user='tf_reconciler' AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT pg_has_role(current_user,'tf_owner','MEMBER') AND NOT has_table_privilege(current_user,'fi.executions','INSERT,UPDATE,DELETE,TRUNCATE') AND NOT has_table_privilege(current_user,'fi.reconciliation_runs','INSERT,UPDATE,DELETE,TRUNCATE') AS valid FROM pg_roles WHERE rolname=current_user`,
      );
      const versions = await client.query<{ version: number; checksum: string }>(
        'SELECT version,checksum FROM fi_control.schema_migrations ORDER BY version',
      );
      const source = await client.query<{ financial_source: string }>(
        'SELECT financial_source FROM fi_control.compatibility WHERE singleton',
      );
      if (
        !role.rows[0]?.valid ||
        source.rows[0]?.financial_source !== financialSource ||
        JSON.stringify(versions.rows) !==
          JSON.stringify(this.profile ? postTradeMigrationChecksums : migrationChecksums)
      )
        throw new DomainError(
          503,
          'SCHEMA_INCOMPATIBLE',
          'Reconciliation schema/role is incompatible.',
        );
      if (this.profile) {
        await verifyPublicProfile(client, 'posttrade');
        const isolation = await client.query<{ valid: boolean }>(`SELECT
          NOT has_function_privilege(current_user,'fi_control.posttrade_command(uuid,text,bigint,text,jsonb,text,uuid)','EXECUTE')
          AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='fi' AND c.relname LIKE 'posttrade_%' AND c.relkind='r'
            AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))) AS valid`);
        if (!isolation.rows[0]?.valid)
          throw new DomainError(
            503,
            'SCHEMA_INCOMPATIBLE',
            'Public reconciliation authority is incompatible.',
          );
      }
      verify();
      const result = await work(client);
      if (!readOnly) await hooks.beforeCommit?.();
      verify();
      if (performance.now() > deadline)
        throw new DomainError(503, 'VERIFICATION_TIMEOUT', 'Reconciliation deadline elapsed.');
      committing = true;
      await client.query('COMMIT');
      if (!readOnly) await hooks.afterCommit?.();
      if (lease.error) throw lease.error;
      lease.release();
      client = undefined;
      return result;
    } catch (error) {
      if (client) {
        if (!committing) await client.query('ROLLBACK').catch(() => undefined);
        lease!.release(true);
      }
      if (error instanceof DomainError) throw error;
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      throw new DomainError(
        503,
        !readOnly && committing
          ? 'OUTCOME_UNKNOWN'
          : code === '57014'
            ? 'VERIFICATION_TIMEOUT'
            : lease?.error ||
                ['57P01', '57P02', '57P03'].includes(code) ||
                code.startsWith('08') ||
                code.startsWith('ECONN')
              ? 'RECONCILER_UNAVAILABLE'
              : 'RECONCILIATION_SQL_FAILURE',
        'Reconciliation did not complete. Retry only the original retained request.',
      );
    } finally {
      this.pending--;
    }
  }
}
