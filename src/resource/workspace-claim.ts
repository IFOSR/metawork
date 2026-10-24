import { createHash } from 'node:crypto';
import { isAbsolute, parse, relative } from 'node:path';
import {
  normalizeMountRegistration,
  normalizeMountedRelativePath,
} from './partition.js';
import type { AccessMode, MountRegistration, ResourceClaim } from './types.js';

/** Mount-id namespace for user Workspaces; keeps them apart from integration mounts. */
const WORKSPACE_FS_MOUNT_PREFIX = 'workspacefs:';

/**
 * Default case folding for a mount. Workspace claims and file references must
 * agree on this, so the platform default lives here rather than in callers.
 */
export function defaultMountCaseSensitivity(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'darwin' && platform !== 'win32';
}

/**
 * One mount per filesystem volume, not per Workspace record. Claims are
 * expressed as volume-relative paths, so `/repos/app` and `/repos/app/sub`
 * share a mount and conflict on the ancestor/descendant pair even when they are
 * two distinct Workspace identities with different ids. A per-Workspace mount
 * could never express that overlap.
 */
export function workspaceVolumeMountId(path: string): string {
  return `${WORKSPACE_FS_MOUNT_PREFIX}${createHash('sha256').update(volumeRoot(path)).digest('hex').slice(0, 16)}`;
}

export function workspaceVolumeMountRegistration(
  path: string,
  caseSensitive: boolean = defaultMountCaseSensitivity(),
): MountRegistration {
  return { mountId: workspaceVolumeMountId(path), caseSensitive };
}

/**
 * Claims a whole Workspace root. The claim is a `mount_root` only when the
 * Workspace *is* the volume root; otherwise it is a volume-relative path claim,
 * which `partitionCovers` already treats as covering every descendant path.
 */
export function workspaceRootClaim(
  canonicalWorkspacePath: string,
  access: AccessMode = 'write',
  caseSensitive: boolean = defaultMountCaseSensitivity(),
): ResourceClaim {
  const registration = workspaceVolumeMountRegistration(canonicalWorkspacePath, caseSensitive);
  const segments = volumeRelativeSegments(canonicalWorkspacePath);
  if (segments.length === 0) {
    return { partition: { kind: 'mount_root', mountId: registration.mountId }, access };
  }
  return { partition: normalizeMountedRelativePath(registration, segments.join('/')), access };
}

/** Claims one Workspace-relative path (file or directory subtree). */
export function workspacePathClaim(
  canonicalWorkspacePath: string,
  relativePath: string,
  access: AccessMode = 'write',
  caseSensitive: boolean = defaultMountCaseSensitivity(),
): ResourceClaim {
  if (isAbsolute(relativePath)) {
    throw new Error('workspace-relative claim path must not be absolute');
  }
  const registration = workspaceVolumeMountRegistration(canonicalWorkspacePath, caseSensitive);
  const rootSegments = volumeRelativeSegments(canonicalWorkspacePath);
  const childSegments = relativePath
    .normalize('NFC')
    .replace(/\\/gu, '/')
    .split('/')
    .filter(segment => segment && segment !== '.');
  if (childSegments.includes('..')) {
    throw new Error('workspace-relative claim path must not contain ..');
  }
  return {
    partition: normalizeMountedRelativePath(registration, [...rootSegments, ...childSegments].join('/')),
    access,
  };
}

/** Workspace-relative path of one canonical path inside its volume mount. */
export function workspaceVolumeRelativePath(canonicalPath: string): string {
  return volumeRelativeSegments(canonicalPath).join('/');
}

export function isWorkspaceMountId(mountId: string): boolean {
  return normalizeMountRegistration({ mountId, caseSensitive: true })
    .mountId.startsWith(WORKSPACE_FS_MOUNT_PREFIX);
}

function volumeRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error(`workspace path must be absolute to build a claim: ${path}`);
  return parse(path).root.replace(/\\/gu, '/') || '/';
}

function volumeRelativeSegments(canonicalPath: string): string[] {
  const relativePath = relative(parse(canonicalPath).root, canonicalPath);
  const segments = relativePath
    .normalize('NFC')
    .replace(/\\/gu, '/')
    .split('/')
    .filter(segment => segment && segment !== '.');
  if (segments.includes('..')) {
    throw new Error(`workspace path escapes its volume: ${canonicalPath}`);
  }
  return segments;
}
