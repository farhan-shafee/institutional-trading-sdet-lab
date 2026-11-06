import pg from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { loadPrivate } from '../../scripts/private-state.js';
import { owner as legacyOwner, connection as legacyConnection } from '../postgres/harness.js';

const execute = promisify(execFile);
const schema = z
  .object({
    version: z.literal(1),
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    container: z.string(),
    volume: z.string(),
    hostname: z.literal('public-postgres.railway.internal'),
    database: z.string().regex(/^tradeflow_public_demo_[a-f0-9]{16}$/),
    source_snapshot: z.string().regex(/^[a-f0-9]{64}$/),
    ca: z.string(),
    nativeOrigin: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'http:' &&
          url.hostname === '127.0.0.1' &&
          !!url.port &&
          url.pathname === '/' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      })
      .optional(),
    adminUrl: z.string(),
    appUrl: z.string(),
    migratorUrl: z.string(),
    reconcilerUrl: z.string(),
    maintenanceUrl: z.string(),
  })
  .strict();
let descriptor: Promise<z.infer<typeof schema>> | undefined;
export const imageMode = !!process.env.TF_PUBLIC_IMAGE_OWNER_FILE;
export async function imageOwner() {
  const path = process.env.TF_PUBLIC_IMAGE_OWNER_FILE!;
  descriptor ??= (async () => {
    const data = schema.parse(await loadPrivate(path));
    if (
      data.container !== 'tradeflow-public-test-' + data.nonce ||
      data.volume !== data.container + '-data'
    )
      throw new Error('Public test ownership mismatch.');
    for (const role of ['admin', 'app', 'migrator', 'reconciler', 'maintenance'] as const) {
      const url = new URL(data[`${role}Url`]);
      if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        url.hostname !== data.hostname ||
        !/^\d{1,5}$/.test(url.port) ||
        Number(url.port) < 1 ||
        Number(url.port) > 65535 ||
        url.pathname !== '/' + data.database ||
        url.username !== (role === 'admin' ? 'postgres' : 'tf_' + role) ||
        url.search ||
        url.hash
      )
        throw new Error('Public test database target mismatch.');
    }
    return data;
  })();
  return descriptor;
}
export async function owner() {
  return imageMode ? imageOwner() : legacyOwner();
}
export async function roleTarget(
  role: 'admin' | 'app' | 'migrator' | 'reconciler' | 'maintenance',
): Promise<pg.PoolConfig> {
  if (!imageMode) {
    const value = (await legacyOwner())[`${role}Url`];
    if (!value) throw new Error('Missing public test role.');
    return { connectionString: value };
  }
  const data = await imageOwner(),
    value = data[`${role}Url`];
  const url = new URL(value);
  // Only TCP routing is adapted to the owned local mapped port; TLS verifies the configured name.
  return {
    host: '127.0.0.1',
    port: Number(url.port),
    database: url.pathname.slice(1),
    user: url.username,
    password: decodeURIComponent(url.password),
    ssl: { ca: data.ca, rejectUnauthorized: true, servername: url.hostname },
  };
}
export async function connection(
  role: 'admin' | 'app' | 'migrator' | 'reconciler' | 'maintenance',
) {
  if (!imageMode) return legacyConnection(role);
  const db = new pg.Client({
    ...(await roleTarget(role)),
    connectionTimeoutMillis: 1000,
    query_timeout: 2000,
  });
  await db.connect();
  return db;
}
export async function imageControl(action: 'stop' | 'resume') {
  if (!imageMode) throw new Error('Image operation needs explicit owned test metadata.');
  const data = await imageOwner();
  const proof = await execute(
    'docker',
    ['container', 'inspect', data.container, '--format', '{{json .Config.Labels}}'],
    { timeout: 10000, encoding: 'utf8' },
  );
  const labels = z.record(z.string(), z.string()).parse(JSON.parse(proof.stdout));
  if (labels['tradeflow.public-owner'] !== data.nonce)
    throw new Error('Foreign database container preserved.');
  await execute(
    'docker',
    action === 'stop'
      ? ['container', 'stop', '--time=5', data.container]
      : ['container', 'start', data.container],
    { timeout: 15000 },
  );
  if (action === 'resume') {
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      try {
        const db = await connection('admin');
        await db.end();
        return;
      } catch {
        await setTimeout(100);
      }
    }
    throw new Error('Owned database did not resume.');
  }
}
