import { once } from 'node:events';
import { createApplicationServer } from '../app/server/index.js';
import { readConfiguration } from '../app/server/configuration.js';
import { PostTradeWorkflowDatabase } from '../app/persistence/postgres/post-trade-workflow.js';
import {
  startOwnedPostgres,
  verifyOwned,
  restartOwnedPostgres,
  stopOwnedPostgres,
} from './owned-postgres.js';
import { bootstrap } from './workflow-database.js';
import { migratePostTrade } from './posttrade-workflow-database.js';

/** Explicit private schema10 entry point. The standard/hosted startup remains unchanged. */
async function main() {
  const [operation, path, portText, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Unexpected owned local arguments.');
  if (operation === 'create') {
    if (path || portText) throw new Error('Create allocates its own private descriptor.');
    const owned = await startOwnedPostgres();
    try {
      await bootstrap(owned.path);
      await migratePostTrade(owned.path);
    } catch (error) {
      await owned.stop(true);
      throw error;
    }
    console.log('Owned post-trade local database ready. Private descriptor: ' + owned.path);
    return;
  }
  if (!path) throw new Error('An owned private descriptor is required.');
  const owner = await verifyOwned(path);
  if (owner.kind !== 'docker' && operation !== 'destroy')
    throw new Error('Persistent local lifecycle requires the existing Docker profile.');
  if (operation !== 'serve' && portText !== undefined)
    throw new Error('Unexpected owned lifecycle arguments.');
  if (operation === 'resume') {
    await restartOwnedPostgres(path);
    return;
  }
  if (operation === 'stop') {
    await stopOwnedPostgres(path, false);
    return;
  }
  if (operation === 'destroy') {
    await stopOwnedPostgres(path, true);
    return;
  }
  if (operation !== 'serve' || !owner.appUrl)
    throw new Error('Use create, resume, serve, stop or destroy.');
  const text = portText ?? '0',
    port = Number(text);
  if (!/^(0|[1-9][0-9]{0,4})$/.test(text) || port > 65535)
    throw new Error('An integer loopback port is required.');
  const database = new PostTradeWorkflowDatabase(owner.appUrl);
  let server: ReturnType<typeof createApplicationServer> | undefined;
  try {
    await database.transaction(
      true,
      () => {},
      () => Promise.resolve(null),
    );
    const configuration = readConfiguration({
      TRADEFLOW_MODE: 'local',
      TRADEFLOW_HOST: '127.0.0.1',
      TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
      TRADEFLOW_FIXED_INCOME_DATABASE_URL: owner.appUrl,
    });
    server = createApplicationServer({ configuration, workflowDatabase: database });
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1')
      throw new Error('Owned loopback listener required.');
    console.log('OWNED_POSTTRADE_READY http://127.0.0.1:' + address.port);
    await new Promise<void>((resolve, reject) => {
      const stop = () => resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      server!.once('error', reject);
    });
  } finally {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
        server!.closeIdleConnections();
      });
    }
    await database.close();
  }
}
try {
  await main();
} catch {
  console.error('Owned post-trade local operation failed; private connection material omitted.');
  process.exitCode = 1;
}
