import { once } from 'node:events';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApplicationServer } from '../../app/server/index.js';
import { readConfiguration } from '../../app/server/configuration.js';

void test('hosted analytics retains global admission and absolute session expiry', async () => {
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
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(url + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'qa.viewer', password: 'Password123!' }),
    });
    assert.equal(login.status, 200);
    const body = (await login.json()) as { token: string };
    const headers = { Authorization: `Bearer ${body.token}` };
    now = 500;
    const result = await fetch(
      url +
        '/api/fixed-income/v1/analytics?instrument_id=SYN-UST-2031&settlement_date=2026-10-15&par_amount=1&yield=0.04',
      { headers },
    );
    assert.equal(result.status, 200);
    now = 1000;
    assert.equal((await fetch(url + '/api/fixed-income/v1/instruments', { headers })).status, 401);
    assert.equal((await fetch(url + '/api/fixed-income/v1/instruments', { headers })).status, 429);
    assert.equal((await fetch(url + '/health')).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
