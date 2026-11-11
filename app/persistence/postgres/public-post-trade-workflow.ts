import type pg from 'pg';
import { LiveWorkflowDatabase } from './live-workflow.js';
import { DomainError } from '../../domain/errors.js';
import { financialSource } from '../../domain/workflow/database-contract.js';
import { postTradeMigrationChecksums } from '../../domain/post-trade/database-contract.js';
import { verifyPublicProfile } from '../../server/public-demo/profile.js';
import type { TransactionHooks } from './workflow.js';

/** Separate hosted schema10 admission. The private owned-only class is unchanged. */
export class PublicPostTradeWorkflowDatabase extends LiveWorkflowDatabase {
  constructor(target: pg.PoolConfig, hooks: TransactionHooks = {}) {
    const ssl = target.ssl;
    if (
      target.connectionString !== undefined ||
      target.user !== 'tf_app' ||
      !/^tradeflow_public_demo_[a-f0-9]{16}$/.test(target.database ?? '') ||
      !target.host ||
      !ssl ||
      typeof ssl !== 'object' ||
      typeof ssl.ca !== 'string' ||
      !ssl.ca.includes('BEGIN CERTIFICATE') ||
      ssl.ca.includes('PRIVATE KEY') ||
      ssl.rejectUnauthorized !== true ||
      !/^[a-z0-9][a-z0-9-]{0,61}\.railway\.internal$/.test(ssl.servername ?? '') ||
      Object.keys(ssl).some((key) => !['ca', 'rejectUnauthorized', 'servername'].includes(key))
    )
      throw new Error('A dedicated public post-trade app target with verified TLS is required.');
    super(target, hooks);
  }

  protected override async liveCompatible(db: pg.PoolClient): Promise<void> {
    const role = await db.query<{ valid: boolean }>(`SELECT current_user='tf_app'
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT pg_has_role(current_user,'tf_owner','MEMBER')
      AND NOT has_table_privilege(current_user,'fi.audit_events','UPDATE')
      AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='fi' AND c.relname='posttrade_books')
      AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='fi' AND c.relname LIKE 'posttrade_%' AND c.relkind='r'
        AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
          OR has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')))
      AND has_function_privilege(current_user,
        'fi_control.posttrade_command(uuid,text,bigint,text,jsonb,text,uuid)','EXECUTE')
      AND has_function_privilege(current_user,
        'fi_control.read_posttrade(uuid,text,text,bigint,bigint,bigint)','EXECUTE') AS valid
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
      JSON.stringify(versions.rows) !== JSON.stringify(postTradeMigrationChecksums)
    )
      throw new DomainError(
        503,
        'SCHEMA_INCOMPATIBLE',
        'Public post-trade schema or role is incompatible.',
      );
    await verifyPublicProfile(db, 'posttrade');
  }
}
