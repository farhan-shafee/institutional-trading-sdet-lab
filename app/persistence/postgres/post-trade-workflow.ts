import type pg from 'pg';
import { LiveWorkflowDatabase } from './live-workflow.js';
import { DomainError } from '../../domain/errors.js';
import { financialSource } from '../../domain/workflow/database-contract.js';
import { postTradeMigrationChecksums } from '../../domain/post-trade/database-contract.js';
import type { TransactionHooks } from './workflow.js';

/** Explicit owned-only schema10 profile. Never selected by hosted configuration. */
export class PostTradeWorkflowDatabase extends LiveWorkflowDatabase {
  constructor(databaseUrl: string, hooks: TransactionHooks = {}) {
    const url = new URL(databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hostname !== '127.0.0.1' ||
      url.username !== 'tf_app' ||
      !/^\/tradeflow_(local|ci)_[a-f0-9]{16}$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error('An owned loopback app target is required.');
    super(databaseUrl, hooks);
  }
  protected override async liveCompatible(db: pg.PoolClient): Promise<void> {
    const role = await db.query<{ valid: boolean }>(`SELECT current_user='tf_app'
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT pg_has_role(current_user,'tf_owner','MEMBER')
      AND NOT has_table_privilege(current_user,'fi.audit_events','UPDATE')
      AND NOT has_table_privilege(current_user,'fi.posttrade_books','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS valid
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
        'Fixed-income schema or role is incompatible.',
      );
  }
}
