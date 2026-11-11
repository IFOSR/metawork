/** Exact resource quantities; no currency or pricing semantics. */

/** 精确有理数；分母恒为正，约分到最简。零表示为 0/1。 */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export function rational(numerator: bigint, denominator: bigint = 1n): Rational {
  if (denominator === 0n) throw new Error('invalid_quantity');
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const divisor = gcd(n < 0n ? -n : n, d);
  return Object.freeze({ numerator: n / divisor, denominator: d / divisor });
}

export const ZERO_RATIONAL: Rational = rational(0n);

export function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a === 0n ? 1n : a;
}

export function addRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

export function subtractRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

export function multiplyRational(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

export function isZeroRational(value: Rational): boolean {
  return value.numerator === 0n;
}

export function isNegativeRational(value: Rational): boolean {
  return value.numerator < 0n;
}

export function compareRational(left: Rational, right: Rational): number {
  const diff = left.numerator * right.denominator - right.numerator * left.denominator;
  return diff === 0n ? 0 : diff > 0n ? 1 : -1;
}

/** 向下取整到整数单位；非负有理数专用。 */
export function floorRational(value: Rational): bigint {
  if (value.numerator < 0n) throw new Error('invalid_quantity');
  return value.numerator / value.denominator;
}

export function rationalFromDecimalString(text: string, decimals = 0): Rational {
  const trimmed = text.trim();
  const rationalMatch = /^(-?\d+)\/(\d+)$/u.exec(trimmed);
  if (rationalMatch) return rational(BigInt(rationalMatch[1]!), BigInt(rationalMatch[2]!));
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(trimmed);
  if (!match) throw new Error('invalid_decimal_quantity');
  const [, sign, whole, fraction = ''] = match;
  if (decimals > 0 && fraction.length > decimals) throw new Error('quantity_precision_exceeded');
  const scale = 10n ** BigInt(fraction.length);
  const magnitude = BigInt(`${whole}${fraction}`);
  return rational(sign === '-' ? -magnitude : magnitude, scale);
}
