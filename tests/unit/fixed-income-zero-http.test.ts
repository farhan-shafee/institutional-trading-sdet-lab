import { once } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationServer } from '../../app/server/index.js';
import { readConfiguration } from '../../app/server/configuration.js';

const query =
  '/api/fixed-income/v2/analytics?instrument_id=SYN-ZERO-2031&settlement_date=2030-01-15&par_amount=1.01&yield=1';

void test('viewer zero-coupon reads require live authorization and logout revokes them', async () => {
  const server = createApplicationServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(base + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'qa.viewer', password: 'Password123!' }),
    });
    assert.equal(login.status, 200);
    const session = (await login.json()) as { token: string; user: { role: string } };
    assert.equal(session.user.role, 'viewer');
    const headers = { Authorization: `Bearer ${session.token}` };
    const read = await fetch(base + query, { headers });
    assert.equal(read.status, 200);
    const body: unknown = await read.json();
    assert.ok(body && typeof body === 'object' && 'consideration_usd' in body);
    assert.equal(body.consideration_usd, '0.50');
    assert.equal((await fetch(base + '/api/session', { method: 'DELETE', headers })).status, 204);
    const revoked = await fetch(base + query, { headers });
    assert.equal(revoked.status, 401);
    assert.deepEqual(await revoked.json(), {
      error: { code: 'UNAUTHORIZED', message: 'A valid synthetic bearer token is required.' },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

void test('zero-coupon reads preserve hosted admission and absolute session expiry', async () => {
  let now = 0;
  const server = createApplicationServer({
    configuration: readConfiguration({
      TRADEFLOW_MODE: 'hosted-demo',
      TRADEFLOW_SESSION_TTL_SECONDS: '1',
      TRADEFLOW_REQUESTS_PER_MINUTE: '3',
    }),
    now: () => now,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(base + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'qa.viewer', password: 'Password123!' }),
    });
    assert.equal(login.status, 200);
    const session = (await login.json()) as { token: string };
    const headers = { Authorization: `Bearer ${session.token}` };
    now = 500;
    const response = await fetch(base + query, { headers });
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as { consideration_usd: string }).consideration_usd,
      '0.50',
    );
    now = 1000;
    assert.equal((await fetch(base + query, { headers })).status, 401);
    assert.equal((await fetch(base + query, { headers })).status, 429);
    assert.equal((await fetch(base + '/health')).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
