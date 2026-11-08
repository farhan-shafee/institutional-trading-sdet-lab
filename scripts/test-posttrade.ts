import { runPostgresVerification, VerificationCancelled } from './test-postgres.js';
import { runCapturedPostgresVerification } from './postgres-capture-runner.js';
try {
  await runCapturedPostgresVerification();
  await runPostgresVerification({
    arguments: ['--import', 'tsx', 'scripts/run-posttrade-tests.ts'],
  });
} catch (error) {
  console.error('Owned post-trade verification did not complete; inspect preserved output.');
  process.exitCode = error instanceof VerificationCancelled ? error.exitCode : 1;
}
