import { describe, expect, it } from 'vitest';
import {
  defaultMountCaseSensitivity,
  workspacePathClaim,
  workspaceRootClaim,
  workspaceVolumeMountId,
} from '../../src/resource/workspace-claim.js';
import {
  partitionCanonicalKey,
  partitionsOverlap,
  resourceClaimsConflict,
} from '../../src/resource/partition.js';

describe('workspace resource claims', () => {
  it('derives the mount from the filesystem volume, not the Workspace id', () => {
    // Two Workspace ids on the same volume share one mount, which is what makes
    // ancestor/descendant claims comparable at all.
    expect(workspaceVolumeMountId('/repos/a')).toBe(workspaceVolumeMountId('/repos/b'));
    expect(workspaceVolumeMountId('/repos/a')).toMatch(/^workspacefs:[0-9a-f]{16}$/u);
  });

  it('conflicts a Workspace root with its own descendant Workspace', () => {
    // Regression for the P0: distinct Workspace ids on nested paths used to be
    // independent partitions, so an in-place Attempt and a publication could
    // write the same physical directory concurrently.
    const outer = workspaceRootClaim('/repos/app');
    const inner = workspaceRootClaim('/repos/app/sub');
    expect(partitionsOverlap(outer.partition, inner.partition)).toBe(true);
    expect(resourceClaimsConflict(outer, inner)).toBe(true);
    expect(partitionsOverlap(inner.partition, outer.partition)).toBe(true);
  });

  it('does not conflict sibling Workspaces on the same volume', () => {
    const left = workspaceRootClaim('/repos/app-one');
    const right = workspaceRootClaim('/repos/app-two');
    expect(partitionsOverlap(left.partition, right.partition)).toBe(false);
  });

  it('serializes a root writer against a nested path claim', () => {
    const root = workspaceRootClaim('/repos/app', 'write');
    const nestedWriter = workspacePathClaim('/repos/app', 'src/index.ts', 'write');
    const nestedReader = workspacePathClaim('/repos/app', 'src/index.ts', 'read');

    expect(resourceClaimsConflict(root, nestedWriter)).toBe(true);
    expect(resourceClaimsConflict(workspaceRootClaim('/repos/app', 'read'), nestedReader)).toBe(false);
    expect(resourceClaimsConflict(workspaceRootClaim('/repos/app', 'read'), nestedWriter)).toBe(true);
  });

  it('separates the user Workspace from an integration mount', () => {
    const workspace = workspaceRootClaim('/repos/app');
    const integration = {
      partition: { kind: 'mount_root' as const, mountId: 'integration-task_1-generation_1' },
      access: 'write' as const,
    };
    expect(partitionsOverlap(workspace.partition, integration.partition)).toBe(false);
  });

  it('folds case on case-insensitive mounts and keeps it on case-sensitive ones', () => {
    const folded = workspacePathClaim('/repos/app', 'Src\\Feature//Index.ts', 'write', false);
    const caseSensitive = workspacePathClaim('/repos/app', 'Src/Feature/Index.ts', 'write', true);
    expect(partitionCanonicalKey(folded.partition)).toContain('src/feature/index.ts');
    expect(partitionCanonicalKey(caseSensitive.partition)).toContain('Src/Feature/Index.ts');
    expect(defaultMountCaseSensitivity('darwin')).toBe(false);
    expect(defaultMountCaseSensitivity('linux')).toBe(true);
  });

  it('rejects escapes and relative Workspace paths', () => {
    expect(() => workspacePathClaim('/repos/app', '../secret')).toThrow(/must not contain/u);
    expect(() => workspacePathClaim('/repos/app', '/etc/passwd')).toThrow(/mount|absolute|escape/u);
    expect(() => workspaceRootClaim('relative/path')).toThrow(/must be absolute/u);
  });
});
