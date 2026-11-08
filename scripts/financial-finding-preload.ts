/** Only the owned synthetic capacity worker and the separate failure demo install this observer. */
import pg from 'pg';
import { resolve } from 'node:path';
import { verifyOwned } from './owned-postgres.js';
import { localDatabaseUrl } from './workflow-database.js';
import {
  captureWorker,
  FinancialFindingRecorder,
  loadCaptureSources,
  privateCaptureSink,
} from './financial-finding-capture.js';

if (captureWorker(process.argv[1])) {
  try {
    const path = process.env['TF_DB_OWNER_FILE'];
    if (!path) throw new Error('Missing owned descriptor.');
    // The immutable supervisor has already verified the live database's nonce during bootstrap.
    const owner = await verifyOwned(path);
    if (!owner.reconcilerUrl) throw new Error('Missing owned reconciler.');
    const admin = localDatabaseUrl(owner.adminUrl);
    const url = localDatabaseUrl(owner.reconcilerUrl);
    if (
      url.host !== admin.host ||
      url.pathname !== admin.pathname ||
      url.username !== 'tf_reconciler'
    )
      throw new Error('Owned role mismatch.');
    const demo = process.argv[1] === resolve('tests/diagnostics/financial-finding-capture.demo.ts');
    const recorder = new FinancialFindingRecorder(
      await loadCaptureSources(),
      privateCaptureSink(demo ? resolve('artifacts/financial-capture-demo') : resolve('artifacts')),
    );
    const original: unknown = Reflect.get(pg.Client.prototype, 'query');
    if (typeof original !== 'function') throw new Error('Missing PostgreSQL query method.');
    pg.Client.prototype.query = recorder.wrap(
      original as (this: object, ...args: unknown[]) => unknown,
      (client) => {
        const c = client as { host?: unknown; port?: unknown; database?: unknown; user?: unknown };
        return (
          c.host === '127.0.0.1' &&
          c.port === Number(url.port || '5432') &&
          c.database === url.pathname.slice(1) &&
          c.user === 'tf_reconciler'
        );
      },
    ) as pg.Client['query'];
  } catch {
    // Observability must never replace or manufacture a test's financial outcome.
    process.stderr.write(
      'TF_FINANCIAL_CAPTURE_INCOMPLETE: owned observer admission failed; original tests continue.\n',
    );
  }
}
