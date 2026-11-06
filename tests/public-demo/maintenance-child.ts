import assert from 'node:assert/strict';
import pg from 'pg';
import { PublicDemoMaintenance } from '../../app/server/public-demo/maintenance.js';
import { readConfiguration } from '../../app/server/configuration.js';
import { roleTarget } from './database.js';
import { httpLab } from '../postgres/http.js';

// Pause after a real BEGIN response, leaving the real checked-out socket idle.
// The parent terminates exactly this backend; no fake driver error is emitted.
const originalQuery = Reflect.get<typeof pg.Client.prototype, 'query'>(
  pg.Client.prototype,
  'query',
);
let pause = true;
Object.defineProperty(pg.Client.prototype, 'query', {
  configurable: true,
  writable: true,
  value: function (this: pg.Client, ...args: unknown[]) {
    const result: unknown = Reflect.apply(originalQuery, this, args);
    if (!pause || args[0] !== 'BEGIN' || !(result instanceof Promise)) return result;
    pause = false;
    return result.then(async (value: unknown) => {
      const resumed = new Promise<void>((resolve) => process.once('message', () => resolve()));
      process.send?.({ phase: 'paused' });
      await resumed;
      return value;
    });
  },
});

let now = 0;
const maintenance = new PublicDemoMaintenance(
  { ...(await roleTarget('maintenance')), application_name: process.argv[2] },
  () => now,
);
const app = await httpLab(readConfiguration({ TRADEFLOW_MODE: 'hosted-demo' }));
try {
  await assert.rejects(maintenance.ensure());
  await assert.rejects(maintenance.ensure(), { status: 503 });
  const token = await app.login();
  assert.equal((await app.request('/api/orders', token)).status, 200);
  assert.equal(
    (
      await app.request(
        '/api/fixed-income/v1/analytics?instrument_id=SYN-UST-2031&settlement_date=2026-10-15&par_amount=1000000&yield=0.04',
        token,
      )
    ).status,
    200,
  );
  now = 60_001;
  await maintenance.ensure();
  await maintenance.ensure();
  process.send?.({
    phase: 'verified',
    admission: 503,
    equities: 200,
    analytics: 200,
    recovered: true,
  });
} finally {
  await maintenance.close();
  await app.close();
  process.disconnect?.();
}
