import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
import { ordersResponseSchema, sessionResponseSchema } from '../app/domain/schemas.js';
import { createApplicationServer } from '../app/server/index.js';

// A local smoke only: small fixed sample, no external systems or market data.
const requestCount = 120;
const concurrency = 4;
const p95LimitMs = 250;
const server = createApplicationServer();
let baseURL: string | undefined;
let token: string | undefined;

try {
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Server has no loopback TCP address.');
  baseURL = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseURL}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'qa.user', password: 'Password123!' }),
    signal: AbortSignal.timeout(5_000),
  });
  if (login.status !== 200) throw new Error(`Login returned ${login.status}`);
  token = sessionResponseSchema.parse(await login.json()).token;
  const headers = { Authorization: `Bearer ${token}` };
  for (let i = 0; i < 10; i++) {
    const response = await fetch(`${baseURL}/api/orders`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status !== 200) throw new Error(`Warm-up returned ${response.status}`);
    ordersResponseSchema.parse(await response.json());
  }

  const latencies: number[] = [];
  let errors = 0;
  let issued = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (issued < requestCount) {
        issued++;
        const start = performance.now();
        try {
          const response = await fetch(`${baseURL}/api/orders`, {
            headers,
            signal: AbortSignal.timeout(5_000),
          });
          if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
          ordersResponseSchema.parse(await response.json());
        } catch {
          errors++;
        }
        latencies.push(performance.now() - start);
      }
    }),
  );
  const durationMs = performance.now() - started;
  latencies.sort((a, b) => a - b);
  const p95Ms = latencies[Math.ceil(latencies.length * 0.95) - 1] ?? Infinity;
  console.log(
    JSON.stringify(
      {
        synthetic: true,
        requests: issued,
        concurrency,
        errors,
        p95Ms: Number(p95Ms.toFixed(2)),
        durationMs: Number(durationMs.toFixed(2)),
        requestsPerSecond: Number((issued / (durationMs / 1000)).toFixed(2)),
        p95LimitMs,
      },
      null,
      2,
    ),
  );
  if (issued !== requestCount || errors !== 0 || p95Ms >= p95LimitMs) {
    throw new Error(
      'Local performance smoke failed. Investigate environment and API evidence; do not treat this as enterprise load capacity.',
    );
  }
} finally {
  try {
    if (token && baseURL) {
      const response = await fetch(`${baseURL}/api/session`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status !== 204) {
        console.error(`Session cleanup returned ${response.status}`);
        process.exitCode = 1;
      }
    }
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
    }
  }
}
