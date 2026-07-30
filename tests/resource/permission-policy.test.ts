import {
  capabilityRequestFingerprint,
  evaluateCapabilityRequest,
  type NormalizedCapabilityRequest,
} from '../../src/resource/index.js';

function request(overrides: Partial<NormalizedCapabilityRequest> = {}): NormalizedCapabilityRequest {
  const base: NormalizedCapabilityRequest = {
    id: 'permission-1',
    fingerprint: '',
    taskId: 'task-1',
    generationId: 'generation-1',
    subtaskId: 'subtask-1',
    attemptId: 'attempt-1',
    agentClassName: 'codex-cli',
    permissionProfileId: 'workspace-engineering',
    capability: 'network_target',
    resource: 'https://example.com',
    partition: { kind: 'external_object', provider: 'http', account: 'public', collection: 'example.com', objectId: 'root' },
    operation: 'https_get',
    reason: 'read public documentation',
    suggestedScope: 'attempt',
    distinctRequestOrdinal: 1,
  };
  const value = { ...base, ...overrides };
  value.fingerprint = capabilityRequestFingerprint(value);
  return value;
}

describe('permission policy', () => {
  test('uses explicit allow rules and bounded read/network grants', () => {
    const req = request();
    expect(evaluateCapabilityRequest({
      request: req,
      now: '2026-07-22T00:00:00.000Z',
      rules: [{ id: 'rule-1', effect: 'allow', capability: 'network_target', operation: 'https_get', partition: req.partition, reason: 'approved public endpoint' }],
      previouslyDeniedFingerprints: [],
      userAuthorizationFingerprints: [],
    })).toMatchObject({ type: 'grant_capability', ruleId: 'rule-1', limits: { maxCalls: 100, maxBytes: 104857600 } });
  });

  test('fails hard-deny and repeated requests closed', () => {
    const hardDenied = request({ operation: 'mount_docker_socket' });
    expect(evaluateCapabilityRequest({ request: hardDenied, now: '2026-07-22T00:00:00.000Z', rules: [], previouslyDeniedFingerprints: [], userAuthorizationFingerprints: [] }))
      .toMatchObject({ type: 'deny_capability' });
    const repeated = request();
    expect(evaluateCapabilityRequest({ request: repeated, now: '2026-07-22T00:00:00.000Z', rules: [], previouslyDeniedFingerprints: [repeated.fingerprint], userAuthorizationFingerprints: [] }))
      .toMatchObject({ type: 'deny_capability' });
  });

  test('escalates dangerous valid requests until exact user authorization exists', () => {
    const req = request({ capability: 'repository_promotion', operation: 'promote_commit', suggestedScope: 'once' });
    expect(evaluateCapabilityRequest({ request: req, now: '2026-07-22T00:00:00.000Z', rules: [], previouslyDeniedFingerprints: [], userAuthorizationFingerprints: [] }))
      .toMatchObject({ type: 'escalate_capability' });
    expect(evaluateCapabilityRequest({ request: req, now: '2026-07-22T00:00:00.000Z', rules: [], previouslyDeniedFingerprints: [], userAuthorizationFingerprints: [req.fingerprint] }))
      .toMatchObject({ type: 'grant_capability', limits: { maxCalls: 1, maxBytes: 1024 * 1024 } });
  });

  test('escalates after eight distinct requests', () => {
    expect(evaluateCapabilityRequest({ request: request({ distinctRequestOrdinal: 9 }), now: '2026-07-22T00:00:00.000Z', rules: [], previouslyDeniedFingerprints: [], userAuthorizationFingerprints: [] }))
      .toMatchObject({ type: 'escalate_capability' });
  });
});
