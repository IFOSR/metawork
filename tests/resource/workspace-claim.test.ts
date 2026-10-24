import { describe, expect, it } from 'vitest';
import {
  defaultMountCaseSensitivity,
  isWorkspaceMountId,
  partitionCanonicalKey,
  partitionCovers,
  partitionsOverlap,
  resourceClaimsConflict,
  workspaceMountId,
  workspacePathClaim,
  workspaceRootClaim,
} from '../../src/resource/index.js';

describe('workspace resource claims', () => {
  it('namespaces workspace mounts apart from integration mounts', () => {
    expect(workspaceMountId('workspace_abc')).toBe('workspace:workspace_abc');
    expect(isWorkspaceMountId('workspace:workspace_abc')).toBe(true);
    expect(isWorkspaceMountId('integration-task-1-generation-1')).toBe(false);
    // Mount ids are opaque segments, so the namespace separator is URL-encoded in the canonical key.
    expect(partitionCanonicalKey(workspaceRootClaim('workspace_abc').partition))
      .toBe('mount_root:workspace%3Aworkspace_abc');
    expect(() => workspaceMountId('a/b')).toThrow(/mountId/u);
  });

  it('lets a root claim cover every path claim in the same workspace mount', () => {
    const root = workspaceRootClaim('workspace_abc');
    const nested = workspacePathClaim('workspace_abc', 'metaclaw-tasks/deck/out.pptx', 'write', true);
    const outside = workspacePathClaim('workspace_other', 'metaclaw-tasks/deck/out.pptx', 'write', true);

    expect(partitionCovers(root.partition, nested.partition)).toBe(true);
    expect(partitionCovers(nested.partition, root.partition)).toBe(false);
    expect(partitionsOverlap(root.partition, nested.partition)).toBe(true);
    expect(partitionsOverlap(root.partition, outside.partition)).toBe(false);
    expect(partitionsOverlap(root.partition, workspaceRootClaim('workspace_other').partition)).toBe(false);
  });

  it('serializes writers on the same workspace and lets readers share it', () => {
    const writer = workspaceRootClaim('workspace_abc', 'write');
    const nestedWriter = workspacePathClaim('workspace_abc', 'src/index.ts', 'write', true);
    const nestedReader = workspacePathClaim('workspace_abc', 'src/index.ts', 'read', true);

    expect(resourceClaimsConflict(writer, nestedWriter)).toBe(true);
    expect(resourceClaimsConflict(nestedWriter, writer)).toBe(true);
    expect(resourceClaimsConflict(workspaceRootClaim('workspace_abc', 'read'), nestedReader)).toBe(false);
    expect(resourceClaimsConflict(workspaceRootClaim('workspace_abc', 'read'), nestedWriter)).toBe(true);
  });

  it('normalizes relative paths through the workspace mount and rejects escapes', () => {
    const claim = workspacePathClaim('workspace_abc', 'Src\\Feature//Index.ts', 'write', false);
    expect(claim.partition).toEqual({
      kind: 'path',
      mountId: 'workspace:workspace_abc',
      normalizedRelativePath: 'src/feature/index.ts',
    });
    expect(() => workspacePathClaim('workspace_abc', '../secret')).toThrow(/unsafe segment/u);
    expect(() => workspacePathClaim('workspace_abc', '/etc/passwd')).toThrow(/relative to a registered mount/u);
  });

  it('folds mount case on platforms whose filesystems are case insensitive by default', () => {
    expect(defaultMountCaseSensitivity('darwin')).toBe(false);
    expect(defaultMountCaseSensitivity('win32')).toBe(false);
    expect(defaultMountCaseSensitivity('linux')).toBe(true);
  });
});
