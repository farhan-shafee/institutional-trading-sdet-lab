import { readConfiguration } from '../../app/server/configuration.js';
import {
  WorkflowDatabase,
  type TransactionHooks,
} from '../../app/persistence/postgres/workflow.js';
import { owner, imageOwner, connection, imageMode, roleTarget, imageControl } from './database.js';
import { httpLab } from '../postgres/http.js';
import { postgresTlsProxy } from './tls-fixture.js';

export async function publicHttp(hooks?: TransactionHooks, now?: () => number) {
  const owned = await owner();
  const transport = imageMode ? undefined : await postgresTlsProxy(owned.appUrl!);
  const targets = imageMode
    ? {
        app: await roleTarget('app'),
        reconciler: await roleTarget('reconciler'),
        maintenance: await roleTarget('maintenance'),
      }
    : {
        app: transport!.target(owned.appUrl!),
        reconciler: transport!.target(owned.reconcilerUrl!),
        maintenance: transport!.target(owned.maintenanceUrl!),
      };
  const db = new WorkflowDatabase(targets.app, hooks);
  const config = {
    ...readConfiguration({ TRADEFLOW_MODE: 'hosted-demo', TRADEFLOW_HOST: '127.0.0.1' }),
    publicDemo: {
      ...targets,
    },
  };
  if (imageMode) {
    const metadata = await imageOwner();
    const validated = readConfiguration({
      TRADEFLOW_MODE: 'hosted-demo',
      TRADEFLOW_HOST: '127.0.0.1',
      TRADEFLOW_PUBLIC_DEMO: 'on',
      TRADEFLOW_PUBLIC_DEMO_DATABASE_CA: metadata.ca,
      TRADEFLOW_PUBLIC_DEMO_DATABASE_URL: metadata.appUrl,
      TRADEFLOW_PUBLIC_DEMO_RECONCILER_URL: metadata.reconcilerUrl,
      TRADEFLOW_PUBLIC_DEMO_MAINTENANCE_URL: metadata.maintenanceUrl,
    });
    if (!validated.publicDemo) throw new Error('Expected explicit public profile.');
    // Match production validation; route only the test TCP connection to its owned mapped port.
    for (const role of ['app', 'reconciler', 'maintenance'] as const)
      validated.publicDemo[role].host = '127.0.0.1';
    config.publicDemo = validated.publicDemo;
  }
  const lab = await httpLab(config, db, now);
  let stopped = false;
  return {
    ...lab,
    disconnectPersistence: async () => {
      if (imageMode) {
        stopped = true;
        await imageControl('stop');
      } else await transport!.close();
    },
    async close() {
      await lab.close();
      if (stopped) await imageControl('resume');
      await transport?.close();
      const admin = await connection('admin');
      const maintenance = await connection('maintenance');
      try {
        await admin.query('BEGIN');
        await admin.query("SET LOCAL session_replication_role='replica'");
        await admin.query(
          "UPDATE fi.reconciliation_runs SET requested_at=requested_at-interval '1 minute',started_at=started_at-interval '1 minute',lease_expires_at=clock_timestamp()-interval '1 second' WHERE state IN ('REQUESTED','RUNNING')",
        );
        await admin.query('COMMIT');
        await admin.query(
          "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days'",
        );
        await maintenance.query('SELECT fi_control.purge_public_demo_expired()');
      } finally {
        await admin.end();
        await maintenance.end();
      }
    },
  };
}
