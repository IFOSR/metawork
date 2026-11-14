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

  it('accepts billed search and tool requests as their own metered resources', () => {
    const result = normalizeUsageEvents({
      events: [{
        sourceId: 'harness:pi:attempt-1',
        sourceEventKey: 'tool_request:call_1',
        sourceScope: 'harness_turn',
        callId: 'tool:call_1',
        queryId: 'query-1',
        stage: 'execution',
        capturedAt: '2026-11-14T10:00:00.000Z',
        counters: [
          { resource: 'search', metric: 'request', unit: 'request', kind: 'delta', value: '1' },
          { resource: 'tool_request', metric: 'request', unit: 'request', kind: 'delta', value: '1' },
        ],
      }],
    });
    expect(result.issues).toEqual([]);
    expect(result.observations.map(observation => [observation.resource, observation.metric, observation.unit]))
      .toEqual([['search', 'request', 'request'], ['tool_request', 'request', 'request']]);
    expect(result.observations.every(observation => observation.countsTowardTotal)).toBe(true);
  });
});
