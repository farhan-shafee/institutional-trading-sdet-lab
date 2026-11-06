import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { installOwnedPublicProfile } from './public-demo-profile.js';

// Invoked only inside the existing owned PostgreSQL supervisor, never a production target.
const descriptor = process.env.TF_DB_OWNER_FILE;
if (!descriptor) throw new Error('Public candidate verification requires owned PostgreSQL.');
await installOwnedPublicProfile(descriptor);
const tests = (await readdir('tests/public-demo'))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => 'tests/public-demo/' + name);
const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-timeout=30000', ...tests],
  { stdio: 'inherit', env: process.env },
);
process.exitCode = await new Promise<number>((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => resolve(code ?? 1));
});
