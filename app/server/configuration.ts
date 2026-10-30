import type { SessionLimits } from '../domain/session-store.js';

type Address = '127.0.0.1' | '0.0.0.0';
type BaseConfiguration =
  | { mode: 'local'; host: '127.0.0.1'; port: number }
  | {
      mode: 'hosted-demo';
      host: Address;
      port: number;
      limits: SessionLimits;
      admission: { requestsPerMinute: number; authPerMinute: number; mutationsPerMinute: number };
    };
export type ApplicationConfiguration = BaseConfiguration & {
  workflow?: { databaseUrl: string; reconcilerUrl?: string };
};

export class ConfigurationError extends Error {}

const limits = {
  TRADEFLOW_SESSION_TTL_SECONDS: [1800, 1, 3600],
  TRADEFLOW_MAX_SESSIONS: [50, 1, 100],
  TRADEFLOW_MAX_ORDERS_PER_SESSION: [100, 5, 200],
  TRADEFLOW_REQUESTS_PER_MINUTE: [600, 1, 1200],
  TRADEFLOW_AUTH_PER_MINUTE: [60, 1, 120],
  TRADEFLOW_MUTATIONS_PER_MINUTE: [120, 1, 240],
  TRADEFLOW_SESSION_MUTATIONS_PER_MINUTE: [30, 1, 60],
} as const;

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const text = env[name] ?? String(fallback);
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/** Only this explicit profile enables external binding and its inseparable demo protections. */
export function readConfiguration(env: NodeJS.ProcessEnv = process.env): ApplicationConfiguration {
  const names = new Set([
    'TRADEFLOW_MODE',
    'TRADEFLOW_HOST',
    'TRADEFLOW_FIXED_INCOME_WORKFLOW',
    'TRADEFLOW_FIXED_INCOME_DATABASE_URL',
    'TRADEFLOW_FIXED_INCOME_RECONCILER_URL',
    ...Object.keys(limits),
  ]);
  for (const name of Object.keys(env)) {
    if (name.startsWith('TRADEFLOW_') && !names.has(name)) {
      throw new ConfigurationError(`Unknown TradeFlow setting: ${name}.`);
    }
  }
  const mode = env.TRADEFLOW_MODE ?? 'local';
  if (mode !== 'local' && mode !== 'hosted-demo') {
    throw new ConfigurationError('TRADEFLOW_MODE must be local or hosted-demo.');
  }
  const host = env.TRADEFLOW_HOST ?? (mode === 'local' ? '127.0.0.1' : '0.0.0.0');
  if (host !== '127.0.0.1' && host !== '0.0.0.0') {
    throw new ConfigurationError('TRADEFLOW_HOST must be 127.0.0.1 or 0.0.0.0.');
  }
  const port = integer(env, 'PORT', 3000, 1, 65535);
  const workflowMode = env.TRADEFLOW_FIXED_INCOME_WORKFLOW ?? 'off';
  if (workflowMode !== 'off' && workflowMode !== 'postgres') {
    throw new ConfigurationError('Fixed-income workflow must be off or postgres.');
  }
  let workflow: { databaseUrl: string; reconcilerUrl?: string } | undefined;
  if (workflowMode === 'postgres') {
    try {
      const databaseUrl = env.TRADEFLOW_FIXED_INCOME_DATABASE_URL;
      const url = new URL(databaseUrl ?? '');
      if (
        mode !== 'local' ||
        host !== '127.0.0.1' ||
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        url.hostname !== '127.0.0.1' ||
        url.username !== 'tf_app' ||
        !/^\/tradeflow_(local|ci)_[a-f0-9]{16}$/.test(url.pathname) ||
        url.search ||
        url.hash ||
        !databaseUrl
      )
        throw new Error('Invalid workflow target');
      const reconcilerUrl = env.TRADEFLOW_FIXED_INCOME_RECONCILER_URL;
      if (reconcilerUrl !== undefined) {
        const reader = new URL(reconcilerUrl);
        if (
          !['postgres:', 'postgresql:'].includes(reader.protocol) ||
          reader.hostname !== url.hostname ||
          reader.port !== url.port ||
          reader.pathname !== url.pathname ||
          reader.username !== 'tf_reconciler' ||
          !reader.password ||
          reader.search ||
          reader.hash
        )
          throw new Error('Invalid reconciliation target');
      }
      workflow = { databaseUrl, ...(reconcilerUrl ? { reconcilerUrl } : {}) };
    } catch {
      throw new ConfigurationError(
        'PostgreSQL workflow requires local mode and an owned loopback database using tf_app.',
      );
    }
  }
  if (mode === 'local') {
    if (host !== '127.0.0.1' || Object.keys(limits).some((name) => env[name] !== undefined)) {
      throw new ConfigurationError(
        'External binding and resource settings require hosted-demo mode.',
      );
    }
    return { mode, host, port, ...(workflow ? { workflow } : {}) };
  }
  const limit = (name: keyof typeof limits) => {
    const [fallback, minimum, maximum] = limits[name];
    return integer(env, name, fallback, minimum, maximum);
  };
  return {
    mode,
    host,
    port,
    limits: {
      ttlMs: limit('TRADEFLOW_SESSION_TTL_SECONDS') * 1000,
      maxSessions: limit('TRADEFLOW_MAX_SESSIONS'),
      maxOrdersPerSession: limit('TRADEFLOW_MAX_ORDERS_PER_SESSION'),
      mutationsPerMinute: limit('TRADEFLOW_SESSION_MUTATIONS_PER_MINUTE'),
    },
    admission: {
      requestsPerMinute: limit('TRADEFLOW_REQUESTS_PER_MINUTE'),
      authPerMinute: limit('TRADEFLOW_AUTH_PER_MINUTE'),
      mutationsPerMinute: limit('TRADEFLOW_MUTATIONS_PER_MINUTE'),
    },
  };
}
