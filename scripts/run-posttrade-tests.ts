import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { migratePostTrade } from './posttrade-workflow-database.js';
const path = process.env['TF_DB_OWNER_FILE'];
if (!path) throw new Error('An owned private database descriptor is required.');
await migratePostTrade(path);
const tests = (await readdir('tests/post-trade'))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => 'tests/post-trade/' + name);
if (tests.length === 0) throw new Error('Post-trade tests are required.');
const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-timeout=30000', ...tests],
  { stdio: ['ignore', 'inherit', 'inherit'], env: process.env },
);
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
process.exitCode = await new Promise<number>((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => resolve(code ?? 1));
});
