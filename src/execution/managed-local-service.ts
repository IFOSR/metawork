import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, realpath, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, relative, dirname, isAbsolute, sep } from 'node:path';

import { localServiceSpecificationRevision } from '../task/local-service.js';
import { discoverLaunchSpecification } from './local-service-discovery.js';
import { resolveRunTargetCandidates } from './run-target.js';
import type { LocalServiceSpecification, LocalServiceRecord, LocalServiceStore, LocalServiceView, LocalServiceOperation, LocalServiceEffect } from '../task/local-service.js';
import { publicText } from '../utils/public-text.js';
import { createServer } from 'node:net';
export type { LocalServiceSpecification, LocalServiceRecord, LocalServiceStore, LocalServiceView } from '../task/local-service.js';

export const LOCAL_SERVICE_SPECIFICATION_FILENAME = '.metawork-service.json';
export const PUBLISHED_CODE_MISSING_SERVICE_SPECIFICATION =
  `代码已发布，但任务目录中没有可启动的服务规格（${LOCAL_SERVICE_SPECIFICATION_FILENAME}）`;

const execFileAsync = promisify(execFile);
// The wrapper remains the process-group leader, so ownership survives Server
// restart. Commands never pass through a shell; the token is never a credential.
const SERVICE_HOST = `import { spawn } from 'node:child_process';
const child = spawn(process.argv[2], JSON.parse(process.argv[3]), { stdio: 'inherit' });
child.on('error', () => process.exit(127));
child.on('exit', code => {
  // The command may have left grandchildren behind. This wrapper owns its
  // detached group; close it before losing the ownership witness.
  try { process.kill(-process.pid, 'SIGKILL'); } catch {}
  process.exit(code ?? 1);
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));`;

/**
 * Allocate a loopback port for a discovered contract. The process receives it as
 * `PORT`, so the Runtime can report its address without guessing the project's
 * default. A discovered contract has no health check, so an app that ignores
 * `PORT` is still reported as `running` — never as healthy.
 */
export function allocateLoopbackPort(host: '127.0.0.1' | '::1'): Promise<number | null> {
  return new Promise(resolvePort => {
    const probe = createServer();
    probe.once('error', () => resolvePort(null));
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : null;
      probe.close(() => resolvePort(port));
    });
  });
}

/** Normalize a Workspace-relative project directory; rejects traversal. */
export function normalizeTargetPath(value: string): string {
  const unified = value.replaceAll('\\', '/').replace(/^\.\//u, '');
  const segments = unified.split('/').filter(segment => segment !== '' && segment !== '.');
  if (unified.startsWith('/') || /^[a-zA-Z]:/u.test(unified) || segments.includes('..')) {
    throw new Error('目标项目路径必须是 Workspace 内的相对目录');
  }
  return segments.join('/');
}

export function validateLocalServiceSpecification(value: unknown): LocalServiceSpecification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务规格无效');
  const s = value as LocalServiceSpecification;
  const portValid = s.port === null || s.port === undefined
    || (Number.isInteger(s.port) && s.port >= 1 && s.port <= 65535);
  const healthPathValid = s.healthPath === null || s.healthPath === undefined
    || (typeof s.healthPath === 'string' && s.healthPath.startsWith('/') && !s.healthPath.startsWith('//'));
  const origin = s.origin ?? 'manifest';
  // An explicit manifest must declare its contract. Only a discovered launch may
  // omit port/health, because the project itself is the evidence. A manifest
  // may still declare them as explicit `null` ("no port/health check").
  const declaredManifestContract = origin !== 'manifest'
    || (s.port !== undefined && s.healthPath !== undefined);
  if (typeof s.serviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(s.serviceId) || typeof s.taskId !== 'string' || !s.taskId
    || typeof s.command !== 'string' || !s.command || s.command.includes('\0')
    || !Array.isArray(s.args) || s.args.length > 100 || JSON.stringify(s.args).length > 32000 || s.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
    || !['127.0.0.1', '::1'].includes(s.host) || !portValid || !healthPathValid
    || !Number.isInteger(s.startupTimeoutMs) || s.startupTimeoutMs < 100 || s.startupTimeoutMs > 60_000
    || s.restartPolicy !== 'explicit' || !s.environmentReferences || typeof s.environmentReferences !== 'object' || Array.isArray(s.environmentReferences)
    || !['manifest', 'discovered'].includes(origin)
    || !declaredManifestContract
    || Object.entries(s.environmentReferences).some(([key, ref]) => !/^[A-Z_][A-Z0-9_]*$/u.test(key)
      || ['HOST', 'PORT'].includes(key) || typeof ref !== 'string' || !ref)
    || (s.directory !== undefined && (typeof s.directory !== 'string' || isAbsolute(s.directory)
      || s.directory.split(/[\\/]/u).includes('..')))) throw new Error('服务规格无效：请检查命令、环境引用、监听地址和健康检查');
  return { serviceId: s.serviceId, taskId: s.taskId, command: s.command, args: [...s.args],
    ...(s.directory === undefined ? {} : { directory: s.directory }),
    environmentReferences: { ...s.environmentReferences }, host: s.host,
    port: s.port === undefined ? null : s.port,
    healthPath: s.healthPath === undefined ? null : s.healthPath,
    startupTimeoutMs: s.startupTimeoutMs, restartPolicy: 'explicit', origin };
}

