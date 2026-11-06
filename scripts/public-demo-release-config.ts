import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { z } from 'zod';
import { savePrivate, loadPrivate } from './private-state.js';
import { readConfiguration } from '../app/server/configuration.js';

const hostnameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,61}\.railway\.internal$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const roles = ['app', 'migrator', 'reconciler', 'maintenance'] as const;
const databaseKeys = [
  'POSTGRES_USER',
  'POSTGRES_DB',
  'POSTGRES_PASSWORD',
  'TF_DEMO_OWNER_NONCE',
  'TF_DB_DNS',
  ...roles.map((role) => 'TF_' + role.toUpperCase() + '_PASSWORD'),
].sort();
const applicationKeys = [
  'TRADEFLOW_MODE',
  'TRADEFLOW_HOST',
  'TRADEFLOW_PUBLIC_DEMO',
  'TRADEFLOW_PUBLIC_DEMO_DATABASE_URL',
  'TRADEFLOW_PUBLIC_DEMO_RECONCILER_URL',
  'TRADEFLOW_PUBLIC_DEMO_MAINTENANCE_URL',
];
export const releaseConfigurationSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(['PREPARED', 'CA_SUPPLIED']),
    sourceSha: sha,
    sourceTree: sha,
    hostname: hostnameSchema,
    ownerNonce: z.string().regex(/^[a-f0-9]{32}$/),
    database: z.string().regex(/^tradeflow_public_demo_[a-f0-9]{16}$/),
    databaseEnvironment: z.record(z.string(), z.string()),
    applicationEnvironment: z.record(z.string(), z.string()),
  })
  .strict()
  .superRefine((data, ctx) => {
    try {
      const db = data.databaseEnvironment,
        app = data.applicationEnvironment;
      if (JSON.stringify(Object.keys(db).sort()) !== JSON.stringify(databaseKeys))
        throw new Error();
      const appKeys = [
        ...applicationKeys,
        ...(data.phase === 'CA_SUPPLIED' ? ['TRADEFLOW_PUBLIC_DEMO_DATABASE_CA'] : []),
      ].sort();
      if (JSON.stringify(Object.keys(app).sort()) !== JSON.stringify(appKeys)) throw new Error();
      if (
        data.database !== 'tradeflow_public_demo_' + data.ownerNonce.slice(0, 16) ||
        db.POSTGRES_DB !== data.database ||
        db.TF_DEMO_OWNER_NONCE !== data.ownerNonce ||
        db.TF_DB_DNS !== data.hostname ||
        db.POSTGRES_USER !== 'postgres'
      )
        throw new Error();
      const passwords = [
        db.POSTGRES_PASSWORD!,
        ...roles.map((role) => db['TF_' + role.toUpperCase() + '_PASSWORD']!),
      ];
      if (
        passwords.some((password) => !/^[A-Za-z0-9_-]{43}$/.test(password)) ||
        new Set(passwords).size !== 5
      )
        throw new Error();
      for (const [role, setting] of [
        ['app', 'TRADEFLOW_PUBLIC_DEMO_DATABASE_URL'],
        ['reconciler', 'TRADEFLOW_PUBLIC_DEMO_RECONCILER_URL'],
        ['maintenance', 'TRADEFLOW_PUBLIC_DEMO_MAINTENANCE_URL'],
      ] as const) {
        const expected = `postgresql://tf_${role}:${db['TF_' + role.toUpperCase() + '_PASSWORD']}@${data.hostname}:5432/${data.database}`;
        if (app[setting] !== expected) throw new Error();
      }
      if (
        app.TRADEFLOW_MODE !== 'hosted-demo' ||
        app.TRADEFLOW_HOST !== '0.0.0.0' ||
        app.TRADEFLOW_PUBLIC_DEMO !== 'on'
      )
        throw new Error();
      if (data.phase === 'CA_SUPPLIED') readConfiguration(app);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Private release configuration is invalid.' });
    }
  });

