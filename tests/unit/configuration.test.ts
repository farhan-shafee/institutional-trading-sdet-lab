import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfiguration } from '../../app/server/configuration.js';

await test('local defaults stay on loopback even with generic hosting environment variables', () => {
  assert.deepEqual(
    readConfiguration({ HOST: '0.0.0.0', HOSTNAME: 'public', NODE_ENV: 'production' }),
    {
      mode: 'local',
      host: '127.0.0.1',
      port: 3000,
    },
  );
  assert.equal(readConfiguration({ PORT: '8080' }).port, 8080);
});

await test('external binding requires exact hosted-demo opt-in with finite mandatory protections', () => {
  assert.throws(() => readConfiguration({ TRADEFLOW_HOST: '0.0.0.0' }), /hosted-demo/);
  assert.throws(() => readConfiguration({ TRADEFLOW_MODE: 'production' }), /TRADEFLOW_MODE/);
  const hosted = readConfiguration({ TRADEFLOW_MODE: 'hosted-demo', PORT: '8080' });
  assert.deepEqual(hosted, {
    mode: 'hosted-demo',
    host: '0.0.0.0',
    port: 8080,
    limits: { ttlMs: 1_800_000, maxSessions: 50, maxOrdersPerSession: 100, mutationsPerMinute: 30 },
    admission: { requestsPerMinute: 600, authPerMinute: 60, mutationsPerMinute: 120 },
  });
  assert.equal(
    readConfiguration({ TRADEFLOW_MODE: 'hosted-demo', TRADEFLOW_HOST: '127.0.0.1' }).host,
    '127.0.0.1',
  );
  for (const host of ['::', 'localhost', '192.168.1.1', '']) {
    assert.throws(() => readConfiguration({ TRADEFLOW_MODE: 'hosted-demo', TRADEFLOW_HOST: host }));
  }
});

await test('invalid ports fail configuration instead of silently choosing a listening address', () => {
  for (const port of ['0', '65536', '-1', '1.5', 'NaN', 'Infinity', '3000x', '']) {
    assert.throws(() => readConfiguration({ PORT: port }), /PORT/);
  }
});

await test('hosted limits have strict finite ranges and cannot accidentally apply to local tests', () => {
  for (const [name, minimum, maximum] of [
    ['TRADEFLOW_SESSION_TTL_SECONDS', 1, 3600],
    ['TRADEFLOW_MAX_SESSIONS', 1, 100],
    ['TRADEFLOW_MAX_ORDERS_PER_SESSION', 5, 200],
    ['TRADEFLOW_REQUESTS_PER_MINUTE', 1, 1200],
    ['TRADEFLOW_AUTH_PER_MINUTE', 1, 120],
    ['TRADEFLOW_MUTATIONS_PER_MINUTE', 1, 240],
    ['TRADEFLOW_SESSION_MUTATIONS_PER_MINUTE', 1, 60],
  ] as const) {
    for (const value of [String(minimum - 1), String(maximum + 1), 'Infinity', '1.5', '']) {
      assert.throws(() => readConfiguration({ TRADEFLOW_MODE: 'hosted-demo', [name]: value }));
    }
    assert.throws(() => readConfiguration({ [name]: String(minimum) }), /hosted-demo/);
    assert.doesNotThrow(() =>
      readConfiguration({ TRADEFLOW_MODE: 'hosted-demo', [name]: String(minimum) }),
    );
    assert.doesNotThrow(() =>
      readConfiguration({ TRADEFLOW_MODE: 'hosted-demo', [name]: String(maximum) }),
    );
  }
});

await test('misspelled namespaced configuration fails without logging supplied values', () => {
  assert.throws(
    () => readConfiguration({ TRADEFLOW_MODE: 'hosted-demo', TRADEFLOW_TTL: 'synthetic-secret' }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('TRADEFLOW_TTL') &&
      !error.message.includes('synthetic-secret'),
  );
});
