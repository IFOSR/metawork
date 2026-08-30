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
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
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
  }) {}

  async getMetadata(artifactId: string): Promise<ArtifactMetadataResult> {
    const loaded = await this.loadAuthorized(artifactId);
    if (!loaded.ok) return loaded;
    if (!existsSync(loaded.record.publishedPath)) {
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, artifact: loaded.projection };
  }

  async readPreview(artifactId: string): Promise<ArtifactPreviewResult> {
    const loaded = await this.loadAuthorized(artifactId);
    if (!loaded.ok) return loaded;
    const { record: data, projection } = loaded;
    if (data.status !== 'published') return { ok: false, reason: 'unavailable' };
    if (!['markdown', 'text', 'code', 'image'].includes(projection.previewKind)) {
      return { ok: false, reason: 'unsupported' };
    }
    let safePath: string;
    try {
      safePath = await this.safePublishedPath(data.publishedPath);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    const sizeLimit = IMAGE_PREVIEW_KINDS.has(projection.previewKind)
      ? MAX_IMAGE_PREVIEW_BYTES
      : MAX_PREVIEW_BYTES;
    if (projection.byteLength > sizeLimit) {
      return { ok: false, reason: 'unsupported' };
    }
    const stat = await lstat(safePath);
    if (!stat.isFile() || stat.size > sizeLimit) {
      return { ok: false, reason: 'unavailable' };
    }
    if (IMAGE_PREVIEW_KINDS.has(projection.previewKind)) {
      const bytes = await readFile(safePath);
      return {
        ok: true,
        artifact: projection,
        content: `data:${data.mediaType};base64,${bytes.toString('base64')}`,
      };
    }
    const content = await readFile(safePath, 'utf8');
    return { ok: true, artifact: projection, content };
  }

  async resolveDownload(artifactId: string): Promise<ArtifactDownloadResult> {
    const loaded = await this.loadAuthorized(artifactId);
    if (!loaded.ok) return loaded;
    const { record: data, projection } = loaded;
    if (data.status !== 'published') return { ok: false, reason: 'unavailable' };
    let safePath: string;
    try {
      safePath = await this.safePublishedPath(data.publishedPath);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    const stat = await lstat(safePath);
    if (!stat.isFile()) return { ok: false, reason: 'unavailable' };
    return { ok: true, artifact: projection, absolutePath: safePath };
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
        previewable: record.status === 'published'
          && ['markdown', 'text', 'code', 'image'].includes(previewKind),
        byteLength: record.byteLength,
        contentHash: record.contentHash,
        publishedAt: record.createdAt,
      },
    };
  }

  /**
   * 校验已发布路径必须落在用户产物根内：realpath 解析后仍需位于
   * `<userWorkspaceRoot>/metaclaw-tasks` 下，拒绝穿越、符号链接逃逸
   * 与任意绝对路径。
   */
  private async safePublishedPath(publishedPath: string): Promise<string> {
    if (!isAbsolute(publishedPath)) throw new Error('published path must be absolute');
    const real = await realpath(publishedPath);
    const roots = [
      ...(this.deps.userWorkspaceRoot ? [this.deps.userWorkspaceRoot] : []),
      ...(await this.deps.userWorkspaceRoots?.() ?? []),
    ];
    for (const root of roots) {
      let artifactsRoot: string;
      try {
        artifactsRoot = await realpath(resolve(root, USER_ARTIFACTS_DIRECTORY));
      } catch {
        continue;
      }
      const rel = relative(artifactsRoot, real);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
        const stat = await lstat(real);
        if (stat.isSymbolicLink()) throw new Error('published path must not be a symbolic link');
        return real;
      }
    }
    throw new Error('published path escapes the user artifacts root');
  }
}
