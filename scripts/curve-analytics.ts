import { readSync } from 'node:fs';
import {
  curveAnalytics,
  NumericalAmbiguityError,
} from '../app/domain/fixed-income-v3/analytics.js';

try {
  const input = Buffer.alloc(16385);
  let used = 0;
  while (used < input.length) {
    const count = readSync(0, input, used, input.length - used, null);
    if (count === 0) break;
    used += count;
  }
  if (used > 16384) throw new Error('Curve CLI input limit.');
  const request: unknown = JSON.parse(input.toString('utf8', 0, used));
  process.stdout.write(JSON.stringify(curveAnalytics(request), null, 2) + '\n');
} catch (error) {
  const ambiguous = error instanceof NumericalAmbiguityError;
  process.stderr.write(
    JSON.stringify({
      error: {
        code: ambiguous ? 'NUMERICAL_AMBIGUITY' : 'VALIDATION_ERROR',
        message: ambiguous
          ? 'Curve mark falls on an unresolved numerical rounding boundary.'
          : 'Invalid curve request.',
      },
    }) + '\n',
  );
  process.exitCode = 1;
}
