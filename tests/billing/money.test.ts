import { describe, expect, it } from 'vitest';
import {
  addRational,
  assessMicroCoin,
  compareRational,
  distributeByWeights,
  formatDecimalUnits,
  multiplyRational,
  parseDecimalUnits,
  rational,
  rationalToNanoCny,
  roundHalfEven,
  roundRationalHalfEven,
  ZERO_RATIONAL,
} from '../../src/billing/money.js';

const ONE_CNY_NANO = 1_000_000_000n;

describe('roundHalfEven', () => {
  it('rounds halves to the even neighbour', () => {
    expect(roundHalfEven(5n, 2n)).toBe(2n);
    expect(roundHalfEven(7n, 2n)).toBe(4n);
    expect(roundHalfEven(1n, 2n)).toBe(0n);
    expect(roundHalfEven(3n, 2n)).toBe(2n);
  });

  it('rounds exact multiples without change', () => {
    expect(roundHalfEven(0n, 3n)).toBe(0n);
    expect(roundHalfEven(12n, 4n)).toBe(3n);
  });

  it('rejects negative numerators and non-positive denominators', () => {
    expect(() => roundHalfEven(-1n, 2n)).toThrow('invalid_amount');
    expect(() => roundHalfEven(1n, 0n)).toThrow('invalid_amount');
    expect(() => roundHalfEven(1n, -2n)).toThrow('invalid_amount');
  });
});

describe('assessMicroCoin', () => {
  it('assesses 1 CNY at the 30/40/50 percent markup band', () => {
    expect(assessMicroCoin(ONE_CNY_NANO, 3000n)).toBe(1_300_000n);
    expect(assessMicroCoin(ONE_CNY_NANO, 4000n)).toBe(1_400_000n);
    expect(assessMicroCoin(ONE_CNY_NANO, 5000n)).toBe(1_500_000n);
  });

  it('keeps zero fee legal', () => {
    expect(assessMicroCoin(0n, 4000n)).toBe(0n);
  });

  it('rounds a single fractional microCoin half-even', () => {
    // 5 nanoCny * 1.4 = 7 nanoCny = 0.007 microCoin -> 0
    expect(assessMicroCoin(5n, 4000n)).toBe(0n);
    // 5000 nanoCny * 1.4 = 7000 nanoCny = 7 microCoin exactly
    expect(assessMicroCoin(5_000n, 4000n)).toBe(7n);
  });

  it('rejects markup outside the published band', () => {
    expect(() => assessMicroCoin(ONE_CNY_NANO, 2999n)).toThrow('invalid_markup');
    expect(() => assessMicroCoin(ONE_CNY_NANO, 5001n)).toThrow('invalid_markup');
    expect(() => assessMicroCoin(ONE_CNY_NANO, 0n)).toThrow('invalid_markup');
    expect(() => assessMicroCoin(ONE_CNY_NANO, -4000n)).toThrow('invalid_markup');
  });

  it('rejects negative cost bases', () => {
    expect(() => assessMicroCoin(-1n, 4000n)).toThrow('invalid_amount');
  });

  it('stays exact for large amounts', () => {
    const huge = 10n ** 24n;
    expect(assessMicroCoin(huge, 5000n)).toBe((huge * 15000n) / 10_000_000n);
  });
});

describe('rational arithmetic', () => {
  it('normalizes sign and reduces to lowest terms', () => {
    expect(rational(2n, 4n)).toEqual({ numerator: 1n, denominator: 2n });
    expect(rational(1n, -2n)).toEqual({ numerator: -1n, denominator: 2n });
    expect(rational(0n, 5n)).toEqual({ numerator: 0n, denominator: 1n });
  });

  it('rejects a zero denominator', () => {
    expect(() => rational(1n, 0n)).toThrow('invalid_amount');
  });

  it('adds, multiplies and compares without float error', () => {
    const third = rational(1n, 3n);
    const sum = addRational(third, third);
    expect(sum).toEqual({ numerator: 2n, denominator: 3n });
    expect(multiplyRational(rational(1n, 10n), rational(3n, 10n)))
      .toEqual({ numerator: 3n, denominator: 100n });
    expect(compareRational(third, rational(1n, 4n))).toBe(1);
    expect(compareRational(rational(1n, 4n), third)).toBe(-1);
    expect(compareRational(third, rational(2n, 6n))).toBe(0);
  });

  it('keeps sub-nanoCny fractions until the Query total', () => {
    const tiny = rational(1n, 3n);
    expect(() => rationalToNanoCny(tiny)).toThrow('amount_precision_below_nanocny');
    const accumulated = addRational(addRational(tiny, tiny), tiny);
    expect(rationalToNanoCny(accumulated)).toBe(1n);
  });

  it('rounds rationals half-even', () => {
    expect(roundRationalHalfEven(rational(5n, 2n))).toBe(2n);
    expect(roundRationalHalfEven(rational(7n, 2n))).toBe(4n);
    expect(roundRationalHalfEven(ZERO_RATIONAL)).toBe(0n);
    expect(() => roundRationalHalfEven(rational(-1n, 2n))).toThrow('invalid_amount');
  });
});

