import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceHandle, WorkspaceIdentity, WorkspaceStore } from './workspace-store.js';

const execFileAsync = promisify(execFile);
const PLAIN_SOURCE_EXCLUDED_TOP_LEVEL = new Set([
  '.cache',
  '.git',
  '.metaclaw',
  '.venv',
  'coverage',
  'dist',
  'logs',
  'node_modules',
  'workspace-store',
]);

export interface ManagedGitWorkspace extends WorkspaceHandle {
  kind: 'git';
  repositoryPath: string;
  branch: string;
  sourceCommit: string;
  baselineCommit: string;
  headCommit: string;
  sourceDiffHash: string;
  gitMetadataPath: string;
}

export interface ManagedGitCommit {
  branch: string;
  commit: string;
  changedPaths: string[];
}

export interface ManagedGitRepairCommit extends ManagedGitCommit {
  workspaceCommit: string;
}

export interface ManagedGitCandidateDescription {
  baseCommit: string;
  oursCommit: string;
  theirsCommit: string;
  changedPaths: string[];
  filePolicy: Record<string, 'text' | 'binary'>;
}

export interface ManagedGitRepairPreparation {
  integrationCommit: string;
  conflictPaths: string[];
  filePolicy: Record<string, 'text' | 'binary'>;
  materialsPath: string;
}

export type ManagedGitMergeResult =
  | {
      type: 'integrated';
      baseCommit: string;
      oursCommit: string;
      theirsCommit: string;
      integrationCommit: string;
      changedPaths: string[];
      filePolicy: Record<string, 'text' | 'binary'>;
    }
  | {
      type: 'conflicted';
      baseCommit: string;
      oursCommit: string;
      theirsCommit: string;
      conflictPaths: string[];
      filePolicy: Record<string, 'text' | 'binary'>;
    };

