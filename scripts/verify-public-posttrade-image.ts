import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { connection, owner, imageMode } from '../tests/public-demo/database.js';
import { verifyPublicProfile } from '../app/server/public-demo/profile.js';
import { validatePublicPostTradeProfileSources } from './validate-public-posttrade-profile.js';

if (!imageMode) throw new Error('A private owned public image descriptor is required.');
await validatePublicPostTradeProfileSources();
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
  await verifyPublicProfile(db, 'posttrade');
} finally {
  await db.end();
}
const tests = (await readdir('tests/public-posttrade'))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => 'tests/public-posttrade/' + name);
tests.push('tests/public-demo/profile.test.ts', 'tests/public-demo/tls.test.ts');
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
    for (const table of [
      'posttrade_books',
      'posttrade_security_balances',
      'posttrade_roots',
      'posttrade_revisions',
      'posttrade_busts',
      'posttrade_settlement_outcomes',
      'posttrade_commands',
      'posttrade_events',
    ])
      assert.equal(
        (await admin.query<{ count: number }>('SELECT count(*)::int AS count FROM fi.' + table))
          .rows[0]!.count,
        0,
        'Public cleanup must remove the complete financial graph: ' + table,
      );
    for (const table of ['command_keys', 'fix_reservations', 'public_demo_sandboxes'])
      assert.equal(
        (
          await admin.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM fi_control.' + table,
          )
        ).rows[0]!.count,
        0,
        'Public cleanup must release control accounting: ' + table,
      );
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
    'Public post-trade PostgreSQL 17.10 image verified: TLS, branded schema, roles and retained capacity zero.',
  );
}
