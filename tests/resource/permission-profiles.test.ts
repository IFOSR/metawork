import { describe, expect, it } from 'vitest';
import {
  buildPermissionRules,
  evaluateCapabilityRequest,
  capabilityRequestFingerprint,
  type NormalizedCapabilityRequest,
  type PartitionIdentity,
  type PermissionProfileId,
} from '../../src/resource/index.js';

describe('permission profile rules', () => {
  it('allows only exact Task-registered additional read partitions', () => {
    const registered: PartitionIdentity = {
      kind: 'path', mountId: 'inputs-task-1', normalizedRelativePath: 'resource-0',
    };
    const rules = buildPermissionRules({
      permissionProfileId: 'workspace-engineering',
      additionalReadPartitions: [registered, registered],
    });

    expect(rules).toHaveLength(1);
    expect(decide('workspace-engineering', 'additional_read_resource', registered, rules)).toMatchObject({
      type: 'grant_capability',
      ruleId: 'permission-profile-v1:workspace-engineering:additional-read:0',
    });
    expect(decide('workspace-engineering', 'additional_read_resource', {
      kind: 'path', mountId: 'inputs-task-1', normalizedRelativePath: 'resource-1',
    }, rules)).toMatchObject({ type: 'deny_capability' });
  });

  it('allows normalized public targets only for the public-web-research profile', () => {
    const target: PartitionIdentity = {
      kind: 'external_object', provider: 'https', account: 'public',
      collection: 'example.com', objectId: '443/reports/latest',
    };
    const researchRules = buildPermissionRules({
      permissionProfileId: 'public-web-research', additionalReadPartitions: [],
    });
    const engineeringRules = buildPermissionRules({
      permissionProfileId: 'workspace-engineering', additionalReadPartitions: [],
    });

    expect(decide('public-web-research', 'network_target', target, researchRules)).toMatchObject({
      type: 'grant_capability',
      ruleId: 'permission-profile-v1:public-web-research:public-http',
    });
    expect(decide('workspace-engineering', 'network_target', target, engineeringRules)).toMatchObject({
      type: 'deny_capability',
    });
  });

  it('never profile-allows secrets, external mutations, or repository promotion', () => {
    const rules = buildPermissionRules({
      permissionProfileId: 'public-web-research', additionalReadPartitions: [],
    });
    const target: PartitionIdentity = {
      kind: 'logical', namespace: 'test', key: 'sensitive',
    };
    for (const capability of ['sealed_secret', 'external_object_operation', 'repository_promotion'] as const) {
      expect(decide('public-web-research', capability, target, rules)).toMatchObject({
        type: 'escalate_capability',
      });
    }
  });
});

function decide(
  permissionProfileId: PermissionProfileId,
  capability: NormalizedCapabilityRequest['capability'],
  partition: PartitionIdentity,
  rules: ReturnType<typeof buildPermissionRules>,
) {
  const request: NormalizedCapabilityRequest = {
    id: 'request-1', fingerprint: '', taskId: 'task-1', generationId: 'generation-1',
    subtaskId: 'subtask-1', attemptId: 'attempt-1', agentClassName: 'test-agent',
    permissionProfileId, capability, resource: 'resource', operation: 'read',
    reason: 'required by the current task', suggestedScope: 'once', partition,
    distinctRequestOrdinal: 1,
  };
  request.fingerprint = capabilityRequestFingerprint(request);
  return evaluateCapabilityRequest({
    request, rules, now: '2026-07-23T00:00:00.000Z',
    previouslyDeniedFingerprints: [], userAuthorizationFingerprints: [],
  });
}
