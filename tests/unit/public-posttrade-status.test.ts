import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { httpLab } from '../postgres/http.js';
import { readConfiguration } from '../../app/server/configuration.js';

const ssl = {
  ca: readFileSync('test-data/public-demo/test-ca.pem', 'utf8'),
  rejectUnauthorized: true as const,
  servername: 'public-postgres.railway.internal',
};
const target = {
  host: '127.0.0.1',
  port: 1,
  database: 'tradeflow_public_demo_0123456789abcdef',
  password: 'synthetic-offline-password',
  ssl,
};

for (const enabled of [false, true]) {
  await test(`public post-trade status is explicit, authenticated and fail closed (${enabled})`, async () => {
    const lab = await httpLab({
      ...readConfiguration({ TRADEFLOW_MODE: 'hosted-demo', TRADEFLOW_HOST: '127.0.0.1' }),
      publicDemo: {
        app: { ...target, user: 'tf_app' },
        reconciler: { ...target, user: 'tf_reconciler' },
        maintenance: { ...target, user: 'tf_maintenance' },
        ...(enabled ? { postTrade: true as const } : {}),
      },
    });
    try {
      const path = '/api/public-demo/posttrade/status';
      assert.equal((await lab.request(path)).status, 401);
      const token = await lab.login();
      const response = await lab.request(path, token);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        enabled,
        state: enabled ? 'unavailable' : 'disabled',
      });
      assert.equal((await lab.request(path + '?unexpected=1', token)).status, 400);
    } finally {
      await lab.close();
    }
  });
}