/** Runtime owns processes; Storage owns durable facts; Kernel authorizes calls. */
export class ManagedLocalServices {
  private readonly operations = new Map<string, Promise<unknown>>();
  /** Last observed exit/health facts, keyed by service id. Runtime-only. */
  private readonly lastDiagnostics = new Map<
    string,
    {
      /** Revision the observation belongs to; a new contract starts clean. */
      specificationRevision: string;
      exitObserved: boolean;
      healthStatus: number | null;
      retryable: boolean;
    }
  >();

  private diagnosticsKey(serviceId: string, workspaceId: string | null | undefined): string {
    return `${workspaceId ?? ''}\u0000${serviceId}`;
  }

  private storageToken(serviceId: string, workspaceId: string | null | undefined): string {
    return createHash('sha256')
      .update(`${this.deps.accountId}\u0000${workspaceId ?? ''}\u0000${serviceId}`)
      .digest('hex')
      .slice(0, 32);
  }
  constructor(private readonly deps: {
    accountId: string;
    /** Workspace identity of the owning service set, when the host knows it. */
    workspaceId?: string;
    store: LocalServiceStore;
    logRoot: string;
    resolvePublishedDirectory(taskId: string): Promise<string | null>;
    /** Workspace identity the service belongs to, for (account, workspace, service) keys. */
    resolveWorkspaceId?(taskId: string): Promise<string | null> | string | null;
    isPublishedServiceSpecification?(taskId: string, root: string, relativePath: string): Promise<boolean>;
    resolveEnvironment(reference: string): Promise<string | null>;
    /**
     * Workspace-relative paths this Task delivered. They are the durable facts
     * that identify the target project of a follow-up run.
     */
    listTaskArtifactPaths?(taskId: string): Promise<string[]>;
    /** Workspace-relative paths authorized for this Task's writes. */
    listTaskTargetPaths?(taskId: string): Promise<string[]>;
    /** Allocate the loopback port a discovered contract hands to the process. */
    selectFreePort?(host: '127.0.0.1' | '::1'): Promise<number | null>;
  }) {}

  find(serviceId: string): LocalServiceRecord | null { return this.deps.store.find(serviceId); }

  listForService(serviceId: string): LocalServiceRecord[] {
    return this.deps.store.list().filter(record => (
      record.accountId === this.deps.accountId
      && record.specification.serviceId === serviceId
    ));
  }

  /**
   * Workspace-scoped service identity: `(accountId, workspaceId, serviceId)`.
   * Every Runtime start/reconcile path resolves the service this way so a record
   * that belongs to another Workspace can never block, bless or be mutated by
   * the current Task (2026-10-27 realignment §4.1).
   */
  findForWorkspace(workspaceId: string | null, serviceId: string): LocalServiceRecord | null {
    if (workspaceId !== null) return this.lookup(serviceId, workspaceId);
    return this.deps.workspaceId
      ? this.lookup(serviceId, this.deps.workspaceId)
      : this.deps.store.find(serviceId);
  }

  /**
   * Workspace the service belongs to; service identity includes it. Tasks that
   * predate Workspace bindings use the empty segment, which the Kernel treats as
   * "unscoped" rather than as a different Workspace.
   */
  async resolveServiceWorkspaceId(taskId: string): Promise<string> {
    return await this.deps.resolveWorkspaceId?.(taskId) ?? this.deps.workspaceId ?? '';
  }

  forTask(taskId: string): LocalServiceRecord[] {
    return this.deps.store.list().filter(record => record.accountId === this.deps.accountId && record.specification.taskId === taskId);
  }

  /**
   * True when this Workspace already registered the identical launch contract
   * for `spec.serviceId` under the Task that authored the manifest.
   */
  private async inheritedSpecification(
    taskId: string,
    spec: LocalServiceSpecification,
  ): Promise<boolean> {
    const workspaceId = await this.resolveServiceWorkspaceId(taskId);
    const registered = this.lookup(spec.serviceId, workspaceId);
    return Boolean(
      registered
      && registered.specification.taskId === spec.taskId
      && registered.specificationRevision === localServiceSpecificationRevision(spec),
    );
  }

  async readSpecification(
    taskId: string,
    options: { allowRevisionChange?: boolean } = {},
  ): Promise<LocalServiceSpecification> {
    const root = await this.resolveReadableRoot(taskId);
    return this.readManifestAt(taskId, root, join(root, LOCAL_SERVICE_SPECIFICATION_FILENAME), options);
  }

