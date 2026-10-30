import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

export type Owner = {
  version: number;
  nonce: string;
  adminUrl: string;
  appUrl?: string;
  migratorUrl?: string;
  reconcilerUrl?: string;
  maintenanceUrl?: string;
};

export async function owner(): Promise<Owner> {
  const path = process.env.TF_DB_OWNER_FILE;
  if (!path) throw new Error('Real PostgreSQL tests require an owned private descriptor.');
  return JSON.parse(await readFile(resolve(path), 'utf8')) as Owner;
}

export async function connection(
  role: 'admin' | 'app' | 'migrator' | 'reconciler' | 'maintenance',
) {
  const config = await owner();
  const url = config[`${role}Url` as keyof Owner];
  if (typeof url !== 'string') throw new Error('Required database role was not provisioned.');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

export async function scalar(client: pg.Client, sql: string): Promise<unknown> {
  const result = await client.query<Record<string, unknown>>(sql);
  return Object.values(result.rows[0] ?? {})[0];
}
