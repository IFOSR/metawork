/**
 * 同源 artifact 预览服务（Web Workspace 落地方案 Task 4）。
 *
 * Web 只提交 artifact ID，绝不提交文件路径。服务负责：
 * - Account/Task 归属校验；
 * - published path 的 realpath / 越界 / 符号链接校验；
 * - 只允许 `metaclaw-tasks` 用户产物根下已发布的可预览文件；
 * - 输出受限的 ArtifactProjection，不暴露内部绝对路径。
 */

import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { ArtifactVersionRepo } from '../storage/artifact-version-repo.js';
import type { TaskArtifactRecord } from '../storage/task-artifact-repo.js';
import { resolveArtifactContent } from '../delivery/artifact-content-resolver.js';
import { documentPreviewFormat, MAX_DOCUMENT_PREVIEW_BYTES } from '../delivery/document-preview-format.js';
import {
  USER_ARTIFACTS_DIRECTORY,
  resolvePreviewKind,
  type ArtifactProjection,
} from '../delivery/user-artifact-types.js';

export interface TaskArtifactSource {
  findById(artifactId: string):
    | LoadedArtifactRecord
    | null
    | Promise<LoadedArtifactRecord | null>;
}
export interface ArtifactPreviewQuery {
  /** 归属校验：artifact 必须属于当前授权账户与存在的任务。 */
  authorize(accountId: string, taskId: string): boolean;
  currentAccountId(): string;
}

export type ArtifactPreviewFailure =
  | 'not_found'
  | 'unauthorized'
  | 'unavailable'
  | 'unsupported';

export type ArtifactPreviewResult =
  | { ok: true; artifact: ArtifactProjection; content: string; renderedHtml?: string }
  | { ok: false; reason: ArtifactPreviewFailure };

export type ArtifactMetadataResult =
  | { ok: true; artifact: ArtifactProjection }
  | { ok: false; reason: ArtifactPreviewFailure };

export type ArtifactDownloadResult =
  | { ok: true; artifact: ArtifactProjection; absolutePath: string }
  | { ok: false; reason: ArtifactPreviewFailure };

interface LoadedArtifactRecord {
  accountId: string;
  taskId: string;
  publicationId: string | null;
  displayName: string;
  relativePath: string;
  publishedPath: string;
  mediaType: string;
  previewKind: string;
  contentHash: string;
  byteLength: number;
  status: string;
  createdAt: string;
  /** `live_file` is the current Workspace file; `artifact_version` is fixed. */
  referenceKind?: 'live_file' | 'artifact_version' | 'legacy_published_copy';
  workspaceId?: string | null;
  artifactVersionId?: string | null;
  sourceRelativePath?: string | null;
}

type LoadedArtifact =
  | { ok: true; record: LoadedArtifactRecord; projection: ArtifactProjection }
  | { ok: false; reason: ArtifactPreviewFailure };

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 16 * 1024 * 1024;
const IMAGE_PREVIEW_KINDS = new Set(['image']);

export class ArtifactPreviewService {
  constructor(private readonly deps: {
    taskArtifactSource: TaskArtifactSource;
    query: ArtifactPreviewQuery;
    /** 兼容默认根；生产 Server 也会提供 Conversation Workspace roots。 */
    userWorkspaceRoot?: string;
    userWorkspaceRoots?: () => Promise<string[]> | string[];
    /** Fixed content versions and the content-addressed store that holds them. */
    artifactVersionRepo?: ArtifactVersionRepo;
    objectRoot?: string;
    /**
     * Canonical directory of one Workspace id. A live reference must resolve
     * against *its own* Workspace, never "whichever root happens to hold that
     * relative path".
     */
    resolveWorkspaceRoot?: (workspaceId: string) => Promise<string | null> | string | null;
  }) {}

  private artifactAccountId(): string {
    return this.deps.query.currentAccountId();
  }

