import type { PermissionProfileId, ResourceClaim } from './types.js';

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
