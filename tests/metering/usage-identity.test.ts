import { describe, expect, it } from 'vitest';
import { normalizeUsageEvents } from '../../src/metering/usage-normalizer.js';

describe('usage identity attribution', () => {
  it('preserves AgentClass, Provider and Model identity on normalized observations', () => {
    const result = normalizeUsageEvents({
      events: [{
        sourceId: 'planner',
        sourceEventKey: 'message_end:assistant-1',
        sourceScope: 'model_request',
        callId: 'assistant-1',
        queryId: 'query-1',
        stage: 'planning',
        reason: 'primary',
        payer: 'platform',
        capturedAt: '2026-09-22T10:00:00.000Z',
        agentClassRef: 'planner',
        providerRef: 'deepseek',
        modelId: 'deepseek-flash',
        counters: [{
          resource: 'model_tokens',
          metric: 'input',
          unit: 'token',
          kind: 'delta',
          value: '139',
        }],
      }],
    });

    expect(result.observations[0]).toMatchObject({
      agentClassRef: 'planner',
      providerRef: 'deepseek',
      modelId: 'deepseek-flash',
    });
  });
});
