import { DomainError } from '../domain/errors.js';
import { analytics, instruments } from '../domain/fixed-income/analytics.js';

/** Called only after ordinary session authentication and global request admission. */
export function fixedIncomeRead(path: string, parameters: URLSearchParams): unknown {
  const root = '/api/fixed-income/v1';
  if (path !== `${root}/instruments` && path !== `${root}/analytics`) return undefined;
  try {
    const query = Object.create(null) as Record<string, string>;
    for (const [key, value] of parameters) {
      if (Object.hasOwn(query, key)) throw new Error('Duplicate query field.');
      query[key] = value;
    }
    if (path.endsWith('/instruments')) {
      if (parameters.size) throw new Error('Catalogue takes no parameters.');
      return { instruments };
    }
    return analytics(query);
  } catch {
    throw new DomainError(
      400,
      'VALIDATION_ERROR',
      'Invalid fixed-income query; check instrument, date, units and supported ranges.',
    );
  }
}
