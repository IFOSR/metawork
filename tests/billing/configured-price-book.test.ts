import { describe, expect, it } from 'vitest';
import {
  buildConfiguredPriceBook,
  type BillingModelPriceInput,
} from '../../src/billing/configured-price-book.js';
import { costForUsage, findPriceUnit } from '../../src/billing/pricing.js';
import { rational } from '../../src/billing/money.js';

const models: BillingModelPriceInput[] = [
  {
    providerRef: 'deepseek',
    modelId: 'deepseek-flash',
    costInputPerMillion: 1,
    costOutputPerMillion: 2,
  },
];

describe('configured billing price book', () => {
  it('converts configured per-million model prices into exact per-token prices', () => {
    const book = buildConfiguredPriceBook({
      configurationRevision: 'revision-test',
      models,
      markupBps: 4000n,
    });

    expect(book?.priceBookVersion).toBe('config:revision-test');
    expect(book?.units.get('model_tokens:input|provider=deepseek|model=deepseek-flash'))
      ?.toMatchObject({ nanoCnyPerUnit: rational(1000n) });
    expect(book?.units.get('model_tokens:output|provider=deepseek|model=deepseek-flash'))
      ?.toMatchObject({ nanoCnyPerUnit: rational(2000n) });
  });

  it('does not create a price book when no model has trusted prices', () => {
    expect(buildConfiguredPriceBook({
      configurationRevision: 'revision-test',
      models: [{ providerRef: 'deepseek', modelId: 'deepseek-flash' }],
      markupBps: 4000n,
    })).toBeNull();
  });

  it('prices observations by model identity instead of using one global rate', () => {
    const book = buildConfiguredPriceBook({
      configurationRevision: 'revision-test',
      models: [
        ...models,
        {
          providerRef: 'code-cli',
          modelId: 'gpt-5.6-sol',
          costInputPerMillion: 10,
          costOutputPerMillion: 20,
        },
      ],
      markupBps: 4000n,
    })!;

    expect(findPriceUnit(book, {
      resource: 'model_tokens',
      metric: 'input',
      providerRef: 'code-cli',
      modelId: 'gpt-5.6-sol',
    })?.nanoCnyPerUnit).toEqual(rational(10_000n));
    expect(costForUsage(book, {
      resource: 'model_tokens',
      metric: 'input',
      quantity: rational(1000n),
      providerRef: 'code-cli',
      modelId: 'gpt-5.6-sol',
    })?.costNanoCny).toEqual(rational(10_000_000n));
  });
});
