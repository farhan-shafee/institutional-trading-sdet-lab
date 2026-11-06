import { X509Certificate } from 'node:crypto';
import type pg from 'pg';

export const publicDemoSettingNames = [
  'TRADEFLOW_PUBLIC_DEMO',
  'TRADEFLOW_PUBLIC_DEMO_DATABASE_URL',
  'TRADEFLOW_PUBLIC_DEMO_RECONCILER_URL',
  'TRADEFLOW_PUBLIC_DEMO_MAINTENANCE_URL',
  'TRADEFLOW_PUBLIC_DEMO_DATABASE_CA',
] as const;

export type DatabaseTarget = string | pg.PoolConfig;
export type PublicDemoConfiguration = {
  app: pg.PoolConfig;
  reconciler: pg.PoolConfig;
  maintenance: pg.PoolConfig;
};

/** Explicit opt-in is separate from the unchanged local workflow configuration. */
export function readPublicDemoConfiguration(
  env: NodeJS.ProcessEnv,
  mode: string,
): PublicDemoConfiguration | undefined {
  const activation = env.TRADEFLOW_PUBLIC_DEMO ?? 'off';
  const supplied = publicDemoSettingNames.slice(1).some((name) => env[name] !== undefined);
  if (activation === 'off' && !supplied) return undefined;
  try {
    if (activation !== 'on' || mode !== 'hosted-demo' || env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
      throw new Error();
    if ((env.TRADEFLOW_FIXED_INCOME_WORKFLOW ?? 'off') !== 'off') throw new Error();
    const ca = env.TRADEFLOW_PUBLIC_DEMO_DATABASE_CA;
    if (!ca || ca.length > 65_536 || ca.includes('PRIVATE KEY')) throw new Error();
    const certificate = new X509Certificate(ca);
    if (
      !certificate.ca ||
      Date.parse(certificate.validFrom) > Date.now() ||
      Date.parse(certificate.validTo) <= Date.now()
    )
      throw new Error();
    const urls = [
      new URL(env.TRADEFLOW_PUBLIC_DEMO_DATABASE_URL ?? ''),
      new URL(env.TRADEFLOW_PUBLIC_DEMO_RECONCILER_URL ?? ''),
      new URL(env.TRADEFLOW_PUBLIC_DEMO_MAINTENANCE_URL ?? ''),
    ];
    const roles = ['tf_app', 'tf_reconciler', 'tf_maintenance'];
    if (new Set(urls.map((url) => decodeURIComponent(url.password))).size !== 3) throw new Error();
    const targets = urls.map((url, index): pg.PoolConfig => {
      const password = decodeURIComponent(url.password);
      if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        !/^[a-z0-9][a-z0-9-]{0,61}\.railway\.internal$/.test(url.hostname) ||
        !/^\/tradeflow_public_demo_[a-f0-9]{16}$/.test(url.pathname) ||
        url.username !== roles[index] ||
        password.length < 16 ||
        password.length > 256 ||
        [...password].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        url.search ||
        url.hash ||
        url.hostname !== urls[0]!.hostname ||
        (url.port || '5432') !== (urls[0]!.port || '5432') ||
        url.pathname !== urls[0]!.pathname
      )
        throw new Error();
      return {
        host: url.hostname,
        port: Number(url.port || '5432'),
        database: url.pathname.slice(1),
        user: url.username,
        password,
        ssl: { ca, rejectUnauthorized: true, servername: url.hostname },
      };
    });
    return { app: targets[0]!, reconciler: targets[1]!, maintenance: targets[2]! };
  } catch {
    // Never include a URL, password, CA input or a low-level parser exception.
    throw new Error(
      'Public demo requires a complete dedicated database profile with verified TLS.',
    );
  }
}

export function databaseConnection(target: DatabaseTarget): pg.PoolConfig {
  return typeof target === 'string' ? { connectionString: target } : target;
}