  /**
   * Resolve the launch contract for a follow-up run.
   *
   * Priority (2026-10-28 transparent execution §optional service specification):
   *  1. the target project's own manifest, when one exists;
   *  2. the recorded contract of the same target project in this Workspace;
   *  3. a launch discovered from the project itself (package scripts, entry).
   *
   * A Workspace-root manifest is only used when the Task delivered no project
   * artifact of its own. That is what keeps an old service file from becoming
   * the target of a newly delivered project.
   */
  async resolveServiceSpecification(input: {
    taskId: string;
    serviceId?: string;
    targetPath?: string;
    allowRevisionChange?: boolean;
  }): Promise<{
    specification: LocalServiceSpecification;
    source: 'manifest' | 'registered' | 'discovered';
    targetPath: string;
    evidence: string[];
  }> {
    const root = await this.resolveReadableRoot(input.taskId);
    const canonicalRoot = await realpath(root);
    const evidence: string[] = [];
    const artifactPaths = await this.deps.listTaskArtifactPaths?.(input.taskId) ?? [];
    const observedManifests: string[] = [];
    const rootManifest = join(canonicalRoot, LOCAL_SERVICE_SPECIFICATION_FILENAME);
    const rootManifestInfo = await lstat(rootManifest).catch(() => null);
    if (rootManifestInfo?.isFile()) observedManifests.push(LOCAL_SERVICE_SPECIFICATION_FILENAME);
    const taskTargetPaths = await this.deps.listTaskTargetPaths?.(input.taskId) ?? [];
    const targetDirectories = await this.resolveTaskTargetDirectories(canonicalRoot, taskTargetPaths);
    for (const targetDirectory of targetDirectories) {
      const candidateManifest = join(canonicalRoot, targetDirectory, LOCAL_SERVICE_SPECIFICATION_FILENAME);
      if ((await lstat(candidateManifest).catch(() => null))?.isFile()) {
        observedManifests.push(join(targetDirectory, LOCAL_SERVICE_SPECIFICATION_FILENAME));
      }
    }
    const hasNonRootTaskTarget = targetDirectories.some(path => path !== '');
    const selectionManifests = hasNonRootTaskTarget
      ? observedManifests.filter(path => path !== LOCAL_SERVICE_SPECIFICATION_FILENAME)
      : observedManifests;
    const targetPath = input.targetPath !== undefined
      ? normalizeTargetPath(input.targetPath)
      : await this.selectRunTarget({
          root: canonicalRoot,
          artifactPaths,
          manifestPaths: selectionManifests,
          taskTargetPaths: targetDirectories,
          serviceIdHint: input.serviceId,
          evidence,
        });
    if (targetPath !== '') {
      const candidateManifest = join(canonicalRoot, targetPath, LOCAL_SERVICE_SPECIFICATION_FILENAME);
      const info = await lstat(candidateManifest).catch(() => null);
      if (info?.isFile()) observedManifests.push(join(targetPath, LOCAL_SERVICE_SPECIFICATION_FILENAME));
    }
    const manifestPath = join(canonicalRoot, targetPath, LOCAL_SERVICE_SPECIFICATION_FILENAME);
    if ((await lstat(manifestPath).catch(() => null))?.isFile()) {
      try {
        const specification = await this.readManifestAt(input.taskId, canonicalRoot, manifestPath, {
          allowRevisionChange: input.allowRevisionChange,
        });
        return {
          // A project-local manifest without `directory` runs from the project
          // directory that contained it. Keeping it undefined would make the
          // later launch validation re-read the unrelated Workspace-root file
          // and would start the command from the wrong cwd.
          specification: specification.directory === undefined && targetPath !== ''
            ? { ...specification, directory: targetPath }
            : specification,
          source: 'manifest', targetPath, evidence,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A malformed or stale manifest is diagnosis, not a dead end: report it
        // and keep resolving the target project from its recorded contract or
        // its own files. Ownership and revision refusals stay refusals.
        if (!message.startsWith('服务规格文件无效')
          && !message.startsWith('服务规格无效')
          && message !== PUBLISHED_CODE_MISSING_SERVICE_SPECIFICATION
          && message !== '服务规格不属于当前任务') throw error;
        evidence.push(`目标项目的服务规格不可用，已改为检查项目本身：${message}`);
      }
    }
    if (targetPath !== '' && rootManifestInfo?.isFile()) {
      // The root file belongs to whatever was delivered there. Reading it here
      // would hand a new project the old project's command and port.
      evidence.push('已忽略 Workspace 根目录的服务规格：它不是当前目标项目的规格');
    }
    // A contract recorded for this exact project is the authoritative launch
    // description: its command, port and directory are the ones the process was
    // actually started with, so a stop/restart/健康检查 round keeps the same
    // revision instead of minting a new one.
    const workspaceId = await this.resolveServiceWorkspaceId(input.taskId);
    const registered = this.deps.store.list().filter(record => (
      record.accountId === this.deps.accountId
      && (record.workspaceId ?? '') === (workspaceId || '')
      && record.specification.origin === 'discovered'
      && (record.specification.directory ?? '') === targetPath
      && (!input.serviceId || record.specification.serviceId === input.serviceId)
    ))[0];
    if (registered) {
      evidence.push(`复用已记录的目标项目服务契约：${registered.specification.serviceId}`);
      return {
        // The launch contract revision excludes task provenance. Rebind that
        // provenance to the current follow-up so Kernel validates the request
        // against the requesting Task and the service record hands over on use.
        specification: { ...registered.specification, taskId: input.taskId },
        source: 'registered',
        targetPath,
        evidence,
      };
    }
    const discovered = await discoverLaunchSpecification({
      root: canonicalRoot,
      targetPath,
      serviceIdHint: input.serviceId,
    });
    evidence.push(...discovered.diagnostics);
    if (!discovered.launch) {
      throw new Error(
        `未找到目标项目的服务规格，也无法从项目确定启动方式（${targetPath || 'Workspace 根目录'}）`
        + (discovered.diagnostics.length > 0 ? `：${discovered.diagnostics.join('；')}` : ''),
      );
    }
    const port = await (this.deps.selectFreePort?.(this.discoveredHost()) ?? allocateLoopbackPort(this.discoveredHost()));
    const specification = validateLocalServiceSpecification({
      serviceId: discovered.launch.serviceId,
      taskId: input.taskId,
      command: discovered.launch.command,
      args: discovered.launch.args,
      directory: discovered.launch.directory,
      environmentReferences: {},
      host: this.discoveredHost(),
      port,
      healthPath: null,
      startupTimeoutMs: 10_000,
      restartPolicy: 'explicit',
      origin: 'discovered',
    });
    evidence.push(`已从项目发现启动方式：${discovered.launch.evidence}`);
    return { specification, source: 'discovered', targetPath, evidence };
  }

  private discoveredHost(): '127.0.0.1' | '::1' {
    return '127.0.0.1';
  }

  private async resolveReadableRoot(taskId: string): Promise<string> {
    const root = await this.deps.resolvePublishedDirectory(taskId);
    if (!root) throw new Error('代码尚未发布到用户任务目录');
    return root;
  }

  private async selectRunTarget(input: {
    root: string;
    artifactPaths: readonly string[];
    manifestPaths: readonly string[];
    taskTargetPaths: readonly string[];
    serviceIdHint?: string;
    evidence: string[];
  }): Promise<string> {
    const candidates = resolveRunTargetCandidates({
      artifactPaths: input.artifactPaths,
      manifestPaths: input.manifestPaths,
    });
    if (candidates.length === 0 && input.taskTargetPaths.length > 0) {
      // In-place edits may have no downloadable artifact rows. The authorized
      // target paths are still durable evidence of which Workspace project the
      // Task changed; inspect those paths before considering a root-level legacy
      // manifest. This prevents an unrelated old service from becoming the
      // fallback target.
      const discoveredTargets = new Set<string>();
      const normalizedTargets = [...new Set(input.taskTargetPaths)];
      for (const targetPath of normalizedTargets) {
        const manifest = join(input.root, targetPath, LOCAL_SERVICE_SPECIFICATION_FILENAME);
        if ((await lstat(manifest).catch(() => null))?.isFile()) {
          discoveredTargets.add(targetPath);
          continue;
        }
        const result = await discoverLaunchSpecification({
          root: input.root,
          targetPath,
          serviceIdHint: input.serviceIdHint,
        });
        if (result.launch) discoveredTargets.add(targetPath);
      }
      if (discoveredTargets.size > 0) {
        const listed = [...discoveredTargets].sort();
        if (listed.length > 1) {
          input.evidence.push(`运行目标不唯一：${listed.join('、')}`);
          throw new Error(`运行目标不唯一，需要明确指定项目：${listed.join('、')}`);
        }
        return listed[0]!;
      }
      // A single authorized target is more informative than the Workspace
      // root, even if discovery will later report that it is not runnable.
      if (normalizedTargets.length === 1) return normalizedTargets[0]!;
      if (normalizedTargets.length > 1) {
        input.evidence.push(`无法从多个目标路径确定唯一服务项目：${normalizedTargets.join('、')}`);
        throw new Error(`运行目标不唯一，需要明确指定项目：${normalizedTargets.join('、')}`);
      }
    }
    if (candidates.length === 0) return '';
    if (candidates.length > 1) {
      const listed = candidates.map(candidate => candidate.targetPath || 'Workspace 根目录');
      input.evidence.push(`运行目标不唯一：${listed.join('、')}`);
      throw new Error(`运行目标不唯一，需要明确指定项目：${listed.join('、')}`);
    }
    return candidates[0]!.targetPath;
  }

  /** Resolve declared target files to their containing project directories. */
  private async resolveTaskTargetDirectories(root: string, paths: readonly string[]): Promise<string[]> {
    const directories = new Set<string>();
    for (const path of paths) {
      const normalized = normalizeTargetPath(path);
      if (!normalized) { directories.add(''); continue; }
      const info = await lstat(join(root, normalized)).catch(() => null);
      const directory = info?.isDirectory() ? normalized : dirname(normalized).split(sep).join('/');
      directories.add(directory === '.' ? '' : directory);
    }
    return [...directories].sort();
  }

  private async readManifestAt(
    taskId: string,
    root: string,
    path: string,
    options: { allowRevisionChange?: boolean } = {},
  ): Promise<LocalServiceSpecification> {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new Error(PUBLISHED_CODE_MISSING_SERVICE_SPECIFICATION);
      }
      throw new Error('服务规格文件无效');
    }
    const relativePath = relative(root, path).split(sep).join('/');
    if (this.deps.isPublishedServiceSpecification
      && !await this.deps.isPublishedServiceSpecification(taskId, root, relativePath)) {
      throw new Error(PUBLISHED_CODE_MISSING_SERVICE_SPECIFICATION);
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('服务规格文件无效');
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new Error('服务规格文件无效');
    }
    const bound = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
      ? { taskId, ...manifest, origin: 'manifest' as const } : manifest;
    const spec = validateLocalServiceSpecification(bound);
    if (spec.taskId !== taskId) {
      // An in-place Workspace keeps the manifest a previous Task wrote. That
      // file is not foreign code when this Workspace already registered the
      // very same launch contract for this service id: the current Task then
      // takes the service over (2026-10-27 realignment §4.2/§8). A manifest
      // whose contract was never registered here still belongs to its author.
      const inherited = await this.inheritedSpecification(taskId, spec);
      if (!inherited) throw new Error('服务规格不属于当前任务');
      return { ...spec, taskId };
    }
    // A spec that was already authorized keeps its revision. A rewritten
    // manifest is not a new authorization, so it must not be picked up by a
    // later round that merely re-reads the file.
    const authorizedRevision = this.deps.store.findAuthorizedRevision?.(
      this.deps.accountId,
      taskId,
      spec.serviceId,
    );
    if (!options.allowRevisionChange
      && authorizedRevision
      && authorizedRevision !== localServiceSpecificationRevision(spec)) {
      throw new Error('服务规格已被修改；需要显式的服务更新授权');
    }
    return spec;
  }

  async verifyPublishedFiles(taskId: string, files: readonly { relativePath: string; contentHash: string }[]): Promise<void> {
    const root = await this.deps.resolvePublishedDirectory(taskId);
    if (!root || files.length === 0) throw new Error('缺少可核实的已交付成果');
    const canonical = await realpath(root);
    for (const file of files) {
      const path = await realpath(resolve(root, file.relativePath));
      const rel = relative(canonical, path);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('成果越过授权目录');
      const hash = `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
      if (hash !== file.contentHash) throw new Error(`成果已改变，需要重新规划：${file.relativePath}`);
    }
  }

  async isPublished(taskId: string): Promise<boolean> { return Boolean(await this.deps.resolvePublishedDirectory(taskId)); }


  async recover(): Promise<void> {
    for (const record of this.deps.store.list()) {
      await this.status(record.specification.serviceId, record.workspaceId);
    }
  }

  applyAuthorizedOperation(input: {
    decisionId: string;
    operation: LocalServiceOperation;
    serviceId: string;
    specification?: LocalServiceSpecification;
    /** Workspace and revision the Kernel authorized for this operation. */
    workspaceId?: string;
    specificationRevision?: string;
    turnId?: string;
  }): Promise<LocalServiceEffect> {
    const workspaceSegment = input.workspaceId ?? this.deps.workspaceId ?? '';
    return this.serialize(input.serviceId, workspaceSegment, async () => {
      const store = this.deps.store;
      // A start/stop decision names one Workspace. Reading it back through the
      // composite identity keeps an identically named service in another
      // Workspace out of this operation entirely.
      const scoped = (serviceId: string) => this.lookup(serviceId, workspaceSegment);
      let effect = store.findOperation(input.decisionId);
      if (effect && (effect.serviceId !== input.serviceId || effect.operation !== input.operation)) {
        throw new Error('服务操作身份不匹配');
      }
      if (effect?.phase === 'completed') return effect;
      if (!effect) {
        effect = { decisionId: input.decisionId, serviceId: input.serviceId, operation: input.operation,
          turnId: input.turnId ?? null,
          phase: input.operation === 'start' ? 'starting' : 'stopping',
          initialToken: scoped(input.serviceId)?.processToken ?? null, result: null, error: null };
        store.saveOperation(effect);
      }
      try {
        if (input.operation === 'update') {
          // Explicit authorization to bind a different specification revision.
          // Only a stopped service may be re-authorized; the process token is
          // cleared so the next start cannot reuse the previous launch.
          const current = scoped(input.serviceId);
          if (!current) throw new Error('服务不存在，无法更新授权规格');
          if (await this.ownedProcess(current)) throw new Error('请先停止服务再更新授权规格');
          const nextRevision = input.specification
            ? localServiceSpecificationRevision(input.specification)
            : (input.specificationRevision ?? '');
          if (!nextRevision) throw new Error('服务更新缺少目标规格 revision');
          store.save({
            ...current,
            workspaceId: input.workspaceId ?? current.workspaceId,
            specificationRevision: nextRevision,
            specification: input.specification ?? current.specification,
            state: 'stopped',
            processId: null,
            processToken: null,
            healthMessage: null,
            updatedAt: new Date().toISOString(),
          }, { allowSpecificationChange: true });
          effect.result = this.view(scoped(input.serviceId)!);
          effect.phase = 'completed';
          store.saveOperation(effect);
          return effect;
        }
        if (effect.phase === 'stopping') {
          effect.result = await this.stopNow(input.serviceId, workspaceSegment);
          effect.phase = input.operation === 'stop' ? 'completed' : 'starting';
          effect.initialToken = null;
          store.saveOperation(effect);
        }
        if (effect.phase === 'starting') {
          const record = scoped(input.serviceId);
          // A new token proves this decision already attempted a launch. A
          // process that subsequently exited is observed, never repeated.
          effect.result = record?.processToken && record.processToken !== effect.initialToken
            ? await this.check(record)
            : await this.startNow(input.specification
              ?? this.requireScoped(input.serviceId, workspaceSegment).specification);
          effect.phase = 'completed';
        }
      } catch (error) {
        effect.phase = 'completed';
        effect.error = error instanceof Error ? error.message : '服务操作失败';
      }
      store.saveOperation(effect);
      return effect;
    });
  }

  async start(specification: LocalServiceSpecification): Promise<LocalServiceView> {
    const spec = validateLocalServiceSpecification(specification);
    const workspaceId = await this.resolveServiceWorkspaceId(spec.taskId);
    return this.serialize(spec.serviceId, workspaceId, () => this.startNow(spec));
  }

  private lookup(serviceId: string, workspaceId: string): LocalServiceRecord | null {
    const scoped = this.deps.store.findInWorkspace;
    if (!scoped) return this.deps.store.find(serviceId);
    const inWorkspace = scoped.call(this.deps.store, workspaceId, serviceId);
    if (inWorkspace) return inWorkspace;
    // Rows written before Workspace bindings live in the empty segment, which
    // this codebase spells as "unscoped" rather than "another Workspace".
    return workspaceId === '' ? null : scoped.call(this.deps.store, '', serviceId);
  }

  private async startNow(spec: LocalServiceSpecification): Promise<LocalServiceView> {
      // A manifest-sourced contract must still match the manifest in the
      // published directory: the authorized operation supplies the exact
      // specification it may execute, and a rewritten file is not a new
      // authorization. A discovered contract has no manifest to re-read; its
      // evidence was the project itself, which `resolveServiceSpecification`
      // already resolved under Workspace containment.
      if ((spec.origin ?? 'manifest') === 'manifest') {
        const root = await this.resolveReadableRoot(spec.taskId);
        const canonicalRoot = await realpath(root);
        const manifestPath = join(canonicalRoot, spec.directory ?? '', LOCAL_SERVICE_SPECIFICATION_FILENAME);
        await this.readManifestAt(spec.taskId, canonicalRoot, manifestPath);
      }
      const requestedRevision = localServiceSpecificationRevision(spec);
      // The launch is authorized for exactly this revision. `readSpecification`
      // already rejects a manifest that drifted from the authorized revision, so
      // a rewritten `.metawork-service.json` cannot become the new launch spec
      // without an explicit update decision.
      const workspaceId = await this.resolveServiceWorkspaceId(spec.taskId);
      // The current specification decides whether a launch is needed. A record
      // left `failed`/`stopped` by an earlier round is a historical fact: it is
      // observed and diagnosed, never a reason to skip this round's start.
      const previous = this.lookup(spec.serviceId, workspaceId);
      if (previous && previous.accountId !== this.deps.accountId) throw new Error('服务不存在');
      if (previous && previous.specificationRevision !== requestedRevision) {
        throw new Error('服务标识已绑定其他启动规格');
      }
      // Same launch contract: a process that is still running is observed, and
      // one that already exited is started again for the current Task.
      if (previous && await this.ownedProcess(previous)) {
        const observed = await this.check(previous);
        if (previous.specification.taskId !== spec.taskId) {
          // The live process now belongs to this Task's service specification;
          // ownership follows the current Task instead of the historical one.
          this.deps.store.save({
            ...previous,
            specification: spec,
            specificationRevision: requestedRevision,
          });
        }
        return observed;
      }
      if (spec.port !== null) {
        const port = spec.port;
        await new Promise<void>((accept, reject) => {
          const probe = createServer();
          probe.once('error', reject);
          probe.listen(port, spec.host, () => probe.close(error => error ? reject(error) : accept()));
        });
      }
      const root = await this.deps.resolvePublishedDirectory(spec.taskId);
      if (!root) throw new Error('代码尚未发布到用户任务目录，不能启动服务');
      const canonicalRoot = await realpath(root);
      const cwd = resolve(canonicalRoot, spec.directory ?? '.');
      const rel = relative(canonicalRoot, cwd);
      if (isAbsolute(rel) || rel.split(sep).includes('..')) throw new Error('服务目录超出公开任务目录');
      let parent = canonicalRoot;
      for (const segment of rel.split(sep).filter(Boolean)) {
        parent = join(parent, segment);
        if ((await lstat(parent)).isSymbolicLink()) throw new Error('服务目录不能包含符号链接');
      }
      // Only a declared port becomes an environment fact. A contract with no
      // port must not receive a fabricated PORT the process would trust.
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG };
      if (spec.port !== null) {
        env.HOST = spec.host;
        env.PORT = String(spec.port);
      }
      for (const [key, ref] of Object.entries(spec.environmentReferences)) {
        const value = await this.deps.resolveEnvironment(ref);
        if (value === null) throw new Error(`环境引用不可用：${key}`);
        env[key] = value;
      }
      await mkdir(this.deps.logRoot, { recursive: true, mode: 0o700 });
      const storageToken = this.storageToken(spec.serviceId, workspaceId);
      const token = `metawork-service-${randomUUID()}`;
      const record: LocalServiceRecord = {
        accountId: this.deps.accountId,
        workspaceId: workspaceId || null,
        specificationRevision: requestedRevision,
        specification: spec,
        state: 'starting',
        processId: null,
        processToken: token,
        healthMessage: '正在启动',
        updatedAt: new Date().toISOString(),
      };
      this.deps.store.save(record);
      const log = await open(join(this.deps.logRoot, `${storageToken}.log`), 'a', 0o600);
      try {
        const child = spawn(process.execPath, ['--input-type=module', '-e', SERVICE_HOST, token, spec.command, JSON.stringify(spec.args)],
          { cwd, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
        await new Promise<void>((accept, reject) => { child.once('spawn', accept); child.once('error', reject); });
        record.processId = child.pid!;
        child.unref();
        this.deps.store.save(record);
      } catch {
        record.state = 'failed'; record.healthMessage = '启动进程失败'; this.deps.store.save(record);
        this.lastDiagnostics.set(this.diagnosticsKey(record.specification.serviceId, record.workspaceId), {
          specificationRevision: record.specificationRevision,
          exitObserved: true, healthStatus: null, retryable: true,
        });
        return this.view(record);
      } finally { await log.close(); }
      if (spec.healthPath === null) {
        // No health check was declared: the only available fact is whether the
        // process stayed alive through the bounded startup window. That is
        // `running`, never a fabricated `healthy`.
        const deadline = Date.now() + Math.min(spec.startupTimeoutMs, 2_000);
        do {
          const view = await this.check(record);
          if (view.state === 'failed') return view;
          if (Date.now() + 250 >= deadline) return view;
          await new Promise(accept => setTimeout(accept, 250));
        } while (Date.now() < deadline);
        return this.check(record);
      }
      const deadline = Date.now() + spec.startupTimeoutMs;
      do {
        const view = await this.check(record);
        if (view.state === 'healthy' || view.state === 'failed') return view;
        await new Promise(accept => setTimeout(accept, 100));
      } while (Date.now() < deadline);
      // A bounded startup deadline that is still unhealthy is a definite
      // failure: stop the process this task started and record the reason
      // instead of keeping "waiting for health" as a completion blocker.
      await this.stopNow(spec.serviceId, workspaceId);
      const timedOut = this.requireScoped(spec.serviceId, workspaceId);
      timedOut.state = 'failed';
      timedOut.healthMessage = 'service_health_timeout';
      timedOut.updatedAt = new Date().toISOString();
      this.deps.store.save(timedOut);
      // Keep the last real HTTP answer: a 503 (or any non-2xx) is exactly the
      // repair input the next round needs. Only the timeout verdict is new.
      const lastTimeoutAnswer = this.lastDiagnostics.get(
        this.diagnosticsKey(timedOut.specification.serviceId, timedOut.workspaceId),
      );
      this.lastDiagnostics.set(this.diagnosticsKey(timedOut.specification.serviceId, timedOut.workspaceId), {
        specificationRevision: timedOut.specificationRevision,
        exitObserved: false,
        healthStatus: lastTimeoutAnswer?.specificationRevision === timedOut.specificationRevision
          ? lastTimeoutAnswer.healthStatus
          : null,
        retryable: true,
      });
      return this.view(timedOut);
  }

  async status(serviceId: string, workspaceId?: string | null): Promise<LocalServiceView> {
    const scope = this.operationWorkspace(serviceId, workspaceId);
    return this.serialize(serviceId, scope, async () => {
      const record = this.requireScoped(serviceId, scope);
      if (record.state === 'stopped') return this.view(record);
      return this.check(record);
    });
  }

  async stop(serviceId: string, workspaceId?: string | null): Promise<LocalServiceView> {
    const scope = this.operationWorkspace(serviceId, workspaceId);
    return this.serialize(serviceId, scope, () => this.stopNow(serviceId, scope));
  }

  private async stopNow(serviceId: string, workspaceId: string): Promise<LocalServiceView> {
      const record = this.requireScoped(serviceId, workspaceId);
      if (await this.ownedProcess(record)) {
        const group = -record.processId!;
        process.kill(group, 'SIGTERM');
        // Ownership was proved before signalling. Keep checking the group:
        // its leader may exit before a grandchild that ignores SIGTERM.
        const groupAlive = () => { try { process.kill(group, 0); return true; } catch { return false; } };
        const deadline = Date.now() + 3_000;
        while (groupAlive() && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 50));
        if (groupAlive()) { try { process.kill(group, 'SIGKILL'); } catch { /* Group exited. */ } }
      }
      record.state = 'stopped'; record.healthMessage = '服务已停止，代码交付保留'; record.processId = null;
      record.processToken = null; record.updatedAt = new Date().toISOString(); this.deps.store.save(record);
      return this.view(record);
  }

  async restart(serviceId: string, workspaceId?: string | null): Promise<LocalServiceView> {
    const scope = this.operationWorkspace(serviceId, workspaceId);
    return this.serialize(serviceId, scope, async () => {
      const spec = this.requireScoped(serviceId, scope).specification;
      await this.stopNow(serviceId, scope);
      return this.startNow(spec);
    });
  }

  async logs(serviceId: string, workspaceId?: string | null): Promise<string> {
    const scope = this.operationWorkspace(serviceId, workspaceId);
    return (await this.readLogTail(this.requireScoped(serviceId, scope), 64 * 1024)) ?? '暂无服务日志';
  }

  /**
   * Redacted tail of the service log. Reads happen for diagnostics only; the
   * text is bounded so it can be handed to a recovery packet.
   */
  private async readLogTail(record: LocalServiceRecord, maxBytes: number): Promise<string | null> {
    const secrets = await Promise.all(Object.values(record.specification.environmentReferences)
      .map(ref => this.deps.resolveEnvironment(ref)));
    const token = this.storageToken(record.specification.serviceId, record.workspaceId);
    const file = await open(join(this.deps.logRoot, `${token}.log`), 'r').catch(() => null);
    if (!file) return null;
    try {
      const size = (await file.stat()).size;
      if (size === 0) return '';
      const bytes = Buffer.alloc(Math.min(size, maxBytes));
      await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
      let output = bytes.toString('utf8');
      for (const secret of secrets) if (secret) output = output.replaceAll(secret, '[REDACTED]');
      return publicText(output);
    } finally { await file.close(); }
  }

  private async check(record: LocalServiceRecord): Promise<LocalServiceView> {
    let healthStatus: number | null = null;
    let exitObserved = false;
    if (!await this.ownedProcess(record)) {
      exitObserved = true;
      record.state = 'failed';
      // The public view never carries process identity; `observe()` reports it
      // to the Runtime only (see `LocalServiceObservation`).
      record.healthMessage = '服务进程已退出，需显式重启';
    } else if (record.specification.healthPath === null || record.specification.port === null) {
      record.state = 'running';
      record.healthMessage = '服务进程正在运行（该规格未声明健康检查）';
    } else {
      try {
        const response = await fetch(`${this.url(record)}${record.specification.healthPath}`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
        healthStatus = response.status;
        record.state = response.ok ? 'healthy' : 'unhealthy';
        record.healthMessage = response.ok ? '健康检查通过' : `服务已启动，健康检查返回 ${response.status}`;
        await response.body?.cancel();
      } catch { record.state = 'unhealthy'; record.healthMessage = '服务已启动，但尚未通过健康检查'; }
    }
    record.updatedAt = new Date().toISOString(); this.deps.store.save(record);
    const previous = this.lastDiagnostics.get(
      this.diagnosticsKey(record.specification.serviceId, record.workspaceId),
    );
    const sameContract = previous?.specificationRevision === record.specificationRevision;
    this.lastDiagnostics.set(this.diagnosticsKey(record.specification.serviceId, record.workspaceId), {
      specificationRevision: record.specificationRevision,
      exitObserved,
      // A later observation of a stopped process has no HTTP answer; the last
      // real answer of this contract (for example a 503) stays the diagnosis.
      healthStatus: healthStatus ?? (sameContract ? previous!.healthStatus : null),
      retryable: record.state === 'failed' || record.state === 'unhealthy',
    });
    return this.view(record);
  }

  /**
   * Observe the current specification and return its bounded diagnostics.
   * Reading is side-effect free apart from recording the observed state; it
   * never launches a process and never resurrects a historical failure.
   */
  async observe(serviceId: string, workspaceId?: string | null): Promise<import('../task/local-service.js').LocalServiceObservation> {
    const scope = this.operationWorkspace(serviceId, workspaceId);
    return this.serialize(serviceId, scope, async () => {
      const record = this.requireScoped(serviceId, scope);
      const view = record.state === 'stopped' ? this.view(record) : await this.check(record);
      const known = this.lastDiagnostics.get(this.diagnosticsKey(serviceId, record.workspaceId));
      const facts = known && known.specificationRevision === record.specificationRevision
        ? known
        : {
            specificationRevision: record.specificationRevision,
            exitObserved: record.state === 'failed',
            healthStatus: null,
            retryable: record.state === 'failed' || record.state === 'unhealthy',
          };
      return { view, diagnostics: await this.diagnostics(record, facts) };
    });
  }

  /**
   * Runtime observation of the current specification. Historical records are
   * diagnosis input: `exitObserved`/`logTail` describe this revision, and
   * `retryable` only says an agent could plausibly repair it in place.
   */
  private async diagnostics(
    record: LocalServiceRecord,
    facts: { exitObserved: boolean; healthStatus: number | null; retryable: boolean },
  ): Promise<import('../task/local-service.js').LocalServiceDiagnostics> {
    const logTail = (record.state === 'healthy')
      ? null
      : await this.readLogTail(record, 8 * 1024).catch(() => null);
    return {
      workspaceId: record.workspaceId,
      specificationRevision: record.specificationRevision,
      processId: record.processId,
      exitObserved: facts.exitObserved,
      logTail,
      healthStatus: facts.healthStatus,
      retryable: facts.retryable,
    };
  }

  private async ownedProcess(record: LocalServiceRecord): Promise<boolean> {
    if (!record.processToken) return false;
    try {
      if (!record.processId) {
        const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command=']);
        const line = stdout.split('\n').find(line => line.includes(record.processToken!));
        if (line) { record.processId = Number(line.trim().split(/\s/u)[0]); this.deps.store.save(record); }
      }
      if (!record.processId) return false;
      const { stdout } = await execFileAsync('ps', ['-p', String(record.processId), '-o', 'command=']);
      return stdout.includes(record.processToken);
    } catch { return false; }
  }
  private operationWorkspace(serviceId: string, workspaceId?: string | null): string {
    if (workspaceId !== undefined) return workspaceId ?? '';
    if (this.deps.workspaceId !== undefined) return this.deps.workspaceId;
    const record = this.deps.store.find(serviceId);
    if (!record || record.accountId !== this.deps.accountId) throw new Error('服务不存在');
    return record.workspaceId ?? '';
  }
  private requireScoped(id: string, workspaceId: string): LocalServiceRecord {
    const record = this.lookup(id, workspaceId);
    if (!record || record.accountId !== this.deps.accountId) throw new Error('服务不存在');
    return record;
  }
  private url(record: LocalServiceRecord): string {
    const spec = record.specification;
    // A discovered contract may ignore the injected PORT and bind its own
    // default. Without an explicit address/health contract, report process
    // liveness but do not present a guessed URL as an accessible endpoint.
    if (spec.port === null || (spec.origin ?? 'manifest') === 'discovered') return '';
    return `http://${spec.host === '::1' ? '[::1]' : spec.host}:${spec.port}`;
  }
  private view(record: LocalServiceRecord): LocalServiceView {
    return { serviceId: record.specification.serviceId, taskId: record.specification.taskId,
      state: record.state, url: this.url(record), message: record.healthMessage,
      target: {
        targetPath: record.specification.directory ?? '',
        source: record.specification.origin ?? 'manifest',
      } };
  }
  private async serialize<T>(id: string, workspaceId: string, run: () => Promise<T>): Promise<T> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(id)) throw new Error('服务标识无效');
    const token = this.storageToken(id, workspaceId);
    const previous = this.operations.get(token) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      await mkdir(this.deps.logRoot, { recursive: true, mode: 0o700 });
      const lock = join(this.deps.logRoot, `${token}.lock`);
      const deadline = Date.now() + 65_000;
      while (true) {
        try {
          await mkdir(lock, { mode: 0o700 });
          await writeFile(join(lock, 'owner'), String(process.pid), { mode: 0o600 });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const owner = Number(await readFile(join(lock, 'owner'), 'utf8').catch(() => '0'));
          let alive = owner > 0;
          try { if (alive) process.kill(owner, 0); } catch { alive = false; }
          const info = await lstat(lock).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (!info) continue;
          if (!alive && Date.now() - info.mtimeMs > 1000) { await rm(lock, { recursive: true, force: true }); continue; }
          if (Date.now() >= deadline) throw new Error('服务正在处理其他操作，请稍后查询状态');
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      try { return await run(); } finally { await rm(lock, { recursive: true, force: true }); }
    });
    this.operations.set(token, current);
    try { return await current; } finally { if (this.operations.get(token) === current) this.operations.delete(token); }
  }
}
