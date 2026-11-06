import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connection } from './database.js';

await test('real maintenance backend termination preserves the process, denies admission and recovers without false success', async () => {
  const marker = 'public-maintenance-' + randomUUID();
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/public-demo/maintenance-child.ts', marker],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: process.env,
    },
  );
  let output = '';
  child.stdout!.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr!.on('data', (data: Buffer) => {
    output += data.toString();
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  let verified: unknown;
  const paused = new Promise<void>((resolve, reject) => {
    child.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null || !('phase' in message)) return;
      if (message.phase === 'paused') resolve();
      if (message.phase === 'verified') verified = message;
    });
    void exited.then((code) =>
      reject(new Error(`Maintenance child exited ${code} before pause: ${output}`)),
    );
  });
  const admin = await connection('admin');
  try {
    await paused;
    const killed = await admin.query<{ killed: boolean }>(
      "SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE application_name=$1 AND usename='tf_maintenance' AND state='idle in transaction' AND query='BEGIN'",
      [marker],
    );
    assert.deepEqual(killed.rows, [{ killed: true }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (child.connected) child.send('continue');
    assert.equal(await exited, 0, output);
    assert.deepEqual(verified, {
      phase: 'verified',
      admission: 503,
      equities: 200,
      analytics: 200,
      recovered: true,
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    await admin.end();
  }
});