function safeRefSegment(value: string): string {
  return value.normalize('NFC').replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[.-]+|[.-]+$/gu, '') || 'unnamed';
}

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync('git', withSafeDirectory(args), {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Host-side Git controller. It never writes the user's repository or refs. */
export class ManagedGitWorkspaceService {
  readonly repositoriesPath: string;
  private readonly repositoryOperations = new Map<string, Promise<void>>();

  constructor(private readonly store: WorkspaceStore) {
    this.repositoriesPath = join(store.rootPath, 'repositories');
  }

  async detectSource(sourcePath: string): Promise<{ root: string; commit: string } | null> {
    try {
      const root = await realpath(await git(['-C', sourcePath, 'rev-parse', '--show-toplevel']));
      const commit = await git(['-C', root, 'rev-parse', 'HEAD']);
      return { root, commit };
    } catch {
      return null;
    }
  }

  async ensure(identity: WorkspaceIdentity, sourcePath: string): Promise<ManagedGitWorkspace> {
    const detectedSource = await this.detectSource(sourcePath);
    const sourceRoot = detectedSource?.root ?? await realpath(sourcePath);
    const sourceInfo = await stat(sourceRoot);
    if (!sourceInfo.isDirectory()) throw new Error('managed Git source must be a directory');
    await mkdir(this.repositoriesPath, { recursive: true });
    const workspace = await this.store.ensureWorkspace(identity, 'git');
    const repositoryPath = join(
      this.repositoriesPath,
      safeRefSegment(identity.taskId),
      `${safeRefSegment(identity.generationId)}.git`,
    );
    const branch = `metaclaw/${safeRefSegment(identity.taskId)}/${safeRefSegment(identity.generationId)}/${safeRefSegment(identity.subtaskId)}`;
    const generationRefPrefix = `refs/metaclaw/generations/${safeRefSegment(identity.taskId)}/${safeRefSegment(identity.generationId)}`;
    const sourceRef = `${generationRefPrefix}/source`;
    const baselineRef = `${generationRefPrefix}/baseline`;
    const workspaceBranchPrefix = `refs/heads/metaclaw/${safeRefSegment(identity.taskId)}/${safeRefSegment(identity.generationId)}/`;
    const gitMetadataPath = join(workspace.filesPath, '.git');
    let sourceCommit = '';
    let baselineCommit = '';

    await this.withRepositoryOperation(repositoryPath, async () => {
      if (!(await exists(repositoryPath))) {
        await mkdir(dirname(repositoryPath), { recursive: true });
        if (detectedSource) {
          await git(['clone', '--bare', '--no-hardlinks', detectedSource.root, repositoryPath]);
        } else {
          await this.importPlainSource(sourceRoot, repositoryPath);
        }
      }
      sourceCommit = await git(['--git-dir', repositoryPath, 'rev-parse', sourceRef])
        .catch(async () => {
          const commit = await git(['--git-dir', repositoryPath, 'rev-parse', 'HEAD']);
          await git(['--git-dir', repositoryPath, 'update-ref', sourceRef, commit]);
          return commit;
        });
      baselineCommit = await git(['--git-dir', repositoryPath, 'rev-parse', baselineRef])
        .catch(async () => {
          const legacy = await this.findLegacyGenerationBaseline(
            repositoryPath,
            sourceCommit,
            workspaceBranchPrefix,
          );
          if (legacy) await git(['--git-dir', repositoryPath, 'update-ref', baselineRef, legacy]);
          return legacy ?? '';
        });
      if (!(await exists(gitMetadataPath))) {
        await git([
          '--git-dir', repositoryPath,
          'worktree', 'add', '-B', branch, workspace.filesPath,
          baselineCommit || sourceCommit,
        ]);
        await git(['-C', workspace.filesPath, 'config', 'user.name', 'MetaClaw Runtime']);
        await git(['-C', workspace.filesPath, 'config', 'user.email', 'runtime@metaclaw.local']);
        const commonDir = await git(['-C', workspace.filesPath, 'rev-parse', '--git-common-dir']);
        const excludePath = resolve(workspace.filesPath, commonDir, 'info', 'exclude');
        const existingExclude = await readFile(excludePath, 'utf8').catch(() => '');
        if (!existingExclude.split(/\r?\n/u).includes('.metaclaw/')) {
          await writeFile(excludePath, `${existingExclude.replace(/\s*$/u, '')}\n.metaclaw/\n`, 'utf8');
        }
        if (!baselineCommit) {
          if (detectedSource) await this.store.seedDirectory(workspace, detectedSource.root);
          await git(['-C', workspace.filesPath, 'add', '-A']);
          if (await git(['-C', workspace.filesPath, 'status', '--porcelain'])) {
            await git(['-C', workspace.filesPath, 'commit', '-m', 'chore: capture task generation baseline']);
          }
          baselineCommit = await git(['-C', workspace.filesPath, 'rev-parse', 'HEAD']);
          await git(['--git-dir', repositoryPath, 'update-ref', baselineRef, baselineCommit]);
        }
      }
      if (!baselineCommit) {
        baselineCommit = await git(['--git-dir', repositoryPath, 'rev-parse', baselineRef]);
      }
    });

    const headCommit = await git(['-C', workspace.filesPath, 'rev-parse', 'HEAD']);
    const sourceDiff = await git([
      '--git-dir', repositoryPath, 'diff', '--binary', `${sourceCommit}..${baselineCommit}`,
    ]);
    const sourceDiffHash = createHash('sha256')
      .update(sourceCommit)
      .update('\0')
      .update(sourceDiff)
      .digest('hex');
    return {
      ...workspace,
      kind: 'git',
      repositoryPath,
      branch,
      sourceCommit,
      baselineCommit,
      headCommit,
      sourceDiffHash,
      gitMetadataPath,
    };
  }

  private async withRepositoryOperation<T>(
    repositoryPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.repositoryOperations.get(repositoryPath) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>(resolveTurn => {
      release = resolveTurn;
    });
    const queued = previous.catch(() => undefined).then(() => turn);
    this.repositoryOperations.set(repositoryPath, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.repositoryOperations.get(repositoryPath) === queued) {
        this.repositoryOperations.delete(repositoryPath);
      }
    }
  }

  async commit(workspace: ManagedGitWorkspace, message: string): Promise<ManagedGitCommit> {
    const actualRoot = await realpath(await git(['-C', workspace.filesPath, 'rev-parse', '--show-toplevel']));
    if (actualRoot !== await realpath(workspace.filesPath)) throw new Error('managed worktree root mismatch');
    const actualCommon = resolve(workspace.filesPath, await git(['-C', workspace.filesPath, 'rev-parse', '--git-common-dir']));
    if (await realpath(actualCommon) !== await realpath(workspace.repositoryPath)) {
      throw new Error('managed worktree escaped its repository');
    }
    const changedPaths = (await git(['-C', workspace.filesPath, 'status', '--porcelain']))
      .split(/\r?\n/u).filter(Boolean).map(line => line.slice(3));
    await git(['-C', workspace.filesPath, 'add', '-A']);
    await git(['-C', workspace.filesPath, 'commit', '--allow-empty', '-m', message]);
    const commit = await git(['-C', workspace.filesPath, 'rev-parse', 'HEAD']);
    workspace.headCommit = commit;
    return { branch: workspace.branch, commit, changedPaths };
  }

  async applyDependencyStates(workspace: ManagedGitWorkspace, commits: string[]): Promise<void> {
    for (const commit of commits) {
      try {
        await git(['-C', workspace.filesPath, 'merge-base', '--is-ancestor', commit, 'HEAD']);
        continue;
      } catch {
        // A non-ancestor direct dependency must be composed explicitly.
      }
      try {
        await git(['-C', workspace.filesPath, 'merge', '--no-ff', '--no-edit', commit]);
      } catch (error) {
        await git(['-C', workspace.filesPath, 'merge', '--abort']).catch(() => undefined);
        throw new Error(`workspace_state_conflict:${commit}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    workspace.headCommit = await git(['-C', workspace.filesPath, 'rev-parse', 'HEAD']);
  }

  async mergeCandidate(
    integrationWorkspace: ManagedGitWorkspace,
    candidateCommit: string,
  ): Promise<ManagedGitMergeResult> {
    const candidate = await this.describeCandidate(integrationWorkspace, candidateCommit);
    const { baseCommit, oursCommit, theirsCommit } = candidate;
    if (await isAncestor(integrationWorkspace.filesPath, theirsCommit, oursCommit)) {
      return {
        type: 'integrated',
        baseCommit,
        oursCommit,
        theirsCommit,
        integrationCommit: oursCommit,
        changedPaths: [],
        filePolicy: {},
      };
    }
    const merge = await mergeTree({
      workspacePath: integrationWorkspace.filesPath,
      baseCommit,
      oursCommit,
      theirsCommit,
    });
    if (merge.type === 'conflicted') {
      return {
        type: 'conflicted',
        baseCommit,
        oursCommit,
        theirsCommit,
        conflictPaths: merge.conflictPaths,
        filePolicy: await this.classifyPaths(
          integrationWorkspace.filesPath,
          theirsCommit,
          merge.conflictPaths,
        ),
      };
    }
    const integrationCommit = await git([
      '-C', integrationWorkspace.filesPath,
      'commit-tree', merge.tree,
      '-p', oursCommit,
      '-p', theirsCommit,
      '-m', `Merge candidate ${theirsCommit}`,
    ]);
    await git(['-C', integrationWorkspace.filesPath, 'reset', '--hard', integrationCommit]);
    integrationWorkspace.headCommit = integrationCommit;
    const changedPaths = splitLines(await git([
      '-C', integrationWorkspace.filesPath, 'diff', '--name-only', `${oursCommit}..${integrationCommit}`,
    ]));
    return {
      type: 'integrated',
      baseCommit,
      oursCommit,
      theirsCommit,
      integrationCommit,
      changedPaths,
      filePolicy: await this.classifyPaths(integrationWorkspace.filesPath, theirsCommit, changedPaths),
    };
  }

  async describeCandidate(
    integrationWorkspace: ManagedGitWorkspace,
    candidateCommit: string,
  ): Promise<ManagedGitCandidateDescription> {
    const oursCommit = await git(['-C', integrationWorkspace.filesPath, 'rev-parse', 'HEAD']);
    const theirsCommit = await git(['-C', integrationWorkspace.filesPath, 'rev-parse', candidateCommit]);
    const baseCommit = await isAncestor(integrationWorkspace.filesPath, oursCommit, theirsCommit)
      ? oursCommit
      : await git(['-C', integrationWorkspace.filesPath, 'rev-parse', `${theirsCommit}^1`]);
    const changedPaths = splitLines(await git([
      '-C', integrationWorkspace.filesPath, 'diff', '--name-only', `${baseCommit}..${theirsCommit}`,
    ]));
    return {
      baseCommit,
      oursCommit,
      theirsCommit,
      changedPaths,
      filePolicy: await this.classifyPaths(integrationWorkspace.filesPath, theirsCommit, changedPaths),
    };
  }

  async prepareMergeRepair(input: {
    candidateWorkspace: ManagedGitWorkspace;
    integrationWorkspace: ManagedGitWorkspace;
    candidateCommit: string;
    expectedConflictPaths: string[];
    filePolicy: Record<string, 'text' | 'binary'>;
  }): Promise<ManagedGitRepairPreparation> {
    await git(['-C', input.candidateWorkspace.filesPath, 'merge', '--abort']).catch(() => undefined);
    await git(['-C', input.candidateWorkspace.filesPath, 'reset', '--hard', input.candidateCommit]);
    const integrationCommit = await git(['-C', input.integrationWorkspace.filesPath, 'rev-parse', 'HEAD']);
    try {
      await git([
        '-C', input.candidateWorkspace.filesPath, 'merge', '--no-ff', '--no-edit', integrationCommit,
      ]);
      throw new Error('merge repair was authorized but the candidate no longer conflicts');
    } catch (error) {
      const conflictPaths = splitLines(await git([
        '-C', input.candidateWorkspace.filesPath, 'diff', '--name-only', '--diff-filter=U',
      ]));
      if (conflictPaths.length === 0) throw error;
      const expected = [...input.expectedConflictPaths].sort();
      if (conflictPaths.join('\0') !== expected.join('\0')) {
        await git(['-C', input.candidateWorkspace.filesPath, 'merge', '--abort']).catch(() => undefined);
        throw new Error(
          `merge repair conflict set changed: expected ${expected.join(', ')}, got ${conflictPaths.join(', ')}`,
        );
      }
      const materialsPath = join(input.candidateWorkspace.filesPath, '.metaclaw', 'merge-repair');
      // Prior repair attempts intentionally make these inputs read-only. A hard
      // reset leaves the untracked directory behind, so rebuild it atomically
      // instead of attempting to overwrite 0444 files.
      await rm(materialsPath, { recursive: true, force: true });
      for (const path of conflictPaths) {
        for (const [stage, suffix] of [['1', 'base'], ['2', 'ours'], ['3', 'theirs']] as const) {
          const target = join(materialsPath, `${path}.${suffix}`);
          await mkdir(dirname(target), { recursive: true });
          const content = await gitBuffer([
            '-C', input.candidateWorkspace.filesPath, 'show', `:${stage}:${path}`,
          ]).catch(() => Buffer.alloc(0));
          await writeFile(target, content);
          await chmod(target, 0o444).catch(() => undefined);
        }
      }
      return {
        integrationCommit,
        conflictPaths,
        filePolicy: input.filePolicy,
        materialsPath,
      };
    }
  }

  async commitMergeRepair(input: {
    workspace: ManagedGitWorkspace;
    allowedPaths: string[];
    filePolicy: Record<string, 'text' | 'binary'>;
    reportedResolvedPaths: string[];
  }): Promise<ManagedGitRepairCommit> {
    const allowed = [...new Set(input.allowedPaths)].sort();
    const reported = [...new Set(input.reportedResolvedPaths)].sort();
    if (allowed.join('\0') !== reported.join('\0')) {
      throw new Error(`merge repair report does not cover exactly the authorized paths: ${reported.join(', ')}`);
    }
    const unstaged = splitLines(await git([
      '-C', input.workspace.filesPath, 'diff', '--name-only',
    ]));
    const untracked = splitLines(await git([
      '-C', input.workspace.filesPath, 'ls-files', '--others', '--exclude-standard',
    ])).filter(path => !path.startsWith('.metaclaw/'));
    const outside = [...new Set([...unstaged, ...untracked])].filter(path => !allowed.includes(path));
    if (outside.length > 0) {
      throw new Error(`merge repair changed paths outside the authorized conflict set: ${outside.join(', ')}`);
    }
    for (const path of allowed) {
      if (input.filePolicy[path] !== 'text') continue;
      const content = await readFile(join(input.workspace.filesPath, path), 'utf8');
      if (/^(?:<{7}|={7}|>{7})(?:\s|$)/mu.test(content)) {
        throw new Error(`merge repair left conflict markers in ${path}`);
      }
    }
    await git(['-C', input.workspace.filesPath, 'add', '--', ...allowed]);
    const unmerged = splitLines(await git([
      '-C', input.workspace.filesPath, 'diff', '--name-only', '--diff-filter=U',
    ]));
    if (unmerged.length > 0) throw new Error(`merge repair left unmerged entries: ${unmerged.join(', ')}`);
    const originalCandidateCommit = await git([
      '-C', input.workspace.filesPath, 'rev-parse', 'HEAD',
    ]);
    await git(['-C', input.workspace.filesPath, 'commit', '--no-edit']);
    const commit = await git(['-C', input.workspace.filesPath, 'rev-parse', 'HEAD']);
    await git([
      '-C', input.workspace.filesPath, 'update-ref',
      `refs/metaclaw/publications/${commit}`, commit,
    ]);

    await git(['-C', input.workspace.filesPath, 'reset', '--hard', originalCandidateCommit]);
    for (const path of allowed) {
      const existsInRepair = await git([
        '-C', input.workspace.filesPath, 'cat-file', '-e', `${commit}:${path}`,
      ]).then(() => true).catch(() => false);
      if (existsInRepair) {
        await git(['-C', input.workspace.filesPath, 'checkout', commit, '--', path]);
      } else {
        await git(['-C', input.workspace.filesPath, 'rm', '--ignore-unmatch', '--', path]);
      }
    }
    await git(['-C', input.workspace.filesPath, 'add', '-A', '--', ...allowed]);
    await git([
      '-C', input.workspace.filesPath, 'commit', '--allow-empty',
      '-m', 'fix: project merge repair without integration ancestry',
    ]);
    const workspaceCommit = await git(['-C', input.workspace.filesPath, 'rev-parse', 'HEAD']);
    input.workspace.headCommit = workspaceCommit;
    return {
      branch: input.workspace.branch,
      commit,
      workspaceCommit,
      changedPaths: allowed,
    };
  }

  private async findLegacyGenerationBaseline(
    repositoryPath: string,
    sourceCommit: string,
    workspaceBranchPrefix: string,
  ): Promise<string | null> {
    const refs = splitLines(await git([
      '--git-dir', repositoryPath,
      'for-each-ref', '--format=%(refname)', workspaceBranchPrefix,
    ]));
    const candidates: Array<{ commit: string; timestamp: number }> = [];
    for (const ref of refs) {
      const firstCommit = splitLines(await git([
        '--git-dir', repositoryPath,
        'rev-list', '--first-parent', '--reverse', `${sourceCommit}..${ref}`,
      ]))[0];
      if (!firstCommit) {
        candidates.push({ commit: sourceCommit, timestamp: 0 });
        continue;
      }
      const subject = await git([
        '--git-dir', repositoryPath, 'show', '-s', '--format=%s', firstCommit,
      ]);
      const commit = subject === 'chore: capture task generation baseline'
        ? firstCommit
        : sourceCommit;
      const timestamp = Number(await git([
        '--git-dir', repositoryPath, 'show', '-s', '--format=%ct', commit,
      ]));
      candidates.push({ commit, timestamp });
    }
    candidates.sort((left, right) => (
      left.timestamp - right.timestamp || left.commit.localeCompare(right.commit)
    ));
    return candidates[0]?.commit ?? null;
  }

  private async importPlainSource(sourceRoot: string, repositoryPath: string): Promise<void> {
    const importRoot = await mkdtemp(join(dirname(repositoryPath), 'plain-import-'));
    // Guard against pathological sources (for example a dispatch without a
    // workspace payload): importing a directory into itself must fail with a
    // clear error instead of Node cp's EINVAL on recursive self-copy.
    const realSource = await realpath(sourceRoot).catch(() => sourceRoot);
    const realImportParent = await realpath(dirname(importRoot)).catch(() => dirname(importRoot));
    if (realSource === realImportParent || realImportParent.startsWith(`${realSource}/`)) {
      throw new Error(
        `refusing to import workspace source into itself: ${sourceRoot} contains ${importRoot}`,
      );
    }
    try {
      await cp(sourceRoot, importRoot, {
        recursive: true,
        filter: async source => {
          const pathFromSource = relative(sourceRoot, source);
          if (pathFromSource === '' && source === sourceRoot) return true;
          const topLevel = pathFromSource.split(/[\\/]/u)[0] ?? '';
          if (PLAIN_SOURCE_EXCLUDED_TOP_LEVEL.has(topLevel)) return false;
          // Executors (for example a browser daemon) can leave Unix sockets or
          // FIFOs in the workspace; Node's recursive cp aborts with EINVAL on
          // them, so they are skipped instead of failing the attempt.
          const info = await lstat(source).catch(() => null);
          return !(info?.isSocket() || info?.isFIFO());
        },
      });
      await git(['init'], importRoot);
      await git(['-C', importRoot, 'config', 'user.name', 'MetaClaw Runtime']);
      await git(['-C', importRoot, 'config', 'user.email', 'runtime@metaclaw.local']);
      await git(['-C', importRoot, 'add', '-A']);
      await git(['-C', importRoot, 'commit', '--allow-empty', '-m', 'chore: import task generation source']);
      await git(['clone', '--bare', '--no-hardlinks', importRoot, repositoryPath]);
    } finally {
      // Transient EBUSY/ENOTEMPTY/EPERM failures happen on APFS when a git
      // object file is still being flushed; retry instead of failing the
      // attempt during cleanup.
      await rm(importRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 120,
      }).catch(() => undefined);
    }
  }

  private async classifyPaths(
    workspacePath: string,
    commit: string,
    paths: readonly string[],
  ): Promise<Record<string, 'text' | 'binary'>> {
    const policies: Record<string, 'text' | 'binary'> = {};
    for (const path of paths) {
      const attributes = await git([
        '-C', workspacePath, 'check-attr', 'binary', 'text', 'merge', '--', path,
      ]).catch(() => '');
      if (/:\s+binary:\s+set(?:\r?\n|$)/u.test(attributes)
        || /:\s+merge:\s+binary(?:\r?\n|$)/u.test(attributes)) {
        policies[path] = 'binary';
        continue;
      }
      if (/:\s+binary:\s+unset(?:\r?\n|$)/u.test(attributes)
        || /:\s+text:\s+set(?:\r?\n|$)/u.test(attributes)) {
        policies[path] = 'text';
        continue;
      }
      if (/\.(?:avif|bmp|db|docx?|gif|ico|jpe?g|m4a|mov|mp3|mp4|pdf|png|pptx?|sqlite3?|tiff?|wav|webm|webp|xlsx?)$/iu.test(path)) {
        policies[path] = 'binary';
        continue;
      }
      const content = await execFileAsync(
        'git',
        ['-C', workspacePath, 'show', `${commit}:${path}`],
        { encoding: 'buffer', windowsHide: true, maxBuffer: 1024 * 1024 },
      ).then(result => Buffer.from(result.stdout)).catch(() => Buffer.alloc(0));
      policies[path] = content.includes(0) ? 'binary' : 'text';
    }
    return policies;
  }
}

async function gitBuffer(args: string[]): Promise<Buffer> {
  const result = await execFileAsync('git', withSafeDirectory(args), {
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return Buffer.from(result.stdout);
}

async function isAncestor(
  workspacePath: string,
  ancestorCommit: string,
  descendantCommit: string,
): Promise<boolean> {
  return git([
    '-C', workspacePath,
    'merge-base', '--is-ancestor', ancestorCommit, descendantCommit,
  ]).then(() => true).catch(() => false);
}

async function mergeTree(input: {
  workspacePath: string;
  baseCommit: string;
  oursCommit: string;
  theirsCommit: string;
}): Promise<
  | { type: 'integrated'; tree: string }
  | { type: 'conflicted'; conflictPaths: string[] }
> {
  const args = withSafeDirectory([
    '-C', input.workspacePath,
    'merge-tree',
    '--write-tree',
    '--merge-base', input.baseCommit,
    '--name-only',
    '--no-messages',
    '-z',
    input.oursCommit,
    input.theirsCommit,
  ]);
  try {
    const result = await execFileAsync('git', args, {
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const tree = Buffer.from(result.stdout).toString('utf8').split('\0', 1)[0]?.trim() ?? '';
    if (!/^[a-f0-9]{40,64}$/u.test(tree)) throw new Error('merge-tree did not return an integration tree');
    return { type: 'integrated', tree };
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: Buffer | string };
    if (Number(failure.code) !== 1) throw error;
    const fields = Buffer.isBuffer(failure.stdout)
      ? failure.stdout.toString('utf8').split('\0')
      : String(failure.stdout ?? '').split('\0');
    const conflictPaths = fields.slice(1).map(path => path.trim()).filter(Boolean);
    if (conflictPaths.length === 0) {
      throw new Error('merge-tree reported a conflict without path-scoped repair material');
    }
    return { type: 'conflicted', conflictPaths: [...new Set(conflictPaths)].sort() };
  }
}

function withSafeDirectory(args: string[]): string[] {
  const directoryIndex = args.indexOf('-C');
  const directory = directoryIndex >= 0 ? args[directoryIndex + 1] : null;
  return directory
    ? ['-c', `safe.directory=${resolve(directory)}`, ...args]
    : args;
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
}
