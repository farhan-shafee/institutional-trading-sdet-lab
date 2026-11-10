import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { migratePostTrade } from './posttrade-workflow-database.js';
const path = process.env['TF_DB_OWNER_FILE'];
if (!path) throw new Error('An owned private database descriptor is required.');
await migratePostTrade(path);
const available = (await readdir('tests/post-trade'))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => 'tests/post-trade/' + name);
const requested = process.argv.slice(2);
if (
  requested.length > available.length ||
  requested.some((name) => !available.includes(name)) ||
  new Set(requested).size !== requested.length
)
  throw new Error('Select only existing post-trade test files.');
const tests = requested.length ? requested : available;
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
