import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, mock } from 'node:test';
import { runClient } from '../../scripts/sandbox-client.js';
import { readConfiguration } from '../../app/server/configuration.js';
import { owner, connection } from './harness.js';
import { httpLab } from './http.js';

for (const failure of ['file', 'directory'])
  await test(`retry of a complete interrupted journal sends no request when ${failure} durability cannot be established`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tradeflow-sync-'));
    const path = join(dir, 'interrupted.json');
    const id = randomUUID();
    const material = {
      version: 1,
      operation: 'create',
      sandbox_id: id,
      read_capability: randomBytes(32).toString('base64url'),
      trade_capability: randomBytes(32).toString('base64url'),
      idempotency_key: randomUUID(),
    };
    // Deliberately complete JSON without a durability barrier, as left by interrupted preparation.
    await writeFile(path, JSON.stringify(material), { mode: 0o600, flag: 'wx' });
    const handle = await open(path, 'r');
    const prototype = Object.getPrototypeOf(handle) as FileHandle;
    const original = Object.getOwnPropertyDescriptor(prototype, 'sync')
      ?.value as FileHandle['sync'];
    await handle.close();
    const owned = await owner();
    if (!owned.appUrl) throw new Error('Application role required.');
    const lab = await httpLab(
      readConfiguration({
        TRADEFLOW_FIXED_INCOME_WORKFLOW: 'postgres',
        TRADEFLOW_FIXED_INCOME_DATABASE_URL: owned.appUrl,
      }),
    );
    let requests = 0;
    lab.server.on('request', () => {
      requests++;
    });
    const injected = mock.method(prototype, 'sync', async function (this: FileHandle) {
      const directory = (await this.stat()).isDirectory();
      if (directory === (failure === 'directory')) throw new Error('Injected durability failure.');
      await original.call(this);
    });
    try {
      await assert.rejects(runClient('create', path, lab.origin));
      assert.equal(requests, 0);
      injected.mock.restore();
      const result = await runClient('create', path, lab.origin);
      assert.equal(result.confirmed, true);
      assert.equal(result.sandbox_id, id);
    } finally {
      injected.mock.restore();
      await lab.close();
      const admin = await connection('admin');
      const maint = await connection('maintenance');
      try {
        await admin.query(
          "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
          [id],
        );
        await maint.query('SELECT fi_control.purge_expired()');
      } finally {
        await maint.end();
        await admin.end();
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
