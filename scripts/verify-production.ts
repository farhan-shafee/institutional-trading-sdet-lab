import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = await mkdtemp(join(tmpdir(), 'tradeflow-runtime-'));

async function run(args: string[], cwd: string): Promise<void> {
  const child = spawn(process.execPath, args, { cwd, stdio: 'inherit' });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`Production verification child exited ${String(code)} / ${String(signal)}.`),
        );
    });
  });
}

try {
  const npmCli = process.env.npm_execpath;
  assert(npmCli, 'Invoke this verification through npm run smoke:production.');
  for (const name of ['package.json', 'package-lock.json', 'dist']) {
    await cp(join(root, name), join(runtime, name), { recursive: true });
  }
  await run([npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], runtime);
  const installed = JSON.parse(
    await readFile(join(runtime, 'node_modules/.package-lock.json'), 'utf8'),
  ) as {
    packages: Record<string, unknown>;
  };
  assert.deepEqual(
    Object.keys(installed.packages),
    ['node_modules/zod'],
    'Runtime must contain only zod, not development tooling.',
  );
  await run(
    [
      join(root, 'node_modules/tsx/dist/cli.mjs'),
      join(root, 'scripts/smoke-production.ts'),
      join(runtime, 'dist/app/server/index.js'),
    ],
    root,
  );
  console.log('Production-only clean installation and native artifact verification passed.');
} finally {
  assert.equal(dirname(runtime), resolve(tmpdir()));
  assert(basename(runtime).startsWith('tradeflow-runtime-'));
  await rm(runtime, { recursive: true, force: true });
}
