import { spawn } from 'node:child_process';
import pg from 'pg';
import {
  startOwnedPostgres,
  restartOwnedPostgres,
  stopOwnedPostgres,
  verifyOwned,
} from './owned-postgres.js';
import { bootstrap } from './workflow-database.js';

const [operation, path] = process.argv.slice(2);
try {
  if (operation === 'create') {
    const instance = await startOwnedPostgres();
    try {
      await bootstrap(instance.path);
    } catch (error) {
      await instance.stop();
      throw error;
    }
    console.log(`Owned local PostgreSQL ready. Private owner descriptor: ${instance.path}`);
  } else {
    if (!path) throw new Error('An owned private descriptor path is required.');
    const owner = await verifyOwned(path);
    if (owner.kind !== 'docker' && operation !== 'destroy')
      throw new Error(
        'Persistent local tooling uses Docker; native descriptors support owned recovery destruction only.',
      );
    if (operation === 'resume') await restartOwnedPostgres(path);
    else if (operation === 'stop') await stopOwnedPostgres(path, false);
    else if (operation === 'destroy') await stopOwnedPostgres(path, true);
    else if (operation === 'purge') {
      if (!owner.maintenanceUrl) throw new Error('Maintenance role required.');
      const db = new pg.Client({ connectionString: owner.maintenanceUrl });
      await db.connect();
      try {
        const result = await db.query<{ removed: number }>(
          'SELECT fi_control.purge_expired() AS removed',
        );
        console.log(`Expired sandboxes purged: ${String(result.rows[0]?.removed)}`);
      } finally {
        await db.end();
      }
    } else if (operation === 'serve') {
      if (!owner.appUrl || !process.env.npm_execpath)
        throw new Error('Invoke through npm using an initialized owned database.');
      const build = spawn(process.execPath, [process.env.npm_execpath, 'run', 'build:ui'], {
        stdio: 'inherit',
      });
      const built = await new Promise<number | null>((resolve) => build.once('exit', resolve));
      if (built !== 0) throw new Error('Browser build failed.');
      const app = spawn(process.execPath, ['--import', 'tsx', 'app/server/index.ts'], {
        stdio: 'inherit',
        env: {
          ...process.env,
          TRADEFLOW_MODE: 'local',
          TRADEFLOW_HOST: '127.0.0.1',
          TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
          TRADEFLOW_FIXED_INCOME_DATABASE_URL: owner.appUrl,
        },
      });
      process.once('SIGINT', () => app.kill('SIGINT'));
      process.once('SIGTERM', () => app.kill('SIGTERM'));
      process.exitCode =
        (await new Promise<number | null>((resolve) => app.once('exit', resolve))) ?? 1;
    } else throw new Error('Use create, resume, serve, purge, stop or destroy.');
  }
} catch {
  console.error('Owned local PostgreSQL operation failed. Credentials and tool output omitted.');
  process.exitCode = 1;
}
