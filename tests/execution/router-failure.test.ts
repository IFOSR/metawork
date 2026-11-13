import { describe, expect, it } from 'vitest';
import { routerFailureFacts } from '../../src/execution/router-failure.js';
import type { RouteDecision } from '../../src/routing/router.js';

describe('Router public failure facts', () => {
  it('distinguishes a failed decision from an empty eligible set', () => {
    const failed = routerFailureFacts({ candidates: [{ agentClassRef: 'pi' }],
      rationale: 'Router decision unavailable (span_http_error); no route selected' } as RouteDecision);
    expect(failed).toMatchObject({ failureCode: 'route_decision_unavailable', attemptStarted: false });
    expect(failed.failureSummary).toContain('已有符合要求');
    expect(failed.failureSummary).toContain('span_http_error');
    expect(failed.userAction).toContain('网络和服务状态');
    expect(routerFailureFacts({ candidates: [] } as unknown as RouteDecision).failureCode)
      .toBe('route_no_candidate');
    expect(routerFailureFacts().failureCode).toBe('route_no_candidate');
  });

  it('keeps an explicit decision-model reason in the public failure fact', () => {
    const failed = routerFailureFacts({
      candidates: [{ agentClassRef: 'pi' }],
      unavailableReason: 'span_timeout',
      rationale: 'Router decision unavailable (span_timeout); no route selected',
    } as RouteDecision);
    expect(failed.failureSummary).toContain('span_timeout');
  });
});
