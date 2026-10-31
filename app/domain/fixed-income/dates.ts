/** Strict Gregorian calendar arithmetic; accrual dates are unadjusted, in UTC. */
export function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2100-12-31')
    throw new Error('Date must be a Gregorian YYYY-MM-DD between 1900 and 2100.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new Error('Invalid calendar date.');
  return date;
}
export function actualDays(start: string, end: string): number {
  return (parseDate(end).getTime() - parseDate(start).getTime()) / 86_400_000;
}
function lastDay(date: Date): number {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}
/** US/NASD 30/360: February EOM and conditional 31st adjustments. */
export function dayCountUS(start: string, end: string): number {
  const a = parseDate(start),
    b = parseDate(end);
  let d1 = a.getUTCDate(),
    d2 = b.getUTCDate();
  const feb1 = a.getUTCMonth() === 1 && d1 === lastDay(a);
  const feb2 = b.getUTCMonth() === 1 && d2 === lastDay(b);
  if (feb1 && feb2) d2 = 30;
  if (feb1 || d1 === 31) d1 = 30;
  if (d2 === 31 && d1 >= 30) d2 = 30;
  return (
    360 * (b.getUTCFullYear() - a.getUTCFullYear()) +
    30 * (b.getUTCMonth() - a.getUTCMonth()) +
    d2 -
    d1
  );
}
/** Backward generation anchored to maturity; EOM maturity preserves EOM. No stubs. */
export function couponDates(dated: string, maturity: string): string[] {
  const origin = parseDate(maturity);
  parseDate(dated);
  if (dated >= maturity) throw new Error('Maturity must follow dated date.');
  const dates: string[] = [];
  const eom = origin.getUTCDate() === lastDay(origin);
  for (let periods = 0; periods <= 402; periods++) {
    const month = new Date(
      Date.UTC(origin.getUTCFullYear(), origin.getUTCMonth() - 6 * periods, 1),
    );
    const day = eom ? lastDay(month) : Math.min(origin.getUTCDate(), lastDay(month));
    month.setUTCDate(day);
    const value = month.toISOString().slice(0, 10);
    if (value === dated) return dates.reverse();
    if (value < dated) throw new Error('Irregular first coupon periods are unsupported.');
    dates.push(value);
  }
  throw new Error('Coupon schedule exceeds supported range.');
}