  /**
   * Reads bytes by reference kind. A fixed version always comes from the CAS, so
   * a later edit to the live file cannot change a historical preview or
   * download; a live reference reports its current hash instead of letting the
   * recorded hash authorize newer content.
   */
  private async readArtifactContent(record: LoadedArtifactRecord): Promise<
    | { ok: true; bytes: Buffer; contentHash: string; immutable: boolean }
    | { ok: false; reason: ArtifactPreviewFailure }
  > {
    const artifact = record as unknown as TaskArtifactRecord;
    try {
      const version = record.artifactVersionId && this.deps.artifactVersionRepo
        ? this.deps.artifactVersionRepo.find(record.artifactVersionId)
        : null;
      const referenceKind = record.referenceKind ?? 'legacy_published_copy';
      // Authorization happens here, before any bytes are read: a live file is
      // resolved inside an authorized Workspace, and a legacy copy must still
      // pass the historical `metaclaw-tasks` containment check.
      let resolvedPath: string | null = null;
      if (referenceKind === 'artifact_version') {
        resolvedPath = await this.fixedVersionPath(record);
      } else if (referenceKind === 'live_file') {
        resolvedPath = await this.resolveLiveFilePath(record);
      } else {
        resolvedPath = await this.safePublishedPath(record.publishedPath);
      }
      const content = await resolveArtifactContent({
        artifact: {
          ...artifact,
          referenceKind,
          workspaceId: record.workspaceId ?? null,
          artifactVersionId: record.artifactVersionId ?? null,
          sourceRelativePath: record.sourceRelativePath ?? null,
        },
        artifactVersion: version,
        objectRoot: this.deps.objectRoot ?? null,
        workspaceRoot: referenceKind === 'live_file'
          ? await this.resolveWorkspaceRootFor(record)
          : null,
        resolvedPath,
        expectedAccountId: this.artifactAccountId(),
        expectedWorkspaceId: record.workspaceId ?? null,
        // Previews report the current bytes; the strict copy digest check
        // belongs to handoff and download, where exactness is the contract.
        verifyPublishedCopyHash: false,
        maxBytes: this.maxPreviewBytesFor(record),
      });
      return { ok: true, bytes: content.bytes, contentHash: content.contentHash, immutable: content.immutable };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  /**
   * Live references are addressed by `workspaceId + sourceRelativePath`; the
   * absolute `publishedPath` is only a historical hint and is re-resolved
   * against the authorized Workspace so a moved file cannot be read from an
   * unverified location.
   */
  private async resolveLiveFilePath(record: LoadedArtifactRecord): Promise<string> {
    const relativePath = record.sourceRelativePath ?? record.relativePath;
    if (!record.workspaceId) {
      throw new Error(`live artifact has no Workspace identity: ${record.taskId}`);
    }
    const { assertWorkspaceRelativePath } = await import('../workspace/workspace-path.js');
    const ownerRoot = await this.deps.resolveWorkspaceRoot?.(record.workspaceId) ?? null;
    if (ownerRoot) {
      const canonicalOwner = await realpath(ownerRoot).catch(() => null);
      if (!canonicalOwner) throw new Error(`Workspace ${record.workspaceId} is unavailable`);
      const resolved = await assertWorkspaceRelativePath(canonicalOwner, relativePath);
      return resolved.absolutePath;
    }
    // Without a workspace-scoped resolver, accept a root only when exactly one
    // authorized root contains the path. Ambiguity is refused instead of
    // guessing, so a same-named file in another Workspace cannot be served.
    const matches: string[] = [];
    for (const root of await this.authorizedRoots()) {
      try {
        matches.push((await assertWorkspaceRelativePath(root, relativePath)).absolutePath);
      } catch {
        continue;
      }
    }
    if (matches.length !== 1) {
      throw new Error(`live artifact is not uniquely resolvable in Workspace ${record.workspaceId}`);
    }
    return matches[0]!;
  }

  /** Largest byte count any preview path may materialize for this projection. */
  private maxPreviewBytesFor(record: LoadedArtifactRecord): number {
    if (documentPreviewFormat(record.relativePath, record.mediaType)) return MAX_DOCUMENT_PREVIEW_BYTES;
    return resolvePreviewKind(record.previewKind, record.mediaType) === 'image'
      ? MAX_IMAGE_PREVIEW_BYTES
      : MAX_PREVIEW_BYTES;
  }

  /** The authorized Workspace root that contains a live reference, if any. */
  private async resolveWorkspaceRootFor(record: LoadedArtifactRecord): Promise<string | null> {
    const relativePath = record.sourceRelativePath ?? record.relativePath;
    if (!record.workspaceId) return null;
    const resolvedOwner = await this.deps.resolveWorkspaceRoot?.(record.workspaceId) ?? null;
    if (resolvedOwner) {
      return await realpath(resolvedOwner).catch(() => null);
    }
    for (const root of await this.authorizedRoots()) {
      try {
        const { assertWorkspaceRelativePath } = await import('../workspace/workspace-path.js');
        await assertWorkspaceRelativePath(root, relativePath);
        return root;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async authorizedRoots(): Promise<string[]> {
    const roots = [
      ...(this.deps.userWorkspaceRoot ? [this.deps.userWorkspaceRoot] : []),
      ...(await this.deps.userWorkspaceRoots?.() ?? []),
    ];
    const canonical: string[] = [];
    for (const root of roots) {
      const resolved = await realpath(root).catch(() => null);
      if (resolved && !canonical.includes(resolved)) canonical.push(resolved);
    }
    return canonical;
  }

  async getMetadata(artifactId: string): Promise<ArtifactMetadataResult> {
    const loaded = await this.loadAuthorized(artifactId);
    if (!loaded.ok) return loaded;
    const referenceKind = loaded.record.referenceKind ?? 'legacy_published_copy';
    try {
      // Live references are addressed by Workspace identity and relative path;
      // their historical published_path may be stale or absent. Resolve the
      // same authorized source used by preview/download instead of checking the
      // old absolute hint.
      if (referenceKind === 'artifact_version') await this.fixedVersionPath(loaded.record);
      else if (referenceKind === 'live_file') await this.resolveLiveFilePath(loaded.record);
      else await this.safePublishedPath(loaded.record.publishedPath);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, artifact: loaded.projection };
  }

  async readPreview(artifactId: string): Promise<ArtifactPreviewResult> {
    const loaded = await this.loadAuthorized(artifactId);
    if (!loaded.ok) return loaded;
    const { record: data, projection } = loaded;
    if (data.status !== 'published') return { ok: false, reason: 'unavailable' };
    if (!projection.documentFormat && !['markdown', 'text', 'code', 'image'].includes(projection.previewKind)) {
      return { ok: false, reason: 'unsupported' };
    }
    const sizeLimit = projection.documentFormat ? MAX_DOCUMENT_PREVIEW_BYTES : IMAGE_PREVIEW_KINDS.has(projection.previewKind)
      ? MAX_IMAGE_PREVIEW_BYTES
      : MAX_PREVIEW_BYTES;
    if (data.byteLength > sizeLimit) {
      return { ok: false, reason: 'unsupported' };
    }
    const content = await this.readArtifactContent(data);
    if (!content.ok) return { ok: false, reason: content.reason };
    if (content.bytes.byteLength > sizeLimit) return { ok: false, reason: 'unsupported' };
    // A live reference reports what the file holds now, not what the artifact
    // row recorded at publication time.
    const observed = content.immutable ? projection : {
      ...projection,
      contentHash: content.contentHash,
      byteLength: content.bytes.byteLength,
    };
    if (projection.documentFormat || IMAGE_PREVIEW_KINDS.has(projection.previewKind)) {
      return {
        ok: true,
        artifact: observed,
        content: `data:${data.mediaType};base64,${content.bytes.toString('base64')}`,
      };
    }
    return { ok: true, artifact: observed, content: content.bytes.toString('utf8') };
  }

  async resolveDownload(artifactId: string): Promise<ArtifactDownloadResult> {
    const loaded = await this.loadAuthorized(artifactId);
    if (!loaded.ok) return loaded;
    const { record: data, projection } = loaded;
    if (data.status !== 'published') return { ok: false, reason: 'unavailable' };
    const content = await this.readArtifactContent(data);
    if (!content.ok) return { ok: false, reason: content.reason };
    const referenceKind = data.referenceKind ?? 'legacy_published_copy';
    let absolutePath: string;
    try {
      // The returned path must be exactly the one the bytes came from.
      absolutePath = referenceKind === 'artifact_version'
        ? await this.fixedVersionPath(data)
        : referenceKind === 'live_file'
          ? await this.resolveLiveFilePath(data)
          : await this.safePublishedPath(data.publishedPath);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    const observed = content.immutable ? projection : {
      ...projection,
      contentHash: content.contentHash,
      byteLength: content.bytes.byteLength,
    };
    return { ok: true, artifact: observed, absolutePath };
  }

  private async fixedVersionPath(record: LoadedArtifactRecord): Promise<string> {
    const version = record.artifactVersionId && this.deps.artifactVersionRepo
      ? this.deps.artifactVersionRepo.find(record.artifactVersionId)
      : null;
    if (!version || !this.deps.objectRoot) throw new Error('fixed artifact version is unavailable');
    const path = resolve(this.deps.objectRoot, version.contentHash);
    const info = await lstat(path);
    if (!info.isFile()) throw new Error('fixed artifact object is not a regular file');
    return path;
  }

  /** Optional report illustrations, confined to the authorized report's directory. No network reads. */
  async readReportImage(artifactId: string, reference: string): Promise<string | undefined> {
    if (/^(?:[a-z][a-z\d+.-]*:|[\\/])/iu.test(reference)) return undefined;
    const source = await this.resolveDownload(artifactId);
    if (!source.ok) return undefined;
    try {
      const directory = dirname(source.absolutePath);
      const path = await this.safePublishedPath(resolve(directory, decodeURIComponent(reference.split('#')[0]!)));
      const rel = relative(directory, path);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > MAX_IMAGE_PREVIEW_BYTES) return undefined;
      const data = await readFile(path);
      const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
      if (!png && !jpeg) return undefined;
      return `data:image/${png ? 'png' : 'jpeg'};base64,${data.toString('base64')}`;
    } catch { return undefined; }
  }

  private async loadAuthorized(artifactId: string): Promise<LoadedArtifact> {
    if (!artifactId || artifactId.length > 200) return { ok: false, reason: 'not_found' };
    const record = await this.deps.taskArtifactSource.findById(artifactId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (
      record.accountId !== this.deps.query.currentAccountId()
      || !this.deps.query.authorize(record.accountId, record.taskId)
    ) {
      return { ok: false, reason: 'unauthorized' };
    }
    const previewKind = resolvePreviewKind(record.previewKind, record.mediaType);
    const documentFormat = documentPreviewFormat(record.relativePath, record.mediaType);
    return {
      ok: true,
      record,
      projection: {
        artifactId,
        taskId: record.taskId,
        publicationId: record.publicationId,
        displayName: record.displayName,
        relativePath: record.relativePath,
        mediaType: record.mediaType,
        previewKind,
        ...(documentFormat ? { documentFormat } : {}),
        previewable: record.status === 'published'
          && (Boolean(documentFormat) || ['markdown', 'text', 'code', 'image'].includes(previewKind)),
        byteLength: record.byteLength,
        contentHash: record.contentHash,
        publishedAt: record.createdAt,
      },
    };
  }

  /**
   * 校验路径落在已授权的用户 Workspace 内：先接受历史的
   * `<userWorkspaceRoot>/metaclaw-tasks` 副本，再接受就地交付的 live 文件
   * （Workspace 内任意相对路径）。两者都要求 realpath 后仍在根内，并拒绝
   * 符号链接逃逸；大小与内存上限在校验之后仍由各读取路径执行。
   */
  private async safePublishedPath(publishedPath: string): Promise<string> {
    if (!isAbsolute(publishedPath)) throw new Error('published path must be absolute');
    // Inspect the recorded path before resolving it. Checking lstat(realpath)
    // would erase evidence that the final path component was a symlink and
    // would allow an internal symlink to masquerade as a regular published file.
    const original = await lstat(publishedPath);
    if (original.isSymbolicLink()) throw new Error('published path must not be a symbolic link');
    if (!original.isFile()) throw new Error('published path must be a regular file');
    const real = await realpath(publishedPath);
    const roots = [
      ...(this.deps.userWorkspaceRoot ? [this.deps.userWorkspaceRoot] : []),
      ...(await this.deps.userWorkspaceRoots?.() ?? []),
    ];
    for (const root of roots) {
      const canonicalRoot = await realpath(root).catch(() => null);
      if (!canonicalRoot) continue;
      const candidates = [
        await realpath(resolve(canonicalRoot, USER_ARTIFACTS_DIRECTORY)).catch(() => null),
        canonicalRoot,
      ];
      for (const candidateRoot of candidates) {
        if (!candidateRoot) continue;
        const rel = relative(candidateRoot, real);
        if (!rel.startsWith('..') && !isAbsolute(rel)) {
          return real;
        }
      }
    }
    throw new Error('published path escapes the authorized Workspace');
  }
}
