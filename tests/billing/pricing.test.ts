import { describe, expect, it } from 'vitest';
import { rational } from '../../src/billing/money.js';
import {
  costForUsage,
  createPriceBookVersion,
  priceKey,
  rationalFromDecimalString,
  sumCostNanoCny,
  type PriceBookVersionInput,
} from '../../src/billing/pricing.js';

function book(overrides: Partial<PriceBookVersionInput> = {}) {
  return createPriceBookVersion({
    priceBookVersion: 'pb-2026-09-01',
    feePolicyVersion: 'fp-2026-09-01',
    markupBps: 4000n,
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    units: [
      { resource: 'model_tokens', metric: 'input', nanoCnyPerUnit: rational(20_000n, 1_000n) },
      { resource: 'model_tokens', metric: 'output', nanoCnyPerUnit: rational(60_000n, 1_000n) },
      { resource: 'model_tokens', metric: 'cache_read', nanoCnyPerUnit: rational(2n, 1_000n) },
      { resource: 'image', metric: 'image', nanoCnyPerUnit: rational(100_000_000n) },
      { resource: 'compute', metric: 'cpu_second', nanoCnyPerUnit: rational(500n) },
    ],
    ...overrides,
  });
}

describe('createPriceBookVersion', () => {
  it('freezes an immutable version with exact unit prices', () => {
    const created = book();
    expect(created.priceBookVersion).toBe('pb-2026-09-01');
    expect(created.markupBps).toBe(4000n);
    expect(created.units.get('model_tokens:input')?.nanoCnyPerUnit).toEqual(rational(20n));
    expect(Object.isFrozen(created)).toBe(true);
  });

  it('rejects duplicate keys, negative prices and out-of-band markup', () => {
    expect(() => book({
      units: [
        { resource: 'compute', metric: 'cpu_second', nanoCnyPerUnit: rational(1n) },
        { resource: 'compute', metric: 'cpu_second', nanoCnyPerUnit: rational(2n) },
      ],
    })).toThrow('duplicate_price_unit');
    expect(() => book({
      units: [{ resource: 'compute', metric: 'cpu_second', nanoCnyPerUnit: rational(-1n) }],
    })).toThrow('negative_unit_price');
    expect(() => book({
      units: [{ resource: 'search', metric: 'q', sourceCurrency: 'USD', nanoCnyPerUnit: rational(1n) }],
    })).toThrow('missing_exchange_rate:USD');
    expect(() => book({ markupBps: 2999n })).toThrow('invalid_markup');
    expect(() => book({ markupBps: 5001n })).toThrow('invalid_markup');
    expect(() => book({ priceBookVersion: '  ' })).toThrow('invalid_price_book_version');
  });

  it('rejects non-decimal metric keys', () => {
    expect(() => priceKey('compute', '')).toThrow('invalid_metric');
  });
});

describe('costForUsage', () => {
  it('multiplies quantity by unit price as an exact rational', () => {
    const priced = costForUsage(book(), {
      resource: 'model_tokens',
      metric: 'input',
      quantity: rational(1_500n),
    });
    expect(priced?.costNanoCny).toEqual(rational(30_000n));
  });

  it('keeps sub-nanoCny precision for tiny cache reads', () => {
    const priced = costForUsage(book(), {
      resource: 'model_tokens',
      metric: 'cache_read',
      quantity: rational(1n),
    });
    expect(priced?.costNanoCny).toEqual(rational(2n, 1_000n));
  });

  it('returns null instead of zero when no price is published', () => {
    expect(costForUsage(book(), {
      resource: 'search',
      metric: 'request',
      quantity: rational(3n),
    })).toBeNull();
    expect(costForUsage(book(), {
      resource: 'model_tokens',
      metric: 'reasoning',
      quantity: rational(3n),
    })).toBeNull();
  });

  it('applies a pinned exchange rate only for matching foreign currency', () => {
    const withRate = book({
      exchangeRate: {
        sourceCurrency: 'USD',
        nanoCnyPerSourceUnit: rational(7_200_000_000n),
        effectiveFrom: '2026-09-01T00:00:00.000Z',
      },
      units: [
        { resource: 'model_tokens', metric: 'input', nanoCnyPerUnit: rational(20n) },
        { resource: 'search', metric: 'request_usd', sourceCurrency: 'USD', nanoCnyPerUnit: rational(1n, 10n) },
      ],
    });
    const priced = costForUsage(withRate, {
      resource: 'search',
      metric: 'request_usd',
      quantity: rational(1n),
      sourceCurrency: 'USD',
    });
    expect(priced?.costNanoCny).toEqual(rational(720_000_000n));
    expect(() => costForUsage(withRate, {
      resource: 'search',
      metric: 'request_usd',
      quantity: rational(1n),
      sourceCurrency: 'EUR',
    })).toThrow('currency_mismatch:USD');
    expect(() => costForUsage(withRate, {
      resource: 'model_tokens',
      metric: 'input',
      quantity: rational(1n),
      sourceCurrency: 'USD',
    })).toThrow('missing_exchange_rate:USD');
  });

  it('aggregates a mixed stage cost without losing fractions', () => {
    const current = book();
    const costs = [
      costForUsage(current, { resource: 'model_tokens', metric: 'input', quantity: rational(3n) }),
      costForUsage(current, { resource: 'model_tokens', metric: 'cache_read', quantity: rational(5n) }),
      costForUsage(current, { resource: 'compute', metric: 'cpu_second', quantity: rational(1n) }),
    ].map(entry => entry!.costNanoCny);
    expect(sumCostNanoCny(costs)).toEqual(rational(56_001n, 100n));
  });
});

describe('rationalFromDecimalString', () => {
  it('parses decimal strings without float rounding', () => {
    expect(rationalFromDecimalString('0.1')).toEqual(rational(1n, 10n));
    expect(rationalFromDecimalString('123.456')).toEqual(rational(123_456n, 1_000n));
    expect(rationalFromDecimalString('-0.25')).toEqual(rational(-1n, 4n));
  });

  it('rejects malformed or over-precise values', () => {
    expect(() => rationalFromDecimalString('1.0000001', 6)).toThrow('amount_precision_exceeded');
    expect(() => rationalFromDecimalString('nope')).toThrow('invalid_decimal_amount');
  });
});
