import { readGitArtifact, readGitArtifactAsync } from './git-artifact-reader.js';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ArtifactVersion } from '../storage/artifact-version-repo.js';
import type { TaskArtifactRecord } from '../storage/task-artifact-repo.js';
import { assertWorkspaceRelativePath, isWithin } from '../workspace/workspace-path.js';

export class ArtifactContentError extends Error {
  constructor(
    readonly code:
      | 'artifact_version_missing'
      | 'artifact_object_missing'
      | 'artifact_object_corrupt'
      | 'workspace_unavailable'
      | 'published_copy_missing'
      | 'published_copy_mismatch'
      | 'content_too_large'
      | 'artifact_version_scope_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactContentError';
  }
}

export interface ResolvedArtifactContent {
  bytes: Buffer;
  /** Hash of the bytes actually returned. */
  contentHash: string;
  /** Where the bytes came from; callers report this so a live file is never
   * mistaken for fixed content. */
  source: TaskArtifactRecord['referenceKind'];
  /** True only when the returned bytes are pinned to a recorded version. */
  immutable: boolean;
}

/**
 * Reads artifact bytes according to the reference kind.
 *
 * - `artifact_version` reads the content-addressed object and verifies its
 *   digest, so a later edit to the live file cannot change what a handoff,
 *   preview or download shows.
 * - `live_file` resolves `workspaceId + sourceRelativePath` and returns the
 *   current bytes with their observed hash; an old artifact hash never
 *   authorizes newer content.
 * - `legacy_published_copy` keeps the historical copy semantics, including the
 *   hash check that proves the copy is the one that was published.
 */
export async function resolveArtifactContent(input: {
  artifact: TaskArtifactRecord;
  /** Canonical user Workspace root for live references. */
  workspaceRoot?: string | null;
  /** Durable fixed version row; looked up by the caller from its repository. */
  artifactVersion?: ArtifactVersion | null;
  /** Content-addressed store root (`<objects>/artifacts`). */
  objectRoot?: string | null;
  /**
   * Legacy copies are ours, so a digest mismatch means the copy was tampered
   * with. Handoff and download keep that strict; a preview may instead show the
   * current bytes with their observed hash.
   */
  verifyPublishedCopyHash?: boolean;
  /**
   * Containment-checked absolute path supplied by the caller for `live_file`
   * and `legacy_published_copy`. Authorization must happen before bytes are
   * read; this module never widens it.
   */
  resolvedPath?: string | null;
  /** Caller identity a fixed version must belong to. */
  expectedAccountId?: string | null;
  expectedWorkspaceId?: string | null;
  /** Hard cap enforced before the bytes are read into memory. */
  maxBytes?: number;
}): Promise<ResolvedArtifactContent> {
  const { artifact } = input;
  switch (artifact.referenceKind) {
    case 'artifact_version': {
      const version = input.artifactVersion;
      if (!version) {
        throw new ArtifactContentError(
          'artifact_version_missing',
          `artifact version is not registered: ${artifact.artifactVersionId ?? artifact.artifactId}`,
        );
      }
      if (!input.objectRoot) {
        throw new ArtifactContentError('artifact_object_missing', 'artifact object store is unavailable');
      }
      // A version must belong to the caller's account and Workspace; otherwise a
      // foreign version id could be read through another task's artifact row.
      if (
        (input.expectedAccountId && version.accountId !== input.expectedAccountId)
        || (input.expectedWorkspaceId && version.workspaceId !== input.expectedWorkspaceId)
      ) {
        throw new ArtifactContentError(
          'artifact_version_scope_mismatch',
          `artifact version ${version.artifactVersionId} belongs to another account or Workspace`,
        );
      }
      if(version.gitCommit) {
        let bytes:Buffer;
        try { bytes=await readGitArtifactAsync(version,input.objectRoot,input.maxBytes); }
        catch(error) { throw new ArtifactContentError('artifact_object_corrupt',String(error)); }
        return {bytes,contentHash:hashBytes(bytes),source:'artifact_version',immutable:true};
      }
      const objectPath = join(input.objectRoot, version.contentHash);
      await assertBoundedSize(objectPath, input.maxBytes);
      const bytes = await readFile(objectPath).catch(() => null);
      if (!bytes) {
        throw new ArtifactContentError('artifact_object_missing', `artifact object is missing: ${version.contentHash}`);
      }
      const contentHash = hashBytes(bytes);
      if (normalizeHash(contentHash) !== normalizeHash(version.contentHash)) {
        throw new ArtifactContentError(
          'artifact_object_corrupt',
          `artifact object digest does not match its record: ${version.contentHash}`,
        );
      }
      return { bytes, contentHash, source: 'artifact_version', immutable: true };
    }
    case 'live_file': {
      const relativePath = artifact.sourceRelativePath ?? artifact.relativePath;
      if (!artifact.workspaceId || !input.workspaceRoot) {
        throw new ArtifactContentError(
          'workspace_unavailable',
          `live artifact has no resolvable Workspace: ${artifact.artifactId}`,
        );
      }
      const absolutePath = input.resolvedPath
        ?? (await assertWorkspaceRelativePath(input.workspaceRoot, relativePath)).absolutePath;
      // Size is checked before reading: a live file can grow after delivery.
      await assertBoundedSize(absolutePath, input.maxBytes);
      const bytes = await readFile(absolutePath);
      return {
        bytes,
        contentHash: hashBytes(bytes),
        source: 'live_file',
        immutable: false,
      };
    }
    case 'legacy_published_copy':
    default: {
      const copyPath = input.resolvedPath ?? artifact.publishedPath;
      await assertBoundedSize(copyPath, input.maxBytes);
      const bytes = await readFile(copyPath).catch(() => null);
      if (!bytes) {
        throw new ArtifactContentError(
          'published_copy_missing',
          `published copy is missing: ${artifact.artifactId}`,
        );
      }
      const contentHash = hashBytes(bytes);
      const matches = normalizeHash(artifact.contentHash) === normalizeHash(contentHash);
      if (!matches && input.verifyPublishedCopyHash !== false) {
        throw new ArtifactContentError(
          'published_copy_mismatch',
          `published copy no longer matches its recorded hash: ${artifact.artifactId}`,
        );
      }
      return {
        bytes,
        contentHash,
        source: 'legacy_published_copy',
        // A drifted copy is no longer the published artifact.
        immutable: matches,
      };
    }
  }
}

