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

// Deliberately retains only a safe classification, never subprocess env/stderr/cause.
class OwnedPostgresToolError extends Error {
  constructor(readonly hostPortBinding = false) {
    super(
      hostPortBinding
        ? 'Owned PostgreSQL host-port binding failed; command output omitted.'
        : 'Owned PostgreSQL tool failed; command output omitted.',
    );
  }
}

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
  } catch (error) {
    // Only Docker RUN's confirmed host-bind failures are safe to provision again.
    // Do not retain the subprocess error/cause: it may contain the password environment.
    const failure = error as {
      code?: unknown;
      killed?: unknown;
      signal?: unknown;
      name?: unknown;
      stderr?: unknown;
    } | null;
    if (
      file === 'docker' &&
      args[0] === 'run' &&
      !signal?.aborted &&
      failure?.code === 125 &&
      !failure.killed &&
      !failure.signal &&
      failure.name !== 'AbortError' &&
      typeof failure.stderr === 'string' &&
      failure.stderr.length <= 65536 &&
      /(?:^|\n)(?:docker: )?Error response from daemon:/i.test(failure.stderr) &&
      /(?:listen tcp[46]? 127\.0\.0\.1:[0-9]{1,5}: bind: (?:address already in use|An attempt was made to access a socket in a way forbidden by its access permissions\.)|Bind for 127\.0\.0\.1:[0-9]{1,5} failed: port is already allocated)/i.test(
        failure.stderr,
      )
    )
      throw new OwnedPostgresToolError(true);
    throw new OwnedPostgresToolError();
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
function dockerMetadata(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('Owned Docker metadata is invalid.');
  }
}
async function ownedVolume(owner: OwnedDescriptor): Promise<void> {
  if (!owner.volume) throw new Error('Missing owned volume.');
  const nonce = await tool('docker', [
    'volume',
    'inspect',
    '--format',
    '{{ index .Labels "tradeflow.owner" }}',
    owner.volume,
  ]);
  if (nonce !== owner.nonce) throw new Error('Volume ownership mismatch.');
}
async function dockerId(owner: OwnedDescriptor): Promise<string> {
  const id = await tool('docker', ['inspect', '--format', '{{.Id}}', owner.container!]);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Owned container identity is invalid.');
  return id;
}
async function fixedDockerPort(owner: OwnedDescriptor, expected: string): Promise<void> {
  if (!/^[1-9][0-9]{0,4}$/.test(expected) || Number(expected) > 65535)
    throw new Error('Owned permanent endpoint is invalid.');
  const config = dockerMetadata(
    await tool('docker', [
      'inspect',
      '--format',
      '{{json .HostConfig.PortBindings}}',
      owner.container!,
    ]),
  );
  const rows =
    typeof config === 'object' && config !== null && !Array.isArray(config)
      ? (config as Record<string, unknown>)['5432/tcp']
      : undefined;
  const binding = Array.isArray(rows) && rows.length === 1 ? (rows[0] as unknown) : undefined;
  if (
    typeof config !== 'object' ||
    config === null ||
    Array.isArray(config) ||
    Object.keys(config).length !== 1 ||
    typeof binding !== 'object' ||
    binding === null ||
    Array.isArray(binding) ||
    (binding as Record<string, unknown>)['HostIp'] !== '127.0.0.1' ||
    (binding as Record<string, unknown>)['HostPort'] !== expected
  )
    throw new Error('Owned permanent Docker mapping is not explicit.');
}
async function dockerPort(owner: OwnedDescriptor, expected?: string): Promise<string> {
  const published = await tool('docker', ['port', owner.container!, '5432/tcp']);
  const match = published.match(/^127\.0\.0\.1:([1-9][0-9]{0,4})$/);
  if (!match || Number(match[1]) > 65535)
    throw new Error('Container must bind only one valid IPv4 loopback port.');
  if (expected !== undefined) {
    if (match[1] !== expected) throw new Error('Owned permanent Docker endpoint changed.');
    await fixedDockerPort(owner, expected);
  }
  return match[1]!;
}
async function runDocker(
  owner: OwnedDescriptor,
  hostPort: string,
  password: string,
): Promise<void> {
  // Mutating daemon requests must settle before cancellation can begin cleanup.
  await tool(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      owner.container!,
      '--label',
      `tradeflow.owner=${owner.nonce}`,
      '--publish',
      `127.0.0.1:${hostPort}:5432`,
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
    await ownedVolume(owner);
    const mounts = dockerMetadata(
      await tool('docker', ['inspect', '--format', '{{json .Mounts}}', owner.container]),
    );
    const mount = Array.isArray(mounts) && mounts.length === 1 ? (mounts[0] as unknown) : undefined;
    if (
      typeof mount !== 'object' ||
      mount === null ||
      Array.isArray(mount) ||
      (mount as Record<string, unknown>)['Type'] !== 'volume' ||
      (mount as Record<string, unknown>)['Name'] !== owner.volume ||
      (mount as Record<string, unknown>)['Destination'] !== '/var/lib/postgresql/data' ||
      (mount as Record<string, unknown>)['RW'] !== true
    )
      throw new Error('Owned PostgreSQL data mount mismatch.');
  } else if (!owner.bin || owner.data !== join(owner.directory, 'data'))
    throw new Error('Native ownership mismatch.');
  return owner;
}

type OwnedLifecycle = {
  onAllocated?: (path: string) => void | Promise<void>;
  signal?: AbortSignal;
};
type OwnedInstance = { path: string; stop: (destroy?: boolean) => Promise<void> };

