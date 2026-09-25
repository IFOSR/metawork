import { describe, expect, it } from 'vitest';
import {
  isChargeableCoverage,
  mergeCoverage,
  projectCoverage,
} from '../../src/metering/coverage-projector.js';
import {
  exactQuantityFromRational,
  type UsageObservation,
} from '../../src/metering/contracts.js';
import { rational } from '../../src/billing/money.js';

function observation(overrides: Partial<UsageObservation> = {}): UsageObservation {
  return {
    observationId: 'obs-1',
    sourceId: 'planner',
    sourceEventKey: 'evt-1',
    sourceScope: 'model_request',
    callId: 'call-1',
    queryId: 'query-1',
    executionSegmentId: null,
    taskId: null,
    stage: 'planning',
    reason: 'primary',
    resource: 'model_tokens',
    metric: 'input',
    unit: 'token',
    quantity: exactQuantityFromRational(rational(100n)),
    quality: 'reported',
    countsTowardTotal: true,
    payer: 'platform',
    capturedAt: '2026-09-21T10:00:00.000Z',
    providerBindingVersion: null,
    evidenceRef: null,
    normalizationRuleVersion: 'usage-normalizer-v1',
    ...overrides,
  };
}

const EXPECTED = [
  { resource: 'model_tokens' as const, metric: 'input' },
  { resource: 'model_tokens' as const, metric: 'output' },
];

describe('projectCoverage', () => {
  it('reports complete coverage only when every category is trusted', () => {
    const report = projectCoverage({
      observations: [
        observation(),
        observation({ observationId: 'obs-2', metric: 'output' }),
      ],
      expected: EXPECTED,
    });
    expect(report.coverage).toBe('complete');
    expect(report.quality).toBe('reported');
    expect(report.missingCount).toBe(0);
    expect(isChargeableCoverage(report)).toBe(true);
  });

  it('reports a missing category instead of a zero', () => {
    const report = projectCoverage({ observations: [observation()], expected: EXPECTED });
    expect(report.coverage).toBe('incomplete');
    expect(report.missingCategories).toEqual(['model_tokens:output']);
    expect(report.missingCount).toBe(1);
    expect(isChargeableCoverage(report)).toBe(false);
  });

  it('separates unavailable measurements from never-collected ones', () => {
    const report = projectCoverage({
      observations: [
        observation(),
        observation({
          observationId: 'obs-3',
          metric: 'output',
          quality: 'unavailable',
          countsTowardTotal: false,
        }),
      ],
      expected: EXPECTED,
    });
    expect(report.unavailableCategories).toEqual(['model_tokens:output']);
    expect(report.missingCategories).toEqual([]);
    expect(report.coverage).toBe('incomplete');
    expect(report.quality).toBe('estimated');
  });

  it('marks estimated coverage as partial, not chargeable by default', () => {
    const report = projectCoverage({
      observations: [
        observation({ quality: 'estimated' }),
        observation({ observationId: 'obs-2', metric: 'output' }),
      ],
      expected: EXPECTED,
    });
    expect(report.coverage).toBe('partial');
    expect(report.estimatedCategories).toEqual(['model_tokens:input']);
    expect(isChargeableCoverage(report)).toBe(false);
  });

  it('is unavailable when nothing at all was measured', () => {
    const report = projectCoverage({ observations: [], expected: EXPECTED });
    expect(report.quality).toBe('unavailable');
    expect(report.coverage).toBe('incomplete');
    expect(report.observedCount).toBe(0);
  });

  it('does not invent missing categories when no expectation was declared', () => {
    const report = projectCoverage({ observations: [observation()], expected: [] });
    expect(report.coverage).toBe('complete');
    expect(report.missingCount).toBe(0);
    expect(report.observedCategories).toEqual(['model_tokens:input']);
  });
});

describe('mergeCoverage', () => {
  it('takes the most conservative conclusion across segments', () => {
    const complete = projectCoverage({
      observations: [observation(), observation({ observationId: 'obs-2', metric: 'output' })],
      expected: EXPECTED,
    });
    const incomplete = projectCoverage({ observations: [observation()], expected: EXPECTED });
    const merged = mergeCoverage([complete, incomplete]);
    expect(merged.coverage).toBe('incomplete');
    expect(merged.missingCategories).toEqual(['model_tokens:output']);
    expect(merged.observedCategories).toEqual(['model_tokens:input', 'model_tokens:output']);
    expect(isChargeableCoverage(merged)).toBe(false);
  });

  it('reports an explicit unavailable state for an empty set', () => {
    const merged = mergeCoverage([]);
    expect(merged.quality).toBe('unavailable');
    expect(merged.coverage).toBe('incomplete');
    expect(merged.note).toContain('no metering coverage');
  });
});
