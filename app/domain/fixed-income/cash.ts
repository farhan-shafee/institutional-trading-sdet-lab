/** Exact rational/algebraic cent rounding; numerical PV is only a floor estimate. */
type Ratio = readonly [bigint, bigint];
function ratio(n: bigint, d: bigint): Ratio {
  let a = n < 0n ? -n : n,
    b = d;
  while (b) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return [n / a, d / a];
}
function decimal(text: string): Ratio {
  const [whole = '0', fractional = ''] = text.split('.');
  return ratio(BigInt(whole + fractional), 10n ** BigInt(fractional.length));
}
const add = (a: Ratio, b: Ratio): Ratio => ratio(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const multiply = (a: Ratio, b: Ratio): Ratio => ratio(a[0] * b[0], a[1] * b[1]);
const divide = (a: Ratio, b: Ratio): Ratio => multiply(a, [b[1], b[0]]);
function dollars(cents: bigint): string {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
function roundRatio(value: Ratio): string {
  const [n, d] = value;
  let cents = n / d;
  const twice = 2n * (n % d);
  if (twice > d || (twice === d && cents % 2n !== 0n)) cents++;
  return dollars(cents);
}
export function quoteCash(clean: string, par: string, elapsed: number, period: number): string {
  // P per100 * par/100 dollars *100 cents: the two factors100 cancel.
  return roundRatio(
    multiply(add(decimal(clean), ratio(2n * BigInt(elapsed), BigInt(period))), decimal(par)),
  );
}
export function yieldCash(
  yieldText: string,
  par: string,
  count: number,
  elapsed: number,
  period: number,
  approximateCents: string,
): string {
  const base = add([1n, 1n], divide(decimal(yieldText), [2n, 1n]));
  let sum: Ratio = [0n, 1n],
    discount: Ratio = [1n, 1n];
  for (let k = 0; k < count; k++) {
    sum = add(sum, multiply([k === count - 1 ? 102n : 2n, 1n], discount));
    discount = divide(discount, base);
  }
  const beforeFirstPeriod = multiply(sum, decimal(par));
  const [e, d] = ratio(BigInt(period - elapsed), BigInt(period));
  // cents = beforeFirstPeriod * base^(-e/d). Raise positive quantities
  // to d to compare exactly with integer/half-integer cent boundaries.
  const numerator = beforeFirstPeriod[0] ** d * base[1] ** e;
  const denominator = beforeFirstPeriod[1] ** d * base[0] ** e;
  let floor = BigInt(approximateCents);
  let corrected = false;
  for (let i = 0; i < 4; i++) {
    if (floor ** d * denominator > numerator) {
      floor--;
      continue;
    }
    if ((floor + 1n) ** d * denominator <= numerator) {
      floor++;
      continue;
    }
    corrected = true;
    break;
  }
  if (!corrected) throw new Error('Cash rounding estimate outside exact bound.');
  const midpointPower = (2n * floor + 1n) ** d * denominator;
  const valuePower = numerator * 2n ** d;
  if (valuePower > midpointPower || (valuePower === midpointPower && floor % 2n !== 0n)) floor++;
  return dollars(floor);
}
