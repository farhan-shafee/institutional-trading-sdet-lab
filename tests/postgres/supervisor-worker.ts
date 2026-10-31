import { runPostgresVerification, VerificationCancelled } from '../../scripts/test-postgres.js';
void runPostgresVerification({
  arguments: ['--import', 'tsx', 'tests/postgres/supervisor-hold.ts'],
  onPhase: (phase, path) => {
    if (phase === process.env.TF_SUPERVISOR_CASE) process.send?.({ phase, path });
  },
}).catch((error) => {
  process.exitCode = error instanceof VerificationCancelled ? error.exitCode : 1;
});
