import type { WorkspaceGitService } from '../execution/workspace-git-service.js';
import { withWorkspacePublicationLock } from './workspace-publication-lock.js';
import { containsInternalRuntimePath } from '../utils/public-text.js';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, chmod } from 'node:fs/promises';
import { publishPublicGitChanges } from './public-workspace-git.js';
import { assertWorkspaceRelativePath, WorkspacePathError } from '../workspace/workspace-path.js';
import { ArtifactVersionRepo, type ArtifactVersion } from '../storage/artifact-version-repo.js';
/**
 * Writes one content-addressed object atomically. A crash mid-write leaves a
 * temporary file, never a truncated object at the final digest path, and an
 * existing object is verified instead of being trusted because it exists.
 */
async function writeContentAddressedObject(
  objectRoot: string,
  contentHash: string,
  bytes: Buffer,
): Promise<void> {
  const objectPath = join(objectRoot, contentHash);
  try {
    await writeFile(objectPath, bytes, { flag: 'wx', mode: 0o600 });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const existing = await readFile(objectPath).catch(() => null);
  if (existing && createHash('sha256').update(existing).digest('hex') === contentHash) return;
  // Repair a corrupted or truncated object through a temporary file + rename.
  const temporary = `${objectPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  await rename(temporary, objectPath);
}

/**
 * 用户产物发布服务（Web Workspace 落地方案 Task 2）。
 *
 * 只有经过 Completion Protocol 验证、Git publication 成功并完成用户产物
 * 复制的文件才成为用户可见 artifact。服务把已集成的 artifact 从内部
 * Git integration workspace 原子应用到当前 Conversation 绑定的用户
 * Workspace 根（或用户明确选择的项目子目录），并生成安全的
 * `ArtifactProjection`。来源校验拒绝符号链接与路径穿越。
 */

import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
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
  /** Optional path relative to the selected delivery project in the user Workspace. */
  destinationRelativePath?: string;
  remove?: boolean;
  /** Code publication is independent of explicitly declared downloadable files. */
  downloadable?: boolean;
}

export interface PublishUserArtifactsInput {
  sessionId?: string;
  accountId: string;
  taskId: string;
  taskTitle: string;
  /**
   * Workspace-relative directory that receives the authorized change set.
   * `null`/absent means the Workspace root, which is the normal case: Worktree
   * publication applies only the authorized files at their declared paths and
   * never creates a generated `metaclaw-tasks/<slug>` directory.
   */
  deliveryRelativeRoot?: string | null;
  publicDeliveryBaseline?: Record<string, string>;
  generationId: string | null;
  subtaskId: string | null;
  publicationId: string | null;
  /** Git 集成成功后的 workspace 根（只读来源）。 */
  integratedWorkspaceRoot: string;
  /** 当前 Conversation 选择的用户 Workspace；优先于固定默认根。 */
  userWorkspaceRoot?: string;
  sources: UserArtifactSource[];
}

export interface UserArtifactPublicationResult {
  projections: ArtifactProjection[];
  taskDirectory: string;
  failures: Array<{ sourceRelativePath: string; reason: string }>;
}

export interface UserArtifactPublicationServiceDeps {
  /** 测试/兼容组合的固定默认根；生产组合可按 session 动态解析。 */
  userWorkspaceRoot?: string;
  resolveUserWorkspaceRoot?: (
    sessionId: string,
  ) => Promise<string | null> | string | null;
  accountId?: string;
  taskArtifactRepo: TaskArtifactRepo;
  /** Content-addressed object root for fixed artifact versions (Runtime-owned). */
  objectRoot?: string;
  artifactVersionRepo?: ArtifactVersionRepo;
  now?: () => string;
}

const MAX_ARTIFACTS_PER_PUBLICATION = 2000;
const MAX_SINGLE_ARTIFACT_BYTES = 64 * 1024 * 1024;

export { userTaskDirectorySlug } from '../task/public-task-directory.js';

export class UserArtifactPublicationService {
  private readonly now: () => string;
  readonly taskArtifactRepo: TaskArtifactRepo;

  constructor(private readonly deps: UserArtifactPublicationServiceDeps) {
    this.taskArtifactRepo = deps.taskArtifactRepo;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  get userWorkspaceRoot(): string {
    return this.deps.userWorkspaceRoot ?? '';
  }

  /**
   * 把一个已集成 publication 的 artifact 复制到用户 Workspace。
   * 幂等：同任务、同相对路径、同内容哈希的 artifact 直接复用既有记录，
   * 不重复复制。整批预检失败时不写入任何文件，并记录失败原因。
   */
  async publishIntegratedArtifacts(
    input: PublishUserArtifactsInput,
  ): Promise<UserArtifactPublicationResult> {
    const userWorkspaceRoot = input.userWorkspaceRoot
      ?? (input.sessionId
        ? await this.deps.resolveUserWorkspaceRoot?.(input.sessionId)
        : undefined)
      ?? this.deps.userWorkspaceRoot;
    if (!userWorkspaceRoot) {
      throw new Error(`Conversation ${input.sessionId ?? '<unknown>'} has no selected Workspace`);
    }
    const canonicalRoot = await realpath(resolve(userWorkspaceRoot));
    return withWorkspacePublicationLock(canonicalRoot, () => this.publishLocked(input, canonicalRoot));
  }

  /** Prepare immutable blobs and pins before the terminal DB transaction. Registration runs inside it. */
  async prepareGitArtifacts(input:{git:WorkspaceGitService;repositoryPath:string;commit:string;accountId:string;workspaceId:string;taskId:string;attemptId:string;generationId:string;subtaskId:string;relativePaths:readonly string[]}):Promise<{commit:()=>void;versions:ArtifactVersion[]}> {
    const repo=this.deps.artifactVersionRepo;if(!repo)throw new Error('artifact_version_repository_missing');
    const entries=new Map((await input.git.entries(input.repositoryPath,input.commit)).map(entry=>[entry.path,entry]));
    const versions:ArtifactVersion[]=[];
    for(const path of [...new Set(input.relativePaths)]) {
      const entry=entries.get(path);if(!entry||entry.kind!=='file')throw new Error(`git_artifact_file_missing:${path}`);
      const bytes=await input.git.blob(input.repositoryPath,entry.oid);
      if(bytes.length>MAX_SINGLE_ARTIFACT_BYTES)throw new Error(`artifact_content_too_large:${path}`);
      const contentHash=createHash('sha256').update(bytes).digest('hex');
      const existing=repo.findByContent(input.workspaceId,path,contentHash);
      const version:ArtifactVersion=existing??{artifactVersionId:`artifact_version_${randomUUID()}`,accountId:input.accountId,workspaceId:input.workspaceId,
        sourceTaskId:input.taskId,sourceAttemptId:input.attemptId,relativePath:path,contentHash,byteLength:bytes.length,
        objectUri:`git-object:${input.workspaceId}:${input.commit}:${encodeURIComponent(path)}`,gitCommit:input.commit,gitRelativePath:path,
        mediaType:mediaTypeForRelativePath(path),createdAt:this.now()};
      if(version.gitCommit)await input.git.updateRef(input.repositoryPath,`refs/metawork/artifacts/${version.artifactVersionId}`,version.gitCommit);
      versions.push(version);
    }
    return {versions,commit:()=>{
      for(const candidate of versions) {
        const version=repo.record(candidate);
        const existing=this.taskArtifactRepo.listByTask(input.taskId).find(a=>a.relativePath===version.relativePath&&a.contentHash.replace(/^sha256:/u,'')===version.contentHash);
        if(existing){this.taskArtifactRepo.linkArtifactVersion(existing.artifactId,version.artifactVersionId,this.now());continue;}
        this.taskArtifactRepo.insert({accountId:input.accountId,taskId:input.taskId,generationId:input.generationId,subtaskId:input.subtaskId,
          displayName:basename(version.relativePath),relativePath:version.relativePath,publishedPath:'',mediaType:version.mediaType,
          previewKind:classifyPreviewKind(version.relativePath),contentHash:`sha256:${version.contentHash}`,byteLength:version.byteLength,
          referenceKind:'artifact_version',workspaceId:input.workspaceId,artifactVersionId:version.artifactVersionId,sourceRelativePath:version.relativePath,now:this.now()});
      }
    }};
  }

  /**
   * Fixed content for cross-Task handoffs, historical downloads and audit: the
   * bytes are written to the Runtime's content-addressed store, and the artifact
   * row stops being a live reference. Ordinary rounds never call this.
   */
  async materializeArtifactVersions(input: {
    sessionId?: string;
    accountId: string;
    workspaceId: string;
    taskId: string;
    attemptId: string | null;
    /** Overrides the Workspace root, e.g. a worktree Task's delivery directory. */
    workspaceRoot?: string;
    relativePaths: readonly string[];
  }): Promise<ArtifactVersion[]> {
    const repo = this.deps.artifactVersionRepo;
    const objectRoot = this.deps.objectRoot;
    if (!repo || !objectRoot || input.relativePaths.length === 0) return [];
    const root = input.workspaceRoot ?? (input.sessionId
      ? await this.deps.resolveUserWorkspaceRoot?.(input.sessionId) ?? this.deps.userWorkspaceRoot
      : this.deps.userWorkspaceRoot);
    if (!root) throw new Error('Workspace is unavailable for fixed artifact versions');
    const canonicalRoot = await realpath(resolve(root));
    await mkdir(objectRoot, { recursive: true, mode: 0o700 });
    const versions: ArtifactVersion[] = [];
    for (const relativePath of [...new Set(input.relativePaths)]) {
      // A declared handoff path must be pinnable. Silently skipping it would
      // publish a round whose cross-Task handoff later degrades to live content
      // or disappears, so a vanished file fails the delivery instead.
      const resolved = await assertWorkspaceRelativePath(canonicalRoot, relativePath).catch(error => {
        if (error instanceof WorkspacePathError && error.code === 'not_found') {
          throw new Error(`handoff path disappeared before it could be pinned: ${relativePath}`);
        }
        throw error;
      });
      const bytes = await readFile(resolved.absolutePath);
      const contentHash = createHash('sha256').update(bytes).digest('hex');
      await writeContentAddressedObject(objectRoot, contentHash, bytes);
      const version = repo.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sourceTaskId: input.taskId,
        sourceAttemptId: input.attemptId,
        relativePath: resolved.relativePath,
        contentHash,
        byteLength: bytes.length,
        objectUri: `sha256:${contentHash}`,
        mediaType: mediaTypeForRelativePath(resolved.relativePath),
      });
      versions.push(version);
      const artifact = this.taskArtifactRepo.listByTask(input.taskId)
        .find(item => item.relativePath === resolved.relativePath && item.contentHash.endsWith(contentHash));
      if (artifact) this.taskArtifactRepo.linkArtifactVersion(artifact.artifactId, version.artifactVersionId, this.now());
    }
    return versions;
  }

  /**
   * Registers in-place deliverables as live references. Nothing is copied: the
   * artifact points at the file the Executor already wrote inside the user's
   * Workspace, so a later round that edits the same file is visible as the
   * current state instead of a stale duplicate.
   */
  async registerLiveWorkspaceReferences(input: {
    sessionId?: string;
    /** Canonical Workspace root chosen by the caller (lease target). */
    workspaceRoot?: string;
    accountId: string;
    taskId: string;
    taskTitle: string;
    workspaceId: string;
    generationId: string | null;
    subtaskId: string | null;
    publicationId: string | null;
    /**
     * `remove` marks a path the Executor deleted, `downloadable: false` marks a
     * change that is not a declared deliverable (scratch, logs, undeclared build
     * output). Neither may be registered as a live artifact.
     */
    sources: Array<{ sourceRelativePath: string; remove?: boolean; downloadable?: boolean }>;
  }): Promise<UserArtifactPublicationResult> {
    const userWorkspaceRoot = input.workspaceRoot
      ?? (input.sessionId ? await this.deps.resolveUserWorkspaceRoot?.(input.sessionId) : undefined);
    const root = userWorkspaceRoot ?? this.deps.userWorkspaceRoot;
    if (!root) {
      throw new Error(`Conversation ${input.sessionId ?? '<unknown>'} has no selected Workspace`);
    }
    const canonicalRoot = await realpath(resolve(root));
    return withWorkspacePublicationLock(canonicalRoot, async () => {
      const result: UserArtifactPublicationResult = { projections: [], taskDirectory: canonicalRoot, failures: [] };
      for (const source of input.sources.slice(0, MAX_ARTIFACTS_PER_PUBLICATION)) {
        // A deleted path has no bytes to reference, and an undeclared change is
        // not a deliverable. Both stay in the change record, not in artifacts.
        if (source.remove || source.downloadable === false) continue;
        try {
          const resolved = await assertWorkspaceRelativePath(canonicalRoot, source.sourceRelativePath);
          const bytes = await readFile(resolved.absolutePath);
          if (bytes.length > MAX_SINGLE_ARTIFACT_BYTES) {
            throw new Error(`交付文件无效或过大：${source.sourceRelativePath}`);
          }
          const contentHash = hashContent(bytes);
          // Replays and retries hit UNIQUE(account, task, relativePath,
          // contentHash). Adopt the existing row instead of failing the round.
          const existing = this.taskArtifactRepo.listByTask(input.taskId)
            .find(item => item.accountId === input.accountId
              && item.relativePath === resolved.relativePath
              && item.referenceKind === 'live_file'
              && item.contentHash === contentHash);
          const record = existing ?? this.taskArtifactRepo.insert({
            accountId: input.accountId,
            taskId: input.taskId,
            generationId: input.generationId,
            subtaskId: input.subtaskId,
            publicationId: input.publicationId,
            displayName: basename(source.sourceRelativePath),
            relativePath: source.sourceRelativePath,
            publishedPath: resolved.absolutePath,
            mediaType: mediaTypeForRelativePath(source.sourceRelativePath),
            previewKind: classifyPreviewKind(source.sourceRelativePath),
            contentHash,
            byteLength: bytes.length,
            status: 'published',
            referenceKind: 'live_file',
            workspaceId: input.workspaceId,
            sourceRelativePath: resolved.relativePath,
            now: this.now(),
          });
          this.taskArtifactRepo.publicFiles.record({
            accountId: input.accountId,
            taskId: input.taskId,
            generationId: input.generationId,
            subtaskId: input.subtaskId,
            publicationId: input.publicationId,
            relativePath: source.sourceRelativePath,
            publishedPath: resolved.absolutePath,
            contentHash,
            updatedAt: this.now(),
          });
          result.projections.push(this.taskArtifactRepo.toProjection(record));
        } catch (error) {
          result.failures.push({
            sourceRelativePath: source.sourceRelativePath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return result;
    });
  }

  private async publishLocked(input: PublishUserArtifactsInput, canonicalRoot: string): Promise<UserArtifactPublicationResult> {
    const taskDirectory = input.deliveryRelativeRoot
      ? this.safeJoinWithin(canonicalRoot, input.deliveryRelativeRoot)
      : canonicalRoot;
    await rejectSymlinkParents(canonicalRoot, taskDirectory);
    const result: UserArtifactPublicationResult = {
      projections: [],
      taskDirectory,
      failures: [],
    };
    const sources = input.sources.slice(0, MAX_ARTIFACTS_PER_PUBLICATION);
    for (const source of input.sources.slice(MAX_ARTIFACTS_PER_PUBLICATION)) {
      result.failures.push({ sourceRelativePath: source.sourceRelativePath, reason: 'publication artifact count exceeds limit' });
    }
    // Validate the entire batch before making any visible change. The last
    // published hash is the baseline; a user's edit is never overwritten.
    for (const source of sources) {
      try {
        await this.preflight(
          input,
          source.sourceRelativePath,
          taskDirectory,
          source.remove,
          source.destinationRelativePath,
        );
      }
      catch (error) { result.failures.push({ sourceRelativePath: source.sourceRelativePath,
        reason: error instanceof Error ? error.message : String(error) }); }
    }
    if (result.failures.length) return result;
    // Stage every byte before touching the public tree. Roll back an ordinary
    // filesystem write failure as a batch; SQLite registration follows the
    // complete filesystem commit so an interrupted save can be adopted safely.
    const stagedRoot = await mkdtemp(resolve(tmpdir(), 'metawork-delivery-'));
    const changes: Array<{ path: string; source: string | null; executable: boolean }> = [];
    const backups: Array<{ path: string; bytes: Buffer | null; mode: number }> = [];
    try {
      for (const [index, source] of sources.entries()) {
        const destinationPath = source.destinationRelativePath ?? source.sourceRelativePath;
        const path = this.safeJoinWithin(taskDirectory, destinationPath);
        const origin = this.safeJoinWithin(await realpath(input.integratedWorkspaceRoot), source.sourceRelativePath);
        const mode = source.remove ? 0o644 : (await lstat(origin)).mode & 0o777;
        const stage = resolve(stagedRoot, String(index));
        if (!source.remove) await writeFile(stage, await readFile(origin), { mode });
        try { backups.push({ path, bytes: await readFile(path), mode: (await lstat(path)).mode & 0o777 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; backups.push({ path, bytes: null, mode }); }
        const backup = backups.at(-1)!;
        if (source.remove ? backup.bytes !== null : backup.bytes === null
          || !backup.bytes.equals(await readFile(stage)) || Boolean(backup.mode & 0o111) !== Boolean(mode & 0o111)) {
          changes.push({ path, source: source.remove ? null : stage, executable: Boolean(mode & 0o111) });
        }
      }
      // The staging directory is intentionally outside the Git Workspace, so
      // it cannot contaminate status checks or become a delivered file.
      for (const source of sources) {
        await this.preflight(
          input,
          source.sourceRelativePath,
          taskDirectory,
          source.remove,
          source.destinationRelativePath,
        );
      }
      if (!await publishPublicGitChanges(canonicalRoot, input.taskId, changes)) {
        const absent = !await lstat(taskDirectory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (absent) {
          await mkdir(dirname(taskDirectory), { recursive: true });
          const tree = await mkdtemp(resolve(dirname(taskDirectory), '.metawork-delivery-'));
          try {
            for (const change of changes) {
              if (!change.source) continue;
              const target = this.safeJoinWithin(tree, relative(taskDirectory, change.path));
              await mkdir(dirname(target), { recursive: true });
              await copyFile(change.source, target);
              await chmod(target, change.executable ? 0o755 : 0o644);
            }
            await rename(tree, taskDirectory);
          } finally { await rm(tree, { recursive: true, force: true }); }
        } else {
          let written = 0;
          try {
            for (const change of changes) {
              await rejectSymlinkParents(canonicalRoot, change.path);
              if (change.source) {
                await mkdir(dirname(change.path), { recursive: true });
                const temporary = `${change.path}.metawork-${randomUUID()}`;
                try {
                  await copyFile(change.source, temporary);
                  await chmod(temporary, change.executable ? 0o755 : 0o644);
                  await rename(temporary, change.path);
                } finally { await rm(temporary, { force: true }); }
              }
              else await rm(change.path, { force: true });
              written++;
            }
          } catch (error) {
            for (const backup of changes.slice(0, written).reverse().map(change => backups.find(item => item.path === change.path)!)) {
              if (backup.bytes === null) await rm(backup.path, { force: true });
              else { const temp = `${backup.path}.metawork-restore-${randomUUID()}`; await writeFile(temp, backup.bytes, { mode: backup.mode }); await rename(temp, backup.path); }
            }
            throw error;
          }
        }
      }
    } catch (error) {
      result.failures.push({ sourceRelativePath: '', reason: error instanceof Error ? error.message : '公开交付失败' });
      return result;
    } finally { await rm(stagedRoot, { recursive: true, force: true }); }
    for (const source of sources) {
      try {
        const destinationPath = source.destinationRelativePath ?? source.sourceRelativePath;
        await this.preflight(
          input,
          source.sourceRelativePath,
          taskDirectory,
          source.remove,
          destinationPath,
        );
        if (source.remove) {
          this.taskArtifactRepo.publicFiles.remove(input.accountId, input.taskId, destinationPath);
          await rm(this.safeJoinWithin(taskDirectory, destinationPath), { force: true });
          for (const record of this.taskArtifactRepo.listByTask(input.taskId).filter(item => item.relativePath === destinationPath)) {
            this.taskArtifactRepo.markUnavailable(record.artifactId, this.now());
          }
          continue;
        }
        const publishedPath = this.safeJoinWithin(taskDirectory, destinationPath);
        const contentHash = hashContent(await readFile(publishedPath));
        this.taskArtifactRepo.publicFiles.record({ accountId: input.accountId, taskId: input.taskId,
          generationId: input.generationId, subtaskId: input.subtaskId, publicationId: input.publicationId,
          relativePath: destinationPath, publishedPath,
          contentHash, updatedAt: this.now() });
        if (source.downloadable === false) {
          for (const record of this.taskArtifactRepo.listByTask(input.taskId)) {
            if (record.relativePath === destinationPath && record.contentHash !== contentHash) {
              this.taskArtifactRepo.markUnavailable(record.artifactId, this.now());
            }
          }
          continue;
        }
        const projection = await this.publishOne(
          input,
          source.sourceRelativePath,
          taskDirectory,
          destinationPath,
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

  private async preflight(
    input: PublishUserArtifactsInput,
    sourcePath: string,
    taskDirectory: string,
    remove = false,
    destinationPath = sourcePath,
  ): Promise<void> {
    const root = await realpath(resolve(input.integratedWorkspaceRoot));
    const source = this.safeJoinWithin(root, sourcePath);
    await rejectSymlinkParents(root, source);
    const info = remove ? null : await lstat(source);
    if (info && (!info.isFile() || info.size > MAX_SINGLE_ARTIFACT_BYTES)) throw new Error(`交付文件无效或过大：${sourcePath}`);
    const sourceBytes = remove ? null : await readFile(source);
    if (sourceBytes && !sourceBytes.includes(0) && containsInternalRuntimePath(sourceBytes.toString('utf8'))) {
      throw new Error(`交付文件包含内部执行路径，请修正后重新发布：${sourcePath}`);
    }
    const expected = sourceBytes ? hashContent(sourceBytes) : null;
    const target = this.safeJoinWithin(taskDirectory, destinationPath);
    await rejectSymlinkParents(taskDirectory, target);
    let actual: string;
    try { actual = hashContent(await readFile(target)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const baseline = [...this.taskArtifactRepo.publicFiles.list(input.accountId, input.taskId), ...this.taskArtifactRepo.listByTask(input.taskId)].find(record => record.relativePath === destinationPath
        && record.status === 'published' && record.publishedPath === target);
      if (!remove && (baseline || input.publicDeliveryBaseline?.[destinationPath])) {
        throw new Error(`发布冲突，文件已被删除：${destinationPath}`);
      }
      return;
    }
    if (actual === expected) return;
    const baseline = [...this.taskArtifactRepo.publicFiles.list(input.accountId, input.taskId), ...this.taskArtifactRepo.listByTask(input.taskId)]
      .find(record => record.relativePath === destinationPath && record.status === 'published' && record.publishedPath === target);
    if (actual !== (baseline?.contentHash ?? input.publicDeliveryBaseline?.[destinationPath])) throw new Error(`发布冲突，文件已被修改：${destinationPath}`);
  }

  private async publishOne(
    input: PublishUserArtifactsInput,
    sourceRelativePath: string,
    taskDirectory: string,
    destinationRelativePath = sourceRelativePath,
  ): Promise<ArtifactProjection> {
    const workspaceRoot = await realpath(resolve(input.integratedWorkspaceRoot));
    const safeSource = this.safeJoinWithin(workspaceRoot, sourceRelativePath);
    await rejectSymlinkParents(workspaceRoot, safeSource);
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
      destinationRelativePath,
      contentHash,
    );
    if (
      existing
      && existing.status === 'published'
      && await isPublishedArtifactIntact(existing.publishedPath, contentHash)
    ) {
      return this.taskArtifactRepo.toProjection(existing);
    }

    const targetPath = this.safeJoinWithin(taskDirectory, destinationRelativePath);
    await rejectSymlinkParents(taskDirectory, targetPath);
    // A crash may leave the complete file without its SQLite row. Verify its
    // bytes before adopting it, so recovery only registers that durable copy.
    if (!await isPublishedArtifactIntact(targetPath, contentHash)) {
      await mkdir(dirname(targetPath), { recursive: true });
      const tempTarget = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await writeFile(tempTarget, bytes, { flag: 'wx', mode: sourceStat.mode & 0o777 });
        await rename(tempTarget, targetPath);
      } catch (error) {
        await rm(tempTarget, { force: true }).catch(() => undefined);
        throw error;
      }
    }

    const now = this.now();
    const record = existing
      ? (this.taskArtifactRepo.markPublished(existing.artifactId, targetPath, now),
        this.taskArtifactRepo.findById(existing.artifactId))
      : this.taskArtifactRepo.insert({
          accountId: input.accountId || this.deps.accountId || 'local-default',
          taskId: input.taskId,
          generationId: input.generationId,
          subtaskId: input.subtaskId,
          publicationId: input.publicationId,
          displayName: basename(destinationRelativePath),
          relativePath: destinationRelativePath,
          publishedPath: targetPath,
          mediaType: mediaTypeForRelativePath(destinationRelativePath),
          previewKind: classifyPreviewKind(destinationRelativePath),
          contentHash,
          byteLength: bytes.byteLength,
          status: 'published',
          now,
        });
    if (!record) throw new Error(`artifact record disappeared: ${sourceRelativePath}`);
    this.taskArtifactRepo.markSupersededExcept(
      input.taskId,
      destinationRelativePath,
      record.artifactId,
      now,
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

async function isPublishedArtifactIntact(
  publishedPath: string,
  expectedHash: string,
): Promise<boolean> {
  try {
    const info = await lstat(publishedPath);
    if (info.isSymbolicLink() || !info.isFile()) return false;
    return hashContent(await readFile(publishedPath)) === expectedHash;
  } catch {
    return false;
  }
}

/** Reject every existing ancestor, including the leaf; realpath alone hides links. */
async function rejectSymlinkParents(root: string, target: string): Promise<void> {
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('交付路径超出 Workspace');
  let current = root;
  for (const segment of ['', ...rel.split(sep)]) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('交付路径不能包含符号链接');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
