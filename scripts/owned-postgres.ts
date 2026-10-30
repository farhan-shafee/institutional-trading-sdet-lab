import { randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, unlink, rm, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join, dirname, basename } from 'node:path';
import pg from 'pg';
import { savePrivate, replacePrivate } from './private-state.js';
import { readOwner, type DatabaseOwner } from './workflow-database.js';

const execute = promisify(execFile);
export const postgresImage =
  'postgres:17.10-bookworm@sha256:9b18b78397054fce88a9552e9d5a3ad5bb7fd258c5b3cc1c5028e46373d6ea8f';
export type OwnedDescriptor = DatabaseOwner & {
  kind: 'native' | 'docker';
  directory: string;
  bin?: string;
  data?: string;
  container?: string;
  volume?: string;
};
const settings = [
  '-c',
  'log_statement=none',
  '-c',
  'log_min_error_statement=panic',
  '-c',
  'log_parameter_max_length=0',
  '-c',
  'log_parameter_max_length_on_error=0',
  '-c',
  'log_error_verbosity=terse',
  '-c',
  'log_min_messages=fatal',
  '-c',
  'timezone=UTC',
];

async function tool(
  file: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return (
      await execute(file, args, {
        ...(env ? { env } : {}),
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        ...(signal ? { signal } : {}),
      })
    ).stdout.trim();
  } catch {
    throw new Error('Owned PostgreSQL tool failed; command output omitted.');
  }
}
async function port(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port.');
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}
async function ready(url: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const db = new pg.Client({ connectionString: url, connectionTimeoutMillis: 500 });
    try {
      await db.connect();
      await db.query('SELECT 1');
      await db.end();
      return;
    } catch {
      await db.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('Owned PostgreSQL readiness failed.');
}
async function nativeStart(owner: OwnedDescriptor): Promise<ChildProcess> {
  if (!owner.bin || !owner.data) throw new Error('Missing owned native configuration.');
  const url = new URL(owner.adminUrl);
  const log = await open(join(owner.directory, 'postgres.log'), 'a', 0o600);
  const child = spawn(
    join(owner.bin, 'postgres'),
    [
      '-D',
      owner.data,
      '-h',
      '127.0.0.1',
      '-p',
      url.port,
      '-c',
      'unix_socket_directories=',
      '-c',
      'shared_memory_type=mmap',
      '-c',
      'dynamic_shared_memory_type=mmap',
      ...settings,
    ],
    { stdio: ['ignore', log.fd, log.fd], detached: true },
  );
  child.once('error', () => undefined);
  child.unref();
  await log.close();
  return child;
}
export async function verifyOwned(path: string): Promise<OwnedDescriptor> {
  const owner = (await readOwner(path)) as OwnedDescriptor;
  if (
    !['native', 'docker'].includes(owner.kind) ||
    resolve(dirname(path)) !== owner.directory ||
    !/^[a-f0-9-]{36}$/.test(basename(owner.directory)) ||
    dirname(owner.directory) !== resolve('.local/postgres')
  )
    throw new Error('Not an owned local PostgreSQL instance.');
  if (owner.kind === 'docker') {
    if (!owner.container || !owner.volume) throw new Error('Missing owned container.');
    const label = await tool('docker', [
      'inspect',
      '--format',
      '{{ index .Config.Labels "tradeflow.owner" }}',
      owner.container,
    ]);
    if (label !== owner.nonce) throw new Error('Container ownership mismatch.');
  } else if (!owner.bin || owner.data !== join(owner.directory, 'data'))
    throw new Error('Native ownership mismatch.');
  return owner;
}

export async function startOwnedPostgres(
  nativeBin?: string,
  lifecycle: { onAllocated?: (path: string) => void | Promise<void>; signal?: AbortSignal } = {},
): Promise<{ path: string; stop: (destroy?: boolean) => Promise<void> }> {
  if (process.platform === 'win32')
    throw new Error('Owned PostgreSQL tooling requires POSIX; use Linux or WSL.');
  const id = randomUUID(),
    nonce = randomBytes(16).toString('hex');
  const directory = resolve('.local/postgres', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const password = randomBytes(32).toString('base64url');
  const url = new URL(
    `postgresql://postgres@127.0.0.1:${await port()}/tradeflow_local_${randomBytes(8).toString('hex')}`,
  );
  url.password = password;
  const owner: OwnedDescriptor = {
    version: 1,
    nonce,
    adminUrl: url.href,
    kind: nativeBin ? 'native' : 'docker',
    directory,
    ...(nativeBin
      ? { bin: resolve(nativeBin), data: join(directory, 'data') }
      : { container: `tradeflow-fi-${id}`, volume: `tradeflow-fi-${id}` }),
  };
  const path = join(directory, 'owner.json');
  let started = false;
  let volumeCreated = false;
  let containerAttempted = false;
  try {
    await savePrivate(path, owner);
    await lifecycle.onAllocated?.(path);
    lifecycle.signal?.throwIfAborted();
    if (nativeBin) {
      if (
        !/^postgres \(PostgreSQL\) 17\./.test(
          await tool(join(owner.bin!, 'postgres'), ['--version']),
        )
      )
        throw new Error('PostgreSQL 17 binaries required.');
      const passwordFile = join(directory, 'init-password');
      await savePrivate(passwordFile, { password });
      // initdb expects one raw password line, never a command-line secret.
      const file = await open(passwordFile, 'w', 0o600);
      try {
        await file.writeFile(password + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await tool(join(owner.bin!, 'initdb'), [
          '-D',
          owner.data!,
          '-U',
          'postgres',
          '-A',
          'scram-sha-256',
          '--pwfile',
          passwordFile,
          '--no-locale',
        ]);
      } finally {
        await unlink(passwordFile);
      }
      lifecycle.signal?.throwIfAborted();
      await nativeStart(owner);
      started = true;
    } else {
      await tool('docker', ['pull', postgresImage], undefined, lifecycle.signal);
      lifecycle.signal?.throwIfAborted();
      await tool('docker', [
        'volume',
        'create',
        '--label',
        `tradeflow.owner=${nonce}`,
        owner.volume!,
      ]);
      volumeCreated = true;
      lifecycle.signal?.throwIfAborted();
      containerAttempted = true;
      await tool(
        'docker',
        [
          'run',
          '--detach',
          '--name',
          owner.container!,
          '--label',
          `tradeflow.owner=${nonce}`,
          '--publish',
          '127.0.0.1::5432',
          '--mount',
          `source=${owner.volume},target=/var/lib/postgresql/data`,
          '--env',
          'POSTGRES_PASSWORD',
          '--env',
          'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
          postgresImage,
          'postgres',
          ...settings,
        ],
        { ...process.env, POSTGRES_PASSWORD: password },
      );
      started = true;
      lifecycle.signal?.throwIfAborted();
      const published = await tool('docker', ['port', owner.container!, '5432/tcp']);
      const match = published.match(/^127\.0\.0\.1:(\d+)$/);
      if (!match) throw new Error('Container must bind only loopback.');
      url.port = match[1]!;
      owner.adminUrl = url.href;
      await replacePrivate(path, owner);
    }
    const adminUrl = new URL(owner.adminUrl);
    adminUrl.pathname = '/postgres';
    await ready(adminUrl.href, lifecycle.signal);
    const db = new pg.Client({ connectionString: adminUrl.href });
    await db.connect();
    try {
      const version = (
        await db.query<{ version: string }>("SELECT current_setting('server_version') AS version")
      ).rows[0]?.version;
      if (!version?.startsWith('17.')) throw new Error('PostgreSQL 17 required.');
      await db.query(`CREATE DATABASE ${pg.escapeIdentifier(url.pathname.slice(1))}`);
      await db.query(
        `COMMENT ON DATABASE ${pg.escapeIdentifier(url.pathname.slice(1))} IS ${pg.escapeLiteral(`TradeFlow local owner ${nonce}`)}`,
      );
    } finally {
      await db.end();
    }
    lifecycle.signal?.throwIfAborted();
    let cleanup: Promise<void> | undefined;
    return {
      path,
      stop: (destroy = true) =>
        destroy ? (cleanup ??= stopOwnedPostgres(path, true)) : stopOwnedPostgres(path, false),
    };
  } catch (error) {
    try {
      if (!started && !volumeCreated && !containerAttempted)
        await rm(directory, { recursive: true, force: true });
      else await stopOwnedPostgres(path, true);
    } catch {
      throw new Error(
        `Owned PostgreSQL setup and cleanup failed${started ? ' after startup' : ''}; inspect the private instance directory.`,
      );
    }
    throw error;
  }
}

export async function restartOwnedPostgres(
  path: string,
  whileStopped?: () => Promise<void>,
): Promise<void> {
  const owner = await verifyOwned(path);
  if (owner.kind === 'docker') await tool('docker', ['stop', owner.container!]);
  else await tool(join(owner.bin!, 'pg_ctl'), ['-D', owner.data!, '-m', 'fast', '-w', 'stop']);
  let failure: unknown;
  try {
    await whileStopped?.();
  } catch (error) {
    failure = error;
  }
  if (owner.kind === 'docker') await tool('docker', ['start', owner.container!]);
  else await nativeStart(owner);
  await ready(owner.adminUrl);
  if (failure)
    throw failure instanceof Error ? failure : new Error('Owned restart callback failed.');
}
export async function stopOwnedPostgres(path: string, destroy: boolean): Promise<void> {
  const owner = (await readOwner(path)) as OwnedDescriptor;
  if (
    resolve(dirname(path)) !== owner.directory ||
    dirname(owner.directory) !== resolve('.local/postgres') ||
    !/^[a-f0-9-]{36}$/.test(basename(owner.directory))
  )
    throw new Error('Instance ownership mismatch.');
  if (owner.kind === 'docker') {
    if (!owner.container || !owner.volume) throw new Error('Missing owned resources.');
    const present = await tool('docker', [
      'ps',
      '-a',
      '--filter',
      `name=^/${owner.container}$`,
      '--format',
      '{{.Names}}',
    ]);
    if (
      present &&
      (await tool('docker', [
        'inspect',
        '--format',
        '{{ index .Config.Labels "tradeflow.owner" }}',
        owner.container,
      ])) !== owner.nonce
    )
      throw new Error('Container ownership mismatch.');
    if (destroy) {
      if (present) await tool('docker', ['rm', '--force', owner.container]);
      const volume = await tool('docker', [
        'volume',
        'ls',
        '--filter',
        `label=tradeflow.owner=${owner.nonce}`,
        '--format',
        '{{.Name}}',
      ]);
      if (volume.split('\n').includes(owner.volume)) {
        const label = await tool('docker', [
          'volume',
          'inspect',
          '--format',
          '{{ index .Labels "tradeflow.owner" }}',
          owner.volume,
        ]);
        if (label !== owner.nonce) throw new Error('Volume ownership mismatch.');
        await tool('docker', ['volume', 'rm', owner.volume]);
      }
    } else if (present) await tool('docker', ['stop', owner.container]);
  } else if (owner.kind === 'native' && owner.bin && owner.data === join(owner.directory, 'data')) {
    if (
      await access(join(owner.data, 'postmaster.pid')).then(
        () => true,
        () => false,
      )
    )
      await tool(join(owner.bin, 'pg_ctl'), ['-D', owner.data, '-m', 'fast', '-w', 'stop']);
  } else throw new Error('Invalid owned instance.');
  if (destroy) await rm(owner.directory, { recursive: true, force: true });
}
