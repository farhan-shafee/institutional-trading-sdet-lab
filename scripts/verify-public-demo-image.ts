import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { connection, owner, imageMode } from '../tests/public-demo/database.js';
import { verifyPublicProfile } from '../app/server/public-demo/profile.js';

if (!imageMode) throw new Error('A private owned public image descriptor is required.');
const owned = await owner();
const db = await connection('app');
try {
  assert.equal(
    (await db.query<{ version: string }>("SELECT current_setting('server_version_num') AS version"))
      .rows[0]!.version,
    '170010',
  );
  assert.equal(
    (await db.query<{ ssl: boolean }>('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'))
      .rows[0]!.ssl,
    true,
  );
  assert.equal(
    (
      await db.query<{ marker: string }>(
        "SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
      )
    ).rows[0]!.marker,
    `TradeFlow public demo owner ${owned.nonce}`,
  );
  await verifyPublicProfile(db);
} finally {
  await db.end();
}
const tests = (await readdir('tests/public-demo'))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => 'tests/public-demo/' + name);
const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-timeout=30000', ...tests],
  { stdio: 'inherit', env: process.env },
);
const code = await new Promise<number>((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (value) => resolve(value ?? 1));
});
if (code !== 0) process.exitCode = code;
else {
  const admin = await connection('admin');
  try {
    assert.equal(
      (
        await admin.query<{ clean: boolean }>(
          'SELECT retained_count=0 AND (SELECT count(*) FROM fi.sandboxes)=0 AS clean FROM fi_control.service_capacity',
        )
      ).rows[0]!.clean,
      true,
    );
  } finally {
    await admin.end();
  }
  console.log(
    'Public PostgreSQL 17.10 image verified: TLS, branded schema, roles and retained capacity zero.',
  );
}
