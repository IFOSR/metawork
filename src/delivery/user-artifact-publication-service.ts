/**
 * 用户产物发布服务（Web Workspace 落地方案 Task 2）。
 *
 * 只有经过 Completion Protocol 验证、Git publication 成功并完成用户产物
 * 复制的文件才成为用户可见 artifact。服务把已集成的 artifact 从内部
 * Git integration workspace 原子复制到用户 Workspace 的
 * `metaclaw-tasks/<task-slug>-<short-task-id>/` 下，并生成安全的
 * `ArtifactProjection`。来源校验拒绝符号链接与路径穿越。
 */

import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  USER_ARTIFACTS_DIRECTORY,
  classifyPreviewKind,
  mediaTypeForRelativePath,
  type ArtifactProjection,
} from './user-artifact-types.js';
import {
  TaskArtifactRepo,
  hashContent,
  type TaskArtifactRecord,
} from '../storage/task-artifact-repo.js';

export interface UserArtifactSource {
  /** 已集成 workspace 内的相对路径（来自 Completion artifacts）。 */
  sourceRelativePath: string;
}

export interface PublishUserArtifactsInput {
  accountId: string;
  taskId: string;
  taskTitle: string;
  generationId: string | null;
  subtaskId: string | null;
  publicationId: string | null;
  /** Git 集成成功后的 workspace 根（只读来源）。 */
  integratedWorkspaceRoot: string;
  sources: UserArtifactSource[];
}

export interface UserArtifactPublicationResult {
  projections: ArtifactProjection[];
  taskDirectory: string;
  failures: Array<{ sourceRelativePath: string; reason: string }>;
}

export interface UserArtifactPublicationServiceDeps {
  /** 用户可见 Workspace 根（进程启动目录），进程生命周期内不变。 */
  userWorkspaceRoot: string;
  accountId?: string;
  taskArtifactRepo: TaskArtifactRepo;
  now?: () => string;
  /** 目录名短 ID 长度；默认取任务 ID 尾部 6 位。 */
  shortIdLength?: number;
}

const MAX_ARTIFACTS_PER_PUBLICATION = 100;
const MAX_SINGLE_ARTIFACT_BYTES = 64 * 1024 * 1024;

export function userTaskDirectorySlug(taskTitle: string, taskId: string): string {
  const normalized = taskTitle
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
    .replace(/-+$/gu, '');
  const shortId = taskId.replace(/[^A-Za-z0-9]/gu, '').slice(-6) || 'task';
  return `${normalized || 'task'}-${shortId}`;
}

export class UserArtifactPublicationService {
  private readonly now: () => string;
  private readonly shortIdLength: number;
  readonly taskArtifactRepo: TaskArtifactRepo;

  constructor(private readonly deps: UserArtifactPublicationServiceDeps) {
    this.taskArtifactRepo = deps.taskArtifactRepo;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.shortIdLength = deps.shortIdLength ?? 6;
  }

  get userWorkspaceRoot(): string {
    return this.deps.userWorkspaceRoot;
  }

  /**
   * 把一个已集成 publication 的 artifact 复制到用户 Workspace。
   * 幂等：同任务、同相对路径、同内容哈希的 artifact 直接复用既有记录，
   * 不重复复制。任何单个文件失败不阻塞其余文件，但会记录失败原因。
   */
  async publishIntegratedArtifacts(
    input: PublishUserArtifactsInput,
  ): Promise<UserArtifactPublicationResult> {
    const taskSlug = userTaskDirectorySlug(input.taskTitle, input.taskId);
    const taskDirectory = join(
      resolve(this.deps.userWorkspaceRoot),
      USER_ARTIFACTS_DIRECTORY,
      taskSlug,
    );
    const result: UserArtifactPublicationResult = {
      projections: [],
      taskDirectory,
      failures: [],
    };
    const sources = input.sources.slice(0, MAX_ARTIFACTS_PER_PUBLICATION);
    for (const source of sources) {
      try {
        const projection = await this.publishOne(
          input,
          source.sourceRelativePath,
          taskDirectory,
        );
        if (projection) result.projections.push(projection);
      } catch (error) {
        result.failures.push({
          sourceRelativePath: source.sourceRelativePath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  private async publishOne(
    input: PublishUserArtifactsInput,
    sourceRelativePath: string,
    taskDirectory: string,
  ): Promise<ArtifactProjection> {
    const workspaceRoot = await realpath(resolve(input.integratedWorkspaceRoot));
    const safeSource = this.safeJoinWithin(workspaceRoot, sourceRelativePath);
    const sourceStat = await lstat(safeSource);
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`artifact source must not be a symbolic link: ${sourceRelativePath}`);
    }
    if (!sourceStat.isFile()) {
      throw new Error(`artifact source is not a regular file: ${sourceRelativePath}`);
    }
    if (sourceStat.size > MAX_SINGLE_ARTIFACT_BYTES) {
      throw new Error(`artifact exceeds the size limit: ${sourceRelativePath}`);
    }

    const bytes = await readFile(safeSource);
    const contentHash = hashContent(bytes);
    const existing = this.taskArtifactRepo.findByTaskAndRelativePath(
      input.taskId,
      sourceRelativePath,
      contentHash,
    );
    if (existing && existsSync(existing.publishedPath)) {
      return this.taskArtifactRepo.toProjection(existing);
    }

    const targetPath = this.safeJoinWithin(taskDirectory, sourceRelativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    // 先写临时文件再原子 rename，避免半写状态对用户可见。
    const tempTarget = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await writeFile(tempTarget, bytes, { flag: 'wx' });
      await mkdir(dirname(targetPath), { recursive: true });
      await rename(tempTarget, targetPath);
    } catch (error) {
      await rm(tempTarget, { force: true }).catch(() => undefined);
      throw error;
    }

    const record = this.taskArtifactRepo.insert({
      accountId: input.accountId || this.deps.accountId || 'local-default',
      taskId: input.taskId,
      generationId: input.generationId,
      subtaskId: input.subtaskId,
      publicationId: input.publicationId,
      displayName: basename(sourceRelativePath),
      relativePath: sourceRelativePath,
      publishedPath: targetPath,
      mediaType: mediaTypeForRelativePath(sourceRelativePath),
      previewKind: classifyPreviewKind(sourceRelativePath),
      contentHash,
      byteLength: bytes.byteLength,
      status: 'published',
      now: this.now(),
    });
    this.taskArtifactRepo.markSupersededExcept(
      input.taskId,
      sourceRelativePath,
      record.artifactId,
      this.now(),
    );
    return this.taskArtifactRepo.toProjection(record);
  }

  /** 拒绝绝对路径、路径穿越和越界目标；返回解析后的安全绝对路径。 */
  private safeJoinWithin(root: string, relativePath: string): string {
    if (!relativePath || relativePath.includes('\0')) {
      throw new Error('artifact path is empty or invalid');
    }
    if (isAbsolute(relativePath)) {
      throw new Error(`artifact path must be relative: ${relativePath}`);
    }
    const resolved = resolve(root, relativePath);
    const rel = relative(root, resolved);
    if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`artifact path escapes the workspace root: ${relativePath}`);
    }
    return resolved;
  }
}
