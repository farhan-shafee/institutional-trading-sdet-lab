import pg from 'pg';
import { DomainError } from '../../domain/errors.js';
import { databaseConnection, type DatabaseTarget } from './configuration.js';
import { verifyPublicProfile } from './profile.js';

export class PublicDemoMaintenance {
  private readonly pool: pg.Pool;
  private pending: Promise<void> | undefined;
  private interval: NodeJS.Timeout | undefined;
  private lastAttempt = -Infinity;
  private lastSuccess = -Infinity;
  private closed = false;
  constructor(
    target: DatabaseTarget,
    private readonly now = () => performance.now(),
  ) {
    this.pool = new pg.Pool({
      ...databaseConnection(target),
      max: 1,
      connectionTimeoutMillis: 500,
      query_timeout: 2000,
      idleTimeoutMillis: 1000,
      allowExitOnIdle: true,
    });
    this.pool.on('error', () => {
      this.lastSuccess = -Infinity;
    });
  }
  start(): void {
    const tick = () => {
      void this.sweep().catch(() =>
        console.error('TradeFlow public demo maintenance unavailable.'),
      );
    };
    tick();
    this.interval = setInterval(tick, 60_000);
    this.interval.unref();
  }
  async ensure(): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.closed && this.now() - this.lastSuccess < 60_000) return;
    if (this.closed || this.now() - this.lastAttempt < 60_000)
      throw new DomainError(
        503,
        'PUBLIC_DEMO_MAINTENANCE_UNAVAILABLE',
        'Public workspace admission is temporarily unavailable.',
      );
    return this.sweep();
  }
  private sweep(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.closed) return Promise.reject(new Error('Public demo maintenance closed.'));
    this.lastAttempt = this.now();
    const work = async () => {
      const db = await this.pool.connect();
      try {
        await db.query('BEGIN');
        await db.query("SET LOCAL statement_timeout='1500ms'");
        await db.query("SET LOCAL lock_timeout='750ms'");
        await db.query("SET LOCAL idle_in_transaction_session_timeout='2000ms'");
        const role = await db.query<{ valid: boolean }>(
          "SELECT current_user='tf_maintenance' AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT pg_has_role(current_user,'tf_owner','MEMBER') AS valid FROM pg_roles WHERE rolname=current_user",
        );
        if (!role.rows[0]?.valid) throw new Error('Invalid public maintenance authority.');
        await verifyPublicProfile(db);
        await db.query('SELECT fi_control.purge_public_demo_expired()');
        await db.query('COMMIT');
        this.lastSuccess = this.now();
      } catch (error) {
        this.lastSuccess = -Infinity;
        await db.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        db.release();
      }
    };
    this.pending = work().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.interval);
    await this.pending?.catch(() => undefined);
    await this.pool.end();
  }
}
