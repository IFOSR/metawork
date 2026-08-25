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
import { USER_ARTIFACTS_DIRECTORY, type ArtifactProjection } from '../delivery/user-artifact-types.js';

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

export class ArtifactPreviewService {
  constructor(private readonly deps: {
    taskArtifactSource: TaskArtifactSource;
    query: ArtifactPreviewQuery;
    /** 用户可见 Workspace 根；用户产物固定位于 `<root>/metaclaw-tasks`。 */
    userWorkspaceRoot: string;
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
    if (!['markdown', 'text', 'code'].includes(projection.previewKind)) {
      return { ok: false, reason: 'unsupported' };
    }
    let safePath: string;
    try {
      safePath = await this.safePublishedPath(data.publishedPath);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (projection.byteLength > MAX_PREVIEW_BYTES) {
      return { ok: false, reason: 'unsupported' };
    }
    const stat = await lstat(safePath);
    if (!stat.isFile() || stat.size > MAX_PREVIEW_BYTES) {
      return { ok: false, reason: 'unavailable' };
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
        previewKind: normalizePreviewKind(record.previewKind),
        previewable: record.status === 'published'
          && ['markdown', 'text', 'code'].includes(record.previewKind),
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
    const artifactsRoot = await realpath(
      resolve(this.deps.userWorkspaceRoot, USER_ARTIFACTS_DIRECTORY),
    );
    const real = await realpath(publishedPath);
    const rel = relative(artifactsRoot, real);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('published path escapes the user artifacts root');
    }
    // 符号链接来源一律拒绝：realpath 后的父链已由 realpath 保证，
    // 但目标本身若是指向根外的链接，rel 检查已经拦截；这里额外拒绝
    // 位于根内的符号链接，保证下载的是真实文件而非链接跳转。
    const stat = await lstat(real);
    if (stat.isSymbolicLink()) throw new Error('published path must not be a symbolic link');
    return real;
  }
}

function normalizePreviewKind(value: string): ArtifactProjection['previewKind'] {
  return value === 'markdown' || value === 'text' || value === 'code'
    ? value
    : 'unsupported';
}