describe('decimal string transport', () => {
  it('round-trips microCoin and nanoCny without precision loss', () => {
    const micro = '1234567.890123';
    expect(formatDecimalUnits(parseDecimalUnits(micro, 6), 6)).toBe(micro);
    const nano = '999999999999.000000001';
    expect(formatDecimalUnits(parseDecimalUnits(nano, 9), 9)).toBe(nano);
  });

  it('accepts integers and rejects over-precision instead of truncating', () => {
    expect(parseDecimalUnits('42', 6)).toBe(42_000_000n);
    expect(() => parseDecimalUnits('1.0000001', 6)).toThrow('amount_precision_exceeded');
    expect(() => parseDecimalUnits('abc', 6)).toThrow('invalid_decimal_amount');
  });

  it('survives JSON round-trip as strings, never numbers', () => {
    const original = 10n ** 25n + 7n;
    const payload = JSON.stringify({ amountMicroCoin: formatDecimalUnits(original, 6) });
    const parsed = JSON.parse(payload) as { amountMicroCoin: string };
    expect(parseDecimalUnits(parsed.amountMicroCoin, 6)).toBe(original);
  });
});

describe('distributeByWeights', () => {
  it('distributes the finalized total so detail sums exactly', () => {
    const distributed = distributeByWeights(1_400_000n, [
      { id: 'planning', weight: rational(1n, 2n) },
      { id: 'execution', weight: rational(1n, 3n) },
      { id: 'verification', weight: rational(1n, 6n) },
    ]);
    expect(distributed.reduce((sum, row) => sum + row.amount, 0n)).toBe(1_400_000n);
    expect(distributed).toEqual([
      { id: 'execution', amount: 466_667n },
      { id: 'planning', amount: 700_000n },
      { id: 'verification', amount: 233_333n },
    ]);
  });

  it('breaks ties deterministically by stable id ordering', () => {
    const distributed = distributeByWeights(3n, [
      { id: 'b', weight: rational(1n) },
      { id: 'a', weight: rational(1n) },
      { id: 'c', weight: rational(1n) },
    ]);
    expect(distributed).toEqual([
      { id: 'a', amount: 1n },
      { id: 'b', amount: 1n },
      { id: 'c', amount: 1n },
    ]);
    const uneven = distributeByWeights(4n, [
      { id: 'c', weight: rational(1n) },
      { id: 'b', weight: rational(1n) },
      { id: 'a', weight: rational(1n) },
    ]);
    expect(uneven).toEqual([
      { id: 'a', amount: 2n },
      { id: 'b', amount: 1n },
      { id: 'c', amount: 1n },
    ]);
  });

  it('handles a single zero-weight stage and rejects impossible inputs', () => {
    expect(distributeByWeights(10n, [
      { id: 'planning', weight: rational(1n) },
      { id: 'context', weight: ZERO_RATIONAL },
    ])).toEqual([
      { id: 'context', amount: 0n },
      { id: 'planning', amount: 10n },
    ]);
    expect(() => distributeByWeights(1n, [])).toThrow('distribution_without_weights');
    expect(() => distributeByWeights(1n, [{ id: 'a', weight: ZERO_RATIONAL }]))
      .toThrow('distribution_without_weights');
    expect(() => distributeByWeights(-1n, [{ id: 'a', weight: rational(1n) }]))
      .toThrow('invalid_amount');
  });
});
