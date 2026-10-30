import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { stopOwnedPostgres, type OwnedDescriptor } from '../../scripts/owned-postgres.js';
import { readOwner } from '../../scripts/workflow-database.js';
import { connection } from './harness.js';

for (const phase of ['startup', 'execution'])
  await test(`SIGTERM during supervisor ${phase} removes only its owned instance`, async () => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/postgres/supervisor-worker.ts'],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, TF_SUPERVISOR_CASE: phase },
      },
    );
    let path: string | undefined;
    let remained: boolean;
    try {
      const [message] = (await once(child, 'message')) as [{ phase: string; path: string }];
      assert.equal(message.phase, phase);
      path = message.path;
      const owned = (await readOwner(path)) as OwnedDescriptor;
      assert.equal(existsSync(path), true);
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
      remained = existsSync(path);
      if (!remained && owned.kind === 'docker') {
        const execute = promisify(execFile);
        const containers = await execute('docker', [
          'ps',
          '-a',
          '--filter',
          `label=tradeflow.owner=${owned.nonce}`,
          '--format',
          '{{.Names}}',
        ]);
        const volumes = await execute('docker', [
          'volume',
          'ls',
          '--filter',
          `label=tradeflow.owner=${owned.nonce}`,
          '--format',
          '{{.Name}}',
        ]);
        assert.equal(containers.stdout.trim(), '');
        assert.equal(volumes.stdout.trim(), '');
      } else if (!remained && phase === 'execution') {
        const candidate = new pg.Client({
          connectionString: owned.adminUrl,
          connectionTimeoutMillis: 500,
        });
        let reachable = false;
        try {
          await candidate.connect();
          reachable = true;
        } catch {
          /* The canceled owned server must be gone. */
        } finally {
          await candidate.end();
        }
        assert.equal(reachable, false);
      }
      const parent = await connection('app');
      try {
        assert.equal(
          (await parent.query<{ value: number }>('SELECT 1 AS value')).rows[0]?.value,
          1,
        );
      } finally {
        await parent.end();
      }
    } finally {
      if (path && existsSync(path)) await stopOwnedPostgres(path, true);
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* The owned process group may already be gone. */
      }
    }
    assert.equal(
      remained,
      false,
      'Ordinary cancellation must finish owned-resource cleanup before exiting.',
    );
  });
