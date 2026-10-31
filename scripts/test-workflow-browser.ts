import { runPostgresVerification } from './test-postgres.js';

try {
  await runPostgresVerification({
    arguments: [
      '--import',
      'tsx',
      'node_modules/@playwright/test/cli.js',
      'test',
      '--config=playwright.workflow.config.ts',
      ...process.argv.slice(2),
    ],
  });
} catch {
  console.error(
    'Owned RFQ browser verification failed. Sensitive browser evidence capture is disabled.',
  );
  process.exitCode = 1;
}
