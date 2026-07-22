export type AccessMode = 'read' | 'write';

export type PartitionIdentity =
  | { kind: 'repository'; repositoryId: string }
  | { kind: 'worktree'; repositoryId: string; workspaceId: string }
  | { kind: 'path'; mountId: string; normalizedRelativePath: string }
  | { kind: 'logical'; namespace: string; key: string }
  | {
      kind: 'external_object';
      provider: string;
      account: string;
      collection: string;
      objectId: string;
    };

export interface ResourceClaim {
  partition: PartitionIdentity;
  access: AccessMode;
}

export interface MountRegistration {
  mountId: string;
  caseSensitive: boolean;
}

export const PERMISSION_PROFILE_IDS = [
  'workspace-engineering',
  'public-web-research',
  'restricted-custom',
] as const;

export type PermissionProfileId = typeof PERMISSION_PROFILE_IDS[number];

export const CONTROLLED_CAPABILITIES = [
  'additional_read_resource',
  'network_target',
  'sealed_secret',
  'external_object_operation',
  'repository_promotion',
  'logical_resource_operation',
] as const;

export type ControlledCapability = typeof CONTROLLED_CAPABILITIES[number];
export type CapabilityScope = 'once' | 'attempt';

export interface CapabilityRequestInput {
  capability: ControlledCapability;
  resource: string;
  operation: string;
  reason: string;
  suggestedScope: CapabilityScope;
}

export interface NormalizedCapabilityRequest extends CapabilityRequestInput {
  id: string;
  fingerprint: string;
  taskId: string;
  generationId: string;
  subtaskId: string;
  attemptId: string;
  agentClassName: string;
  permissionProfileId: PermissionProfileId;
  partition: PartitionIdentity;
  distinctRequestOrdinal: number;
}

export interface CapabilityGrantLimits {
  expiresAt: string;
  maxCalls: number;
  maxBytes: number;
}

export interface CapabilityGrant {
  id: string;
  requestId: string;
  fingerprint: string;
  taskId: string;
  subtaskId: string;
  attemptId: string;
  capability: ControlledCapability;
  partition: PartitionIdentity;
  operation: string;
  scope: CapabilityScope;
  limits: CapabilityGrantLimits;
  callsUsed: number;
  bytesUsed: number;
  revokedAt: string | null;
}

export interface PermissionRule {
  id: string;
  effect: 'allow' | 'deny' | 'escalate';
  capability: ControlledCapability | '*';
  operation: string;
  partition: PartitionIdentity | null;
  reason: string;
}

export type PermissionDecision =
  | { type: 'grant_capability'; ruleId: string; reason: string; limits: CapabilityGrantLimits }
  | { type: 'deny_capability'; ruleId: string | null; reason: string }
  | { type: 'escalate_capability'; ruleId: string | null; reason: string };
