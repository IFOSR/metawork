import { createHash } from 'node:crypto';
import {
  createPriceBookVersion,
  rationalFromDecimalString,
  type PriceBookVersion,
  type PriceUnitInput,
} from './pricing.js';
import { multiplyRational, rational, type Rational } from './money.js';

export interface BillingModelPriceInput {
  readonly agentClassRef?: string;
  readonly providerRef: string;
  readonly modelId: string;
  /** CNY per one million input tokens. */
  readonly costInputPerMillion?: number;
  /** CNY per one million output tokens. */
  readonly costOutputPerMillion?: number;
}

export interface ConfiguredPriceBookInput {
  readonly configurationRevision: string;
  readonly models: readonly BillingModelPriceInput[];
  readonly markupBps: bigint;
  readonly feePolicyVersion?: string;
  readonly effectiveFrom?: string;
}

/**
 * Converts explicit Model Profile prices into an immutable price book.
 * Missing model prices remain unpriced rather than being inferred from names.
 */
export function buildConfiguredPriceBook(
  input: ConfiguredPriceBookInput,
): PriceBookVersion | null {
  const units: PriceUnitInput[] = [];
  for (const model of input.models) {
    const identity = {
      ...(model.agentClassRef ? { agentClassRef: model.agentClassRef } : {}),
      providerRef: model.providerRef,
      modelId: model.modelId,
    };
    if (model.costInputPerMillion !== undefined) {
      units.push({
        ...identity,
        resource: 'model_tokens',
        metric: 'input',
        nanoCnyPerUnit: nanoCnyPerToken(model.costInputPerMillion),
      });
    }
    if (model.costOutputPerMillion !== undefined) {
      units.push({
        ...identity,
        resource: 'model_tokens',
        metric: 'output',
        nanoCnyPerUnit: nanoCnyPerToken(model.costOutputPerMillion),
      });
    }
  }
  if (units.length === 0) return null;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(units.map(unit => ({
      providerRef: unit.providerRef ?? null,
      modelId: unit.modelId ?? null,
      resource: unit.resource,
      metric: unit.metric,
      numerator: unit.nanoCnyPerUnit.numerator.toString(),
      denominator: unit.nanoCnyPerUnit.denominator.toString(),
    }))))
    .digest('hex')
    .slice(0, 16);
  return createPriceBookVersion({
    priceBookVersion: `config:${input.configurationRevision}`,
    feePolicyVersion: input.feePolicyVersion ?? `model-profile-v1:${fingerprint}`,
    markupBps: input.markupBps,
    effectiveFrom: input.effectiveFrom ?? new Date(0).toISOString(),
    units,
  });
}

function nanoCnyPerToken(cnyPerMillion: number): Rational {
  if (!Number.isFinite(cnyPerMillion) || cnyPerMillion < 0) {
    throw new Error('invalid_model_price');
  }
  return multiplyRational(
    rationalFromDecimalString(String(cnyPerMillion)),
    rational(1000n),
  );
}