export async function startOwnedPostgres(
  nativeBin?: string,
  lifecycle: OwnedLifecycle = {},
): Promise<OwnedInstance> {
  for (let attempt = 1; ; attempt++) {
    lifecycle.signal?.throwIfAborted();
    try {
      return await startOwnedPostgresAttempt(nativeBin, lifecycle);
    } catch (error) {
      // The failed allocation has completed ownership-checked cleanup before retry.
      lifecycle.signal?.throwIfAborted();
      if (
        nativeBin ||
        !(error instanceof OwnedPostgresToolError) ||
        !error.hostPortBinding ||
        attempt >= 3
      )
        throw error;
      console.warn(
        `Owned PostgreSQL host-port binding rejected; cleaned allocation; provisioning attempt ${attempt + 1}/3.`,
      );
    }
  }
}

async function startOwnedPostgresAttempt(
  nativeBin: string | undefined,
  lifecycle: OwnedLifecycle,
): Promise<OwnedInstance> {
  if (process.platform === 'win32')
    throw new Error('Owned PostgreSQL tooling requires POSIX; use Linux or WSL.');
  const id = randomUUID(),
    nonce = randomBytes(16).toString('hex');
  const directory = resolve('.local/postgres', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const password = randomBytes(32).toString('base64url');
  const url = new URL(
    `postgresql://postgres@127.0.0.1:${nativeBin ? await port() : 0}/tradeflow_local_${randomBytes(8).toString('hex')}`,
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
  let volumeAttempted = false;
  let containerAttempted = false;
  let permanentId: string | undefined;
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
      volumeAttempted = true;
      await tool('docker', [
        'volume',
        'create',
        '--label',
        `tradeflow.owner=${nonce}`,
        owner.volume!,
      ]);
      lifecycle.signal?.throwIfAborted();
      // owner.json remains a private provisional cleanup record (port 0).
      // No usable endpoint is published until the permanent container is ready.
      containerAttempted = true;
      await runDocker(owner, '', password);
      started = true;
      lifecycle.signal?.throwIfAborted();
      await verifyOwned(path);
      url.port = await dockerPort(owner);
      const temporaryId = await dockerId(owner);
      const temporaryAdmin = new URL(url);
      temporaryAdmin.pathname = '/postgres';
      await ready(temporaryAdmin.href, lifecycle.signal);
      lifecycle.signal?.throwIfAborted();
      await verifyOwned(path);
      if ((await dockerId(owner)) !== temporaryId)
        throw new Error('Owned discovery identity changed.');
      await tool('docker', ['stop', temporaryId]);
      const stopped = await tool('docker', [
        'inspect',
        '--format',
        '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}',
        temporaryId,
      ]);
      if (stopped !== 'exited 0 false') throw new Error('Owned discovery shutdown was not clean.');
      await verifyOwned(path);
      if ((await dockerId(owner)) !== temporaryId)
        throw new Error('Owned discovery identity changed.');
      lifecycle.signal?.throwIfAborted();
      await tool('docker', ['rm', temporaryId]);
      lifecycle.signal?.throwIfAborted();
      await ownedVolume(owner);
      const consumers = await tool('docker', ['ps', '-aq', '--filter', `volume=${owner.volume}`]);
      if (consumers) throw new Error('Owned discovery volume is still in use.');
      await runDocker(owner, url.port, password);
      lifecycle.signal?.throwIfAborted();
      await verifyOwned(path);
      await dockerPort(owner, url.port);
      permanentId = await dockerId(owner);
    }
    const adminUrl = new URL(url);
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
    if (owner.kind === 'docker') {
      await ready(url.href, lifecycle.signal);
      await verifyOwned(path);
      if ((await dockerId(owner)) !== permanentId)
        throw new Error('Owned permanent identity changed.');
      await dockerPort(owner, url.port);
      lifecycle.signal?.throwIfAborted();
      owner.adminUrl = url.href;
      await replacePrivate(path, owner);
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
      if (!started && !volumeAttempted && !containerAttempted)
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
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const owner = await verifyOwned(path);
  let permanentId: string | undefined;
  let running = true;
  if (owner.kind === 'docker') {
    permanentId = await dockerId(owner);
    const expectedPort = new URL(owner.adminUrl).port;
    await fixedDockerPort(owner, expectedPort);
    const state = await tool('docker', ['inspect', '--format', '{{.State.Running}}', permanentId]);
    if (state !== 'true' && state !== 'false') throw new Error('Owned container state is invalid.');
    running = state === 'true';
    if (running) await dockerPort(owner, expectedPort);
  }
  signal?.throwIfAborted();
  if (owner.kind === 'docker') {
    if (running) await tool('docker', ['stop', permanentId!]);
  } else await tool(join(owner.bin!, 'pg_ctl'), ['-D', owner.data!, '-m', 'fast', '-w', 'stop']);
  let failure: unknown;
  try {
    signal?.throwIfAborted();
    await whileStopped?.();
    signal?.throwIfAborted();
  } catch (error) {
    failure = error;
  }
  // Restore the original instance before propagating callback failure/cancellation.
  // Never abort the daemon request or readiness needed for this restoration.
  if (owner.kind === 'docker') {
    await verifyOwned(path);
    if ((await dockerId(owner)) !== permanentId)
      throw new Error('Owned permanent identity changed.');
    await fixedDockerPort(owner, new URL(owner.adminUrl).port);
    await tool('docker', ['start', permanentId]);
    await verifyOwned(path);
    if ((await dockerId(owner)) !== permanentId)
      throw new Error('Owned permanent identity changed.');
    await dockerPort(owner, new URL(owner.adminUrl).port);
  } else await nativeStart(owner);
  await ready(owner.adminUrl);
  if (failure)
    throw failure instanceof Error ? failure : new Error('Owned restart callback failed.');
  signal?.throwIfAborted();
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
        `name=^${owner.volume}$`,
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
