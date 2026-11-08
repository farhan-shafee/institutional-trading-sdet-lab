import { runPostgresVerification, VerificationCancelled } from './test-postgres.js';

try {
  await runPostgresVerification({
    arguments: ['--import', 'tsx', 'scripts/run-financial-finding-demo.ts'],
  });
} catch (error) {
  console.error('Controlled capture proof did not complete; inspect preserved first output.');
  process.exitCode = error instanceof VerificationCancelled ? error.exitCode : 1;
}
