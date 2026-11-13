import type { UsagePayerResolver } from '../metering/usage-payer.js';
import type { ManagerPermissionContextDependencies } from '../account/manager-permission-context.js';
import type { UsageRecorder } from '../metering/usage-service.js';

/** Permission calls use the same provider ownership policy as other model calls. */
export function createManagerPermissionUsageRecorder(deps: {
  recorder: UsageRecorder;
  resolveUsagePayer: UsagePayerResolver;
}): ManagerPermissionContextDependencies['onUsage'] {
  return ({ queryId, taskId, requestId, configurationRevision, usage }) => {
    deps.recorder.record({
      sourceId: 'manager-permission', sourceEventKey: `${requestId}:${usage.sourceEventKey}`,
      sourceScope: 'model_request', callId: `${requestId}:${usage.callId}`, queryId, taskId,
      stage: 'execution', reason: 'primary', payer: deps.resolveUsagePayer(usage.providerRef, configurationRevision),
      capturedAt: usage.occurredAtUtc ?? new Date().toISOString(),
      providerResponseId: usage.providerResponseId, providerBindingVersion: configurationRevision,
      evidenceRef: `permission:${requestId}`, agentClassRef: usage.agentClassRef,
      providerRef: usage.providerRef, modelId: usage.modelId,
      counters: usage.counters, missing: usage.missing,
    });
  };
}