/** Same spelling as `task-artifact-repo.hashContent`, so callers can compare. */
/** Rejects an oversized file before `readFile` materializes it in memory. */
async function assertBoundedSize(path: string, maxBytes?: number): Promise<void> {
  if (!maxBytes) return;
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) return;
  if (info.size > maxBytes) {
    throw new ArtifactContentError(
      'content_too_large',
      `artifact content exceeds the ${maxBytes} byte limit: ${path}`,
    );
  }
}

function hashBytes(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function normalizeHash(value: string): string {
  return value.replace(/^sha256:/u, '');
}

/**
 * Synchronous variant for context preparation, which must materialize handoff
 * inputs before the Executor starts. Same reference-kind rules as the async
 * variant; containment is re-checked with `realpathSync` so a live reference
 * cannot escape its Workspace.
 */
export function resolveArtifactContentSync(input: {
  artifact: TaskArtifactRecord;
  workspaceRoot?: string | null;
  artifactVersion?: ArtifactVersion | null;
  objectRoot?: string | null;
  resolvedPath?: string | null;
  /**
   * Roots a legacy copy must live under. Without this the recorded absolute
   * `publishedPath` would be trusted verbatim.
   */
  containmentRoots?: readonly string[];
  expectedAccountId?: string | null;
  expectedWorkspaceId?: string | null;
}): ResolvedArtifactContent {
  const { artifact } = input;
  if (artifact.referenceKind === 'artifact_version') {
    const version = input.artifactVersion;
    if (!version) {
      throw new ArtifactContentError(
        'artifact_version_missing',
        `artifact version is not registered: ${artifact.artifactVersionId ?? artifact.artifactId}`,
      );
    }
    if (!input.objectRoot) {
      throw new ArtifactContentError('artifact_object_missing', 'artifact object store is unavailable');
    }
    if (
      (input.expectedAccountId && version.accountId !== input.expectedAccountId)
      || (input.expectedWorkspaceId && version.workspaceId !== input.expectedWorkspaceId)
    ) {
      throw new ArtifactContentError(
        'artifact_version_scope_mismatch',
        `artifact version ${version.artifactVersionId} belongs to another account or Workspace`,
      );
    }
    let bytes:Buffer|null;
    try { bytes=version.gitCommit?readGitArtifact(version,input.objectRoot):readFileOrNullSync(join(input.objectRoot, version.contentHash)); }
    catch(error) { throw new ArtifactContentError('artifact_object_corrupt',String(error)); }
    if (!bytes) {
      throw new ArtifactContentError('artifact_object_missing', `artifact object is missing: ${version.contentHash}`);
    }
    const contentHash = hashBytes(bytes);
    if (normalizeHash(contentHash) !== normalizeHash(version.contentHash)) {
      throw new ArtifactContentError(
        'artifact_object_corrupt',
        `artifact object digest does not match its record: ${version.contentHash}`,
      );
    }
    return { bytes, contentHash, source: 'artifact_version', immutable: true };
  }
  if (artifact.referenceKind === 'live_file') {
    const relativePath = artifact.sourceRelativePath ?? artifact.relativePath;
    if (!artifact.workspaceId || !input.workspaceRoot) {
      throw new ArtifactContentError(
        'workspace_unavailable',
        `live artifact has no resolvable Workspace: ${artifact.artifactId}`,
      );
    }
    const absolutePath = resolveContainedFileSync(input.workspaceRoot, relativePath);
    const bytes = readFileSync(absolutePath);
    return { bytes, contentHash: hashBytes(bytes), source: 'live_file', immutable: false };
  }
  const publishedPath = input.resolvedPath
    ?? resolveContainedCopySync(artifact.publishedPath, input.containmentRoots);
  const publishedInfo = lstatSync(publishedPath, { throwIfNoEntry: false });
  if (!publishedInfo?.isFile() || publishedInfo.isSymbolicLink()) {
    throw new ArtifactContentError('published_copy_missing', `published copy is unavailable: ${artifact.artifactId}`);
  }
  const bytes = readFileOrNullSync(publishedPath);
  if (!bytes) {
    throw new ArtifactContentError('published_copy_missing', `published copy is missing: ${artifact.artifactId}`);
  }
  const contentHash = hashBytes(bytes);
  if (normalizeHash(artifact.contentHash) !== normalizeHash(contentHash)) {
    throw new ArtifactContentError(
      'published_copy_mismatch',
      `published copy no longer matches its recorded hash: ${artifact.artifactId}`,
    );
  }
  return { bytes, contentHash, source: 'legacy_published_copy', immutable: false };
}

function readFileOrNullSync(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * Legacy copies are recorded as absolute paths. Resolving them against the
 * authorized Workspace roots keeps a tampered row from reading arbitrary files.
 */
function resolveContainedCopySync(path: string, roots?: readonly string[]): string {
  if (!isAbsolute(path)) {
    throw new ArtifactContentError('published_copy_missing', `published copy path must be absolute: ${path}`);
  }
  if (!roots || roots.length === 0) {
    throw new ArtifactContentError(
      'published_copy_missing',
      `published copy has no authorized root to resolve against: ${path}`,
    );
  }
  const real = realpathSync(path);
  for (const root of roots) {
    const canonicalRoot = realpathSync(root);
    if (isWithin(canonicalRoot, real)) return real;
  }
  throw new ArtifactContentError(
    'published_copy_missing',
    `published copy escapes its authorized Workspace: ${path}`,
  );
}

function resolveContainedFileSync(root: string, relativePath: string): string {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).some(segment => segment === '..')) {
    throw new ArtifactContentError('workspace_unavailable', `unsafe workspace-relative path: ${relativePath}`);
  }
  const canonicalRoot = realpathSync(root);
  const requested = resolve(canonicalRoot, relativePath);
  if (!isWithin(canonicalRoot, requested)) {
    throw new ArtifactContentError('workspace_unavailable', `path escapes the Workspace: ${relativePath}`);
  }
  const info = lstatSync(requested, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new ArtifactContentError('workspace_unavailable', `Workspace file is unavailable: ${relativePath}`);
  }
  if (!isWithin(canonicalRoot, realpathSync(requested))) {
    throw new ArtifactContentError('workspace_unavailable', `resolved file escapes the Workspace: ${relativePath}`);
  }
  return requested;
}
