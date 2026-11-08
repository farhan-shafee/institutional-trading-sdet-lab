import { runPostgresVerification, VerificationCancelled } from './test-postgres.js';
try {
  await runPostgresVerification();
  await runPostgresVerification({
    arguments: ['--import', 'tsx', 'scripts/run-posttrade-tests.ts'],
  });
} catch (error) {
  console.error('Owned post-trade verification did not complete; inspect preserved output.');
  process.exitCode = error instanceof VerificationCancelled ? error.exitCode : 1;
}
