import { runPostgresVerification, VerificationCancelled } from './test-postgres.js';

// A rehearsal entry point, not an application server or a production deployment tool.
const args = process.argv.slice(2);
class InterviewUsageError extends Error {}
try {
  if (args.length !== 1 || !['--verify', '--manual', '--help'].includes(args[0]!))
    throw new InterviewUsageError(
      'Use --verify, --manual or --help; no external target is accepted.',
    );
  if (args[0] === '--help') {
    console.log(
      'TradeFlow interview: --verify runs one owned PostgreSQL/Chromium rehearsal; --manual opens the same journey in Playwright Inspector. Resume each checkpoint, then finish for cleanup. No production target, browser state export or secret-bearing trace is supported.',
    );
  } else {
    const manual = args[0] === '--manual';
    if (manual && process.env.CI)
      throw new InterviewUsageError('Interactive interview mode is unavailable in CI.');
    if (!manual && (process.env.PWDEBUG || process.env.TF_INTERVIEW_MANUAL))
      throw new InterviewUsageError(
        'Unset PWDEBUG and TF_INTERVIEW_MANUAL for bounded verification.',
      );
    if (
      manual &&
      process.platform !== 'win32' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
    )
      throw new InterviewUsageError(
        'Interactive mode needs a graphical desktop; use --verify for headless evidence.',
      );
    if (manual) {
      process.env.TF_INTERVIEW_MANUAL = '1';
      process.env.PWDEBUG = '1';
    }
    await runPostgresVerification({
      arguments: [
        '--import',
        'tsx',
        'node_modules/@playwright/test/cli.js',
        'test',
        '--config=playwright.interview.config.ts',
      ],
    });
  }
} catch (error) {
  // Only fixed local preflight messages are shown; database/driver exceptions stay private.
  const safe = error instanceof InterviewUsageError;
  console.error(
    safe ? error.message : 'Owned interview rehearsal did not complete. Private material omitted.',
  );
  process.exitCode = error instanceof VerificationCancelled ? error.exitCode : 1;
}
