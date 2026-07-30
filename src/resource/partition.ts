import type {
  MountRegistration,
  PartitionIdentity,
  ResourceClaim,
} from './types.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/u;

function normalizeOpaqueSegment(value: string, label: string, allowWildcard = false): string {
  const normalized = value.normalize('NFC').trim();
  if (!normalized || CONTROL_CHARACTERS.test(normalized) || normalized.includes('/') || normalized.includes('\\')) {
    throw new Error(`${label} must be a non-empty opaque segment`);
  }
  if (!allowWildcard && normalized === '*') {
    throw new Error(`${label} cannot be a wildcard`);
  }
  return normalized;
}

function normalizeSegmentedValue(value: string, label: string, allowWildcard: boolean): string {
  const rawSegments = value.normalize('NFC').replace(/\\/gu, '/').split('/');
  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (!segment || segment === '.') continue;
    if (segment === '..' || CONTROL_CHARACTERS.test(segment)) {
      throw new Error(`${label} contains an unsafe segment`);
    }
    if (segment.includes('*') && (!allowWildcard || segment !== '*')) {
      throw new Error(`${label} supports only whole-segment wildcards`);
    }
    segments.push(segment);
  }
  if (segments.length === 0) throw new Error(`${label} must not be empty`);
  return segments.join('/');
}

export function normalizeMountRegistration(registration: MountRegistration): MountRegistration {
  return {
    mountId: normalizeOpaqueSegment(registration.mountId, 'mountId').toLowerCase(),
    caseSensitive: registration.caseSensitive,
  };
}

export function normalizeMountedRelativePath(
  registration: MountRegistration,
  input: string,
): Extract<PartitionIdentity, { kind: 'path' }> {
  const mount = normalizeMountRegistration(registration);
  const value = input.normalize('NFC').trim();
  if (value.startsWith('/') || value.startsWith('\\') || WINDOWS_ABSOLUTE_PATH.test(value)) {
    throw new Error('mounted paths must be relative to a registered mount');
  }
  const normalizedRelativePath = normalizeSegmentedValue(value, 'path', false);
  return {
    kind: 'path',
    mountId: mount.mountId,
    normalizedRelativePath: mount.caseSensitive
      ? normalizedRelativePath
      : normalizedRelativePath.toLocaleLowerCase('en-US'),
  };
}

export function normalizePartitionIdentity(identity: PartitionIdentity): PartitionIdentity {
  switch (identity.kind) {
    case 'repository':
      return {
        kind: 'repository',
        repositoryId: normalizeOpaqueSegment(identity.repositoryId, 'repositoryId'),
      };
    case 'worktree':
      return {
        kind: 'worktree',
        repositoryId: normalizeOpaqueSegment(identity.repositoryId, 'repositoryId'),
        workspaceId: normalizeOpaqueSegment(identity.workspaceId, 'workspaceId'),
      };
    case 'path':
      return {
        kind: 'path',
        mountId: normalizeOpaqueSegment(identity.mountId, 'mountId').toLowerCase(),
        normalizedRelativePath: normalizeSegmentedValue(identity.normalizedRelativePath, 'path', false),
      };
    case 'logical':
      return {
        kind: 'logical',
        namespace: normalizeOpaqueSegment(identity.namespace, 'namespace', true).toLowerCase(),
        key: normalizeSegmentedValue(identity.key, 'logical key', true),
      };
    case 'external_object':
      return {
        kind: 'external_object',
        provider: normalizeOpaqueSegment(identity.provider, 'provider', true).toLowerCase(),
        account: normalizeOpaqueSegment(identity.account, 'account', true),
        collection: normalizeOpaqueSegment(identity.collection, 'collection', true),
        objectId: normalizeSegmentedValue(identity.objectId, 'objectId', true),
      };
  }
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/%2F/giu, '/');
}

export function partitionCanonicalKey(identity: PartitionIdentity): string {
  const normalized = normalizePartitionIdentity(identity);
  switch (normalized.kind) {
    case 'repository':
      return `repository:${encode(normalized.repositoryId)}`;
    case 'worktree':
      return `worktree:${encode(normalized.repositoryId)}:${encode(normalized.workspaceId)}`;
    case 'path':
      return `path:${encode(normalized.mountId)}:${encode(normalized.normalizedRelativePath)}`;
    case 'logical':
      return `logical:${encode(normalized.namespace)}:${encode(normalized.key)}`;
    case 'external_object':
      return [
        'external_object',
        normalized.provider,
        normalized.account,
        normalized.collection,
        normalized.objectId,
      ].map(encode).join(':');
  }
}

function segmentPatternCovers(pattern: string, concrete: string): boolean {
  const patternSegments = pattern.split('/');
  const concreteSegments = concrete.split('/');
  if (patternSegments.length !== concreteSegments.length) return false;
  return patternSegments.every((segment, index) => segment === '*' || segment === concreteSegments[index]);
}

function pathCovers(parent: string, child: string): boolean {
  const parentSegments = parent.split('/');
  const childSegments = child.split('/');
  return parentSegments.length <= childSegments.length
    && parentSegments.every((segment, index) => segment === childSegments[index]);
}

export function partitionCovers(parentInput: PartitionIdentity, childInput: PartitionIdentity): boolean {
  const parent = normalizePartitionIdentity(parentInput);
  const child = normalizePartitionIdentity(childInput);
  if (parent.kind === 'repository') {
    return (child.kind === 'repository' || child.kind === 'worktree')
      && parent.repositoryId === child.repositoryId;
  }
  if (parent.kind === 'worktree') {
    return child.kind === 'worktree'
      && parent.repositoryId === child.repositoryId
      && parent.workspaceId === child.workspaceId;
  }
  if (parent.kind === 'path' && child.kind === 'path') {
    return parent.mountId === child.mountId
      && pathCovers(parent.normalizedRelativePath, child.normalizedRelativePath);
  }
  if (parent.kind === 'logical' && child.kind === 'logical') {
    return (parent.namespace === '*' || parent.namespace === child.namespace)
      && segmentPatternCovers(parent.key, child.key);
  }
  if (parent.kind === 'external_object' && child.kind === 'external_object') {
    return (parent.provider === '*' || parent.provider === child.provider)
      && (parent.account === '*' || parent.account === child.account)
      && (parent.collection === '*' || parent.collection === child.collection)
      && segmentPatternCovers(parent.objectId, child.objectId);
  }
  return false;
}

export function partitionsOverlap(left: PartitionIdentity, right: PartitionIdentity): boolean {
  return partitionCovers(left, right) || partitionCovers(right, left);
}

export function resourceClaimsConflict(left: ResourceClaim, right: ResourceClaim): boolean {
  return partitionsOverlap(left.partition, right.partition)
    && (left.access === 'write' || right.access === 'write');
}