export async function preparePublicRelease(
  path: string,
  input: { hostname: string; sourceSha: string; sourceTree: string },
): Promise<void> {
  const args = z
    .object({ hostname: hostnameSchema, sourceSha: sha, sourceTree: sha })
    .strict()
    .parse(input);
  const ownerNonce = randomBytes(16).toString('hex'),
    database = 'tradeflow_public_demo_' + ownerNonce.slice(0, 16);
  const databaseEnvironment: Record<string, string> = {
    POSTGRES_USER: 'postgres',
    POSTGRES_DB: database,
    POSTGRES_PASSWORD: randomBytes(32).toString('base64url'),
    TF_DEMO_OWNER_NONCE: ownerNonce,
    TF_DB_DNS: args.hostname,
  };
  for (const role of roles)
    databaseEnvironment['TF_' + role.toUpperCase() + '_PASSWORD'] =
      randomBytes(32).toString('base64url');
  const applicationEnvironment: Record<string, string> = {
    TRADEFLOW_MODE: 'hosted-demo',
    TRADEFLOW_HOST: '0.0.0.0',
    TRADEFLOW_PUBLIC_DEMO: 'on',
  };
  for (const [role, setting] of [
    ['app', 'TRADEFLOW_PUBLIC_DEMO_DATABASE_URL'],
    ['reconciler', 'TRADEFLOW_PUBLIC_DEMO_RECONCILER_URL'],
    ['maintenance', 'TRADEFLOW_PUBLIC_DEMO_MAINTENANCE_URL'],
  ] as const)
    applicationEnvironment[setting] =
      `postgresql://tf_${role}:${databaseEnvironment['TF_' + role.toUpperCase() + '_PASSWORD']}@${args.hostname}:5432/${database}`;
  await savePrivate(
    path,
    releaseConfigurationSchema.parse({
      version: 1,
      phase: 'PREPARED',
      ...args,
      ownerNonce,
      database,
      databaseEnvironment,
      applicationEnvironment,
    }),
  );
}

export async function bindPublicReleaseCa(
  prepared: string,
  ca: string,
  target: string,
): Promise<void> {
  const data = releaseConfigurationSchema.parse(await loadPrivate(prepared));
  if (data.phase !== 'PREPARED') throw new Error('An original preparation journal is required.');
  await savePrivate(
    target,
    releaseConfigurationSchema.parse({
      ...data,
      phase: 'CA_SUPPLIED',
      applicationEnvironment: {
        ...data.applicationEnvironment,
        TRADEFLOW_PUBLIC_DEMO_DATABASE_CA: ca,
      },
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help')
      console.log(
        'prepare HOSTNAME SOURCE_SHA PRIVATE_PATH; bind-ca PREPARED_PATH PUBLIC_CA_FILE NEW_PRIVATE_PATH. Offline only; no deploy or provider call.',
      );
    else {
      const git = promisify(execFile),
        root = fileURLToPath(new URL('../', import.meta.url));
      const status = await git('git', ['status', '--porcelain'], { cwd: root });
      if (status.stdout.trim()) throw new Error('Clean reviewed source is required.');
      const tree = (await git('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root })).stdout.trim();
      if (args.length === 4 && args[0] === 'prepare') {
        sha.parse(args[2]);
        const expected = (
          await git('git', ['rev-parse', `${args[2]}^{tree}`], { cwd: root })
        ).stdout.trim();
        if (expected !== tree) throw new Error('Reviewed source tree mismatch.');
        await preparePublicRelease(args[3]!, {
          hostname: args[1]!,
          sourceSha: args[2]!,
          sourceTree: tree,
        });
      } else if (args.length === 4 && args[0] === 'bind-ca') {
        const prepared = releaseConfigurationSchema.parse(await loadPrivate(args[1]!));
        if (prepared.sourceTree !== tree) throw new Error('Prepared source tree mismatch.');
        await bindPublicReleaseCa(args[1]!, await readFile(args[2]!, 'utf8'), args[3]!);
      } else throw new Error('Invalid release configuration arguments.');
      console.log(
        'Private release journal created. No provider, database or deployment change occurred.',
      );
    }
  } catch {
    console.error('Public release configuration was not prepared; private inputs omitted.');
    process.exitCode = 1;
  }
}
