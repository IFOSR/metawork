import {
  normalizeMountRegistration,
  normalizeMountedRelativePath,
} from './partition.js';
import type { AccessMode, MountRegistration, ResourceClaim } from './types.js';

/** Mount-id namespace for user Workspaces; keeps them apart from integration mounts. */
const WORKSPACE_MOUNT_PREFIX = 'workspace:';

/**
 * Default case folding for a mount. Workspace claims and file references must
 * agree on this, so the platform default lives here rather than in callers.
 */
export function defaultMountCaseSensitivity(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'darwin' && platform !== 'win32';
}

/**
 * Claims a whole Workspace root. Two roots overlap only inside one mount, and a
 * root claim covers every path claim registered under the same mount (see
 * `partitionCovers`), which is how an in-place Attempt and a publication that
 * writes into the same user directory serialize through `resource_waits`.
 */
export function workspaceRootClaim(workspaceId: string, access: AccessMode = 'write'): ResourceClaim {
  return { partition: { kind: 'mount_root', mountId: workspaceMountId(workspaceId) }, access };
}

/** Claims one Workspace-relative path (file or directory subtree). */
export function workspacePathClaim(
  workspaceId: string,
  relativePath: string,
  access: AccessMode = 'write',
  caseSensitive: boolean = defaultMountCaseSensitivity(),
): ResourceClaim {
  return {
    partition: normalizeMountedRelativePath(workspaceMountRegistration(workspaceId, caseSensitive), relativePath),
    access,
  };
}

export function workspaceMountRegistration(
  workspaceId: string,
  caseSensitive: boolean = defaultMountCaseSensitivity(),
): MountRegistration {
  return { mountId: workspaceMountId(workspaceId), caseSensitive };
}

/**
 * Stable mount id for one Workspace identity. The id is lower-cased by mount
 * normalization, so callers must compare mount ids through this helper.
 */
export function workspaceMountId(workspaceId: string): string {
  return normalizeMountRegistration({
    mountId: `${WORKSPACE_MOUNT_PREFIX}${workspaceId}`,
    caseSensitive: true,
  }).mountId;
}

export function isWorkspaceMountId(mountId: string): boolean {
  return normalizeMountRegistration({ mountId, caseSensitive: true })
    .mountId.startsWith(WORKSPACE_MOUNT_PREFIX);
}
