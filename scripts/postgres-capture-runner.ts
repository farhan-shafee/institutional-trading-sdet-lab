import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runPostgresVerification, VerificationCancelled } from './test-postgres.js';

/** Same discovery and limits as the immutable supervisor, with one test-only preload. */
export async function postgresCaptureArguments(selection: string[] = []): Promise<string[]> {
  const files = (await readdir('tests/postgres'))
    .filter((name) => name.endsWith('.test.ts'))
    .sort();
  if (
    new Set(selection).size !== selection.length ||
    selection.some((name) => !files.includes(name))
  )
    throw new Error('Unknown or duplicate original PostgreSQL test selection.');
  return [
    '--import',
    'tsx',
    '--import',
    './scripts/financial-finding-preload.ts',
    '--test',
    '--test-concurrency=1',
    '--test-timeout=30000',
    ...(selection.length ? files.filter((file) => selection.includes(file)) : files).map(
      (file) => 'tests/postgres/' + file,
    ),
  ];
}

export async function runCapturedPostgresVerification(selection: string[] = []): Promise<void> {
  await runPostgresVerification({ arguments: await postgresCaptureArguments(selection) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCapturedPostgresVerification(process.argv.slice(2));
  } catch (error) {
    console.error('Original PostgreSQL verification did not complete; inspect preserved output.');
    process.exitCode = error instanceof VerificationCancelled ? error.exitCode : 1;
  }
}
