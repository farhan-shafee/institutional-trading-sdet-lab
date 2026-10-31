import { spawn, type ChildProcess } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { startOwnedPostgres } from './owned-postgres.js';
import { bootstrap, readOwner } from './workflow-database.js';

export class VerificationCancelled extends Error {
  constructor(readonly exitCode: number) {
    super('Owned PostgreSQL verification cancelled.');
  }
}
type Options = {
  arguments?: string[];
  onPhase?: (phase: 'startup' | 'execution', path: string) => void;
};
export async function runPostgresVerification(options: Options = {}): Promise<void> {
  const controller = new AbortController();
  let cancellationCode = 143;
  let child: ChildProcess | undefined;
  let childExited: Promise<number | null> | undefined;
  let force: NodeJS.Timeout | undefined;
  let instance: Awaited<ReturnType<typeof startOwnedPostgres>> | undefined;
  const terminate = (signal: NodeJS.Signals) => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  const cancel = (code: number) => {
    if (controller.signal.aborted) return;
    cancellationCode = code;
    controller.abort();
    terminate('SIGTERM');
    force = setTimeout(() => terminate('SIGKILL'), 1000);
    force.unref();
  };
  const interrupt = () => cancel(130),
    shutdown = () => cancel(143);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', shutdown);
  const check = () => {
    if (controller.signal.aborted) throw new VerificationCancelled(cancellationCode);
  };
  try {
    instance = await startOwnedPostgres(process.env.TF_PG_BIN, {
      signal: controller.signal,
      onAllocated: async (path) => {
        options.onPhase?.('startup', path);
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    });
    check();
    await bootstrap(instance.path);
    check();
    const tests = (await readdir('tests/postgres'))
      .filter((name) => name.endsWith('.test.ts'))
      .sort()
      .map((name) => 'tests/postgres/' + name);
    child = spawn(
      process.execPath,
      options.arguments ?? [
        '--import',
        'tsx',
        '--test',
        '--test-concurrency=1',
        '--test-timeout=30000',
        ...tests,
      ],
      {
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, TF_DB_OWNER_FILE: instance.path },
      },
    );
    childExited = new Promise<number | null>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('exit', resolve);
    });
    child.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'phase' in message &&
        message.phase === 'ready'
      )
        options.onPhase?.('execution', instance!.path);
    });
    const code = await childExited;
    check();
    if (code !== 0) throw new Error('Real PostgreSQL verification failed.');
    const owner = await readOwner(instance.path);
    const observer = new pg.Client({
      connectionString: owner.adminUrl,
      connectionTimeoutMillis: 500,
      query_timeout: 2000,
    });
    await observer.connect();
    try {
      const result = await observer.query<{ clean: boolean }>(
        'SELECT retained_count=0 AND (SELECT count(*) FROM fi.sandboxes)=0 AS clean FROM fi_control.service_capacity',
      );
      if (!result.rows[0]?.clean) throw new Error('Test-owned sandboxes were not cleaned up.');
    } finally {
      await observer.end();
    }
    check();
    console.log('Real PostgreSQL verification passed; retained capacity returned to zero.');
  } catch (error) {
    if (controller.signal.aborted) throw new VerificationCancelled(cancellationCode);
    throw error;
  } finally {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        terminate('SIGTERM');
        force ??= setTimeout(() => terminate('SIGKILL'), 1000);
        await childExited;
      }
      if (controller.signal.aborted) terminate('SIGKILL');
      if (force) clearTimeout(force);
      await instance?.stop();
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', shutdown);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runPostgresVerification().catch((error) => {
    console.error(
      'Real PostgreSQL verification did not complete; inspect test output. Private connection material omitted.',
    );
    process.exitCode = error instanceof VerificationCancelled ? error.exitCode : 1;
  });
}
