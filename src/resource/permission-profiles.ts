import { partitionCanonicalKey } from './partition.js';
import type {
  PartitionIdentity,
  PermissionProfileId,
  PermissionRule,
  ResourceClaim,
} from './types.js';

export interface PermissionProfile {
  id: PermissionProfileId;
  publicNetwork: 'disabled' | 'egress_proxy';
  workspaceWritable: true;
  temporaryDirectoryWritable: true;
  sourceReadOnly: true;
  inputsReadOnly: true;
  handoffsReadOnly: true;
  gitMetadataReadOnly: true;
}

const PROFILES: Record<PermissionProfileId, PermissionProfile> = {
  'workspace-engineering': {
    id: 'workspace-engineering',
    publicNetwork: 'disabled',
    workspaceWritable: true,
    temporaryDirectoryWritable: true,
    sourceReadOnly: true,
    inputsReadOnly: true,
    handoffsReadOnly: true,
    gitMetadataReadOnly: true,
  },
  'public-web-research': {
    id: 'public-web-research',
    publicNetwork: 'egress_proxy',
    workspaceWritable: true,
    temporaryDirectoryWritable: true,
    sourceReadOnly: true,
    inputsReadOnly: true,
    handoffsReadOnly: true,
    gitMetadataReadOnly: true,
  },
  'restricted-custom': {
    id: 'restricted-custom',
    publicNetwork: 'disabled',
    workspaceWritable: true,
    temporaryDirectoryWritable: true,
    sourceReadOnly: true,
    inputsReadOnly: true,
    handoffsReadOnly: true,
    gitMetadataReadOnly: true,
  },
};

export function getPermissionProfile(id: PermissionProfileId): PermissionProfile {
  return { ...PROFILES[id] };
}

export function buildPermissionRules(input: {
  permissionProfileId: PermissionProfileId;
  additionalReadPartitions: Iterable<PartitionIdentity>;
}): PermissionRule[] {
  const readPartitions = Array.from(input.additionalReadPartitions, partition => ({
    key: partitionCanonicalKey(partition),
    partition,
  }));
  const uniqueReadPartitions = Array.from(
    new Map(readPartitions.map(item => [item.key, item])).values(),
  ).sort((left, right) => left.key.localeCompare(right.key));
  const rules: PermissionRule[] = uniqueReadPartitions.map((item, index) => ({
    id: `permission-profile-v1:${input.permissionProfileId}:additional-read:${index}`,
    effect: 'allow',
    capability: 'additional_read_resource',
    operation: '*',
    partition: item.partition,
    reason: 'the current Task explicitly registered this read-only resource',
  }));
  if (input.permissionProfileId === 'public-web-research') {
    rules.push({
      id: 'permission-profile-v1:public-web-research:public-http',
      effect: 'allow',
      capability: 'network_target',
      operation: '*',
      partition: null,
      reason: 'the AgentClass profile permits normalized public HTTP(S) through the policy egress proxy',
    });
  }
  return rules;
}

export function buildDefaultResourceClaims(input: {
  workspaceId: string;
  sourceMountId: string;
  inputsMountId: string;
  handoffsMountId: string;
  gitMetadataMountId: string;
}): ResourceClaim[] {
  return [
    { partition: { kind: 'path', mountId: input.workspaceId, normalizedRelativePath: 'workspace' }, access: 'write' },
    { partition: { kind: 'path', mountId: input.sourceMountId, normalizedRelativePath: 'source' }, access: 'read' },
    { partition: { kind: 'path', mountId: input.inputsMountId, normalizedRelativePath: 'inputs' }, access: 'read' },
    { partition: { kind: 'path', mountId: input.handoffsMountId, normalizedRelativePath: 'handoffs' }, access: 'read' },
    { partition: { kind: 'path', mountId: input.gitMetadataMountId, normalizedRelativePath: 'git-metadata' }, access: 'read' },
  ];
}
