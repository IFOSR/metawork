import { createHash } from 'node:crypto';
import { partitionCanonicalKey, partitionCovers } from './partition.js';
import type {
  CapabilityGrantLimits,
  NormalizedCapabilityRequest,
  PermissionDecision,
  PermissionRule,
} from './types.js';

const READ_OR_NETWORK_CAPABILITIES = new Set([
  'additional_read_resource',
  'network_target',
]);

const ALWAYS_ESCALATE_CAPABILITIES = new Set([
  'sealed_secret',
  'external_object_operation',
  'repository_promotion',
]);

const HARD_DENY_TOKENS = [
  'privileged',
  'docker_socket',
  'host_device',
  'host_pid',
  'host_ipc',
  'host_network',
  'bypass_broker',
  'bypass_egress_proxy',
  'system_credentials',
  'other_task_secret',
  'other_task_workspace',
  'modify_permission_policy',
  'modify_kernel_ledger',
  'weaken_sandbox',
] as const;

export interface PermissionEvaluationInput {
  request: NormalizedCapabilityRequest;
  rules: PermissionRule[];
  now: string;
  previouslyDeniedFingerprints: string[];
  userAuthorizationFingerprints: string[];
  maxDistinctRequests?: number;
}

function operationMatches(pattern: string, operation: string): boolean {
  return pattern === '*' || pattern === operation;
}

function matchingRule(request: NormalizedCapabilityRequest, rules: PermissionRule[]): PermissionRule | null {
  return rules.find(rule => (
    (rule.capability === '*' || rule.capability === request.capability)
    && operationMatches(rule.operation, request.operation)
    && (!rule.partition || partitionCovers(rule.partition, request.partition))
  )) ?? null;
}

export function capabilityRequestFingerprint(
  request: Pick<NormalizedCapabilityRequest, 'taskId' | 'subtaskId' | 'capability' | 'partition' | 'operation' | 'suggestedScope'>,
): string {
  const canonical = [
    request.taskId,
    request.subtaskId,
    request.capability,
    partitionCanonicalKey(request.partition),
    request.operation,
    request.suggestedScope,
  ].join('\u0000');
  return createHash('sha256').update(canonical).digest('hex');
}

export function defaultGrantLimits(request: NormalizedCapabilityRequest, now: string): CapabilityGrantLimits {
  const issuedAt = Date.parse(now);
  if (!Number.isFinite(issuedAt)) throw new Error('permission evaluation requires an ISO timestamp');
  const readOrNetwork = READ_OR_NETWORK_CAPABILITIES.has(request.capability);
  return {
    expiresAt: new Date(issuedAt + (readOrNetwork ? 15 : 5) * 60_000).toISOString(),
    maxCalls: readOrNetwork ? 100 : 1,
    maxBytes: readOrNetwork ? 100 * 1024 * 1024 : 0,
  };
}

export function evaluateCapabilityRequest(input: PermissionEvaluationInput): PermissionDecision {
  const { request } = input;
  const operation = request.operation.toLowerCase();
  const hardDeny = HARD_DENY_TOKENS.find(token => operation.includes(token));
  if (hardDeny) {
    return { type: 'deny_capability', ruleId: null, reason: `platform hard deny: ${hardDeny}` };
  }
  if (!request.reason.trim()) {
    return { type: 'deny_capability', ruleId: null, reason: 'a concrete reason is required' };
  }
  if (request.distinctRequestOrdinal > (input.maxDistinctRequests ?? 8)) {
    return { type: 'escalate_capability', ruleId: null, reason: 'attempt capability request budget exceeded' };
  }
  if (input.previouslyDeniedFingerprints.includes(request.fingerprint)) {
    return { type: 'deny_capability', ruleId: null, reason: 'identical capability request was already denied' };
  }

  const rule = matchingRule(request, input.rules);
  if (rule?.effect === 'deny') {
    return { type: 'deny_capability', ruleId: rule.id, reason: rule.reason };
  }
  if (rule?.effect === 'escalate') {
    return { type: 'escalate_capability', ruleId: rule.id, reason: rule.reason };
  }
  const explicitlyAuthorized = input.userAuthorizationFingerprints.includes(request.fingerprint);
  if (rule?.effect === 'allow' || explicitlyAuthorized) {
    return {
      type: 'grant_capability',
      ruleId: rule?.id ?? 'user_authorization',
      reason: rule?.reason ?? 'exact user authorization covers this request',
      limits: defaultGrantLimits(request, input.now),
    };
  }
  if (ALWAYS_ESCALATE_CAPABILITIES.has(request.capability)) {
    return { type: 'escalate_capability', ruleId: null, reason: 'capability requires exact user authorization' };
  }
  return { type: 'deny_capability', ruleId: null, reason: 'no explicit permission rule covers this request' };
}
