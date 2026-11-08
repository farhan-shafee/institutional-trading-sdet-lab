import { Decimal } from 'decimal.js';

const D = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_EVEN });
export const decimal80 = (value: Decimal.Value): Decimal => new D(value);
const absolute = (n: bigint): bigint => (n < 0n ? -n : n);
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

/** Exact finite decimal/fraction arithmetic; rounding occurs only at an explicit output scale. */
export class Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;

  constructor(numerator: bigint, denominator = 1n) {
    if (denominator === 0n) throw new Error('Zero rational denominator.');
    const sign = denominator < 0n ? -1n : 1n;
    const divisor = gcd(absolute(numerator), absolute(denominator));
    this.numerator = (numerator * sign) / divisor;
    this.denominator = absolute(denominator) / divisor;
    Object.freeze(this);
  }

  static decimal(text: string): Rational {
    if (typeof text !== 'string' || text.length > 128 || !/^-?\d+(?:\.\d+)?$/.test(text))
      throw new Error('Expected bounded finite decimal string.');
    const sign = text.startsWith('-') ? -1n : 1n;
    const [whole = '0', fraction = ''] = (sign === -1n ? text.slice(1) : text).split('.');
    return new Rational(sign * BigInt(whole + fraction), 10n ** BigInt(fraction.length));
  }

  add(other: Rational): Rational {
    return new Rational(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }
  sub(other: Rational): Rational {
    return this.add(other.neg());
  }
  mul(other: Rational): Rational {
    return new Rational(this.numerator * other.numerator, this.denominator * other.denominator);
  }
  div(other: Rational): Rational {
    return new Rational(this.numerator * other.denominator, this.denominator * other.numerator);
  }
  neg(): Rational {
    return new Rational(-this.numerator, this.denominator);
  }
  isZero(): boolean {
    return this.numerator === 0n;
  }
  toDecimal(): Decimal {
    return decimal80(this.numerator.toString()).div(this.denominator.toString());
  }

  fixed(places: number): string {
    if (!Number.isInteger(places) || places < 0 || places > 24)
      throw new Error('Unsupported decimal output scale.');
    const scaled = absolute(this.numerator) * 10n ** BigInt(places);
    let units = scaled / this.denominator;
    const twiceRemainder = 2n * (scaled % this.denominator);
    if (
      twiceRemainder > this.denominator ||
      (twiceRemainder === this.denominator && units % 2n !== 0n)
    )
      units++;
    const sign = this.numerator < 0n && units !== 0n ? '-' : '';
    if (places === 0) return sign + units.toString();
    const digits = units.toString().padStart(places + 1, '0');
    return sign + digits.slice(0, -places) + '.' + digits.slice(-places);
  }
}
