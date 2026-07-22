import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceHandle, WorkspaceIdentity, WorkspaceStore } from './workspace-store.js';

const execFileAsync = promisify(execFile);

export interface ManagedGitWorkspace extends WorkspaceHandle {
  kind: 'git';
  repositoryPath: string;
  branch: string;
  sourceCommit: string;
  baselineCommit: string;
  sourceDiffHash: string;
  gitMetadataPath: string;
}

export interface ManagedGitCommit {
  branch: string;
  commit: string;
  changedPaths: string[];
}

function safeRefSegment(value: string): string {
  return value.normalize('NFC').replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[.-]+|[.-]+$/gu, '') || 'unnamed';
}

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync('git', args, {
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

  async ensure(identity: WorkspaceIdentity, sourcePath: string): Promise<ManagedGitWorkspace | null> {
    const source = await this.detectSource(sourcePath);
    if (!source) return null;
    await mkdir(this.repositoriesPath, { recursive: true });
    const workspace = await this.store.ensureWorkspace(identity, 'git');
    const repositoryPath = join(
      this.repositoriesPath,
      safeRefSegment(identity.taskId),
      `${safeRefSegment(identity.generationId)}.git`,
    );
    const branch = `metaclaw/${safeRefSegment(identity.taskId)}/${safeRefSegment(identity.generationId)}/${safeRefSegment(identity.subtaskId)}`;
    const gitMetadataPath = join(workspace.filesPath, '.git');

    if (!(await exists(repositoryPath))) {
      await mkdir(dirname(repositoryPath), { recursive: true });
      await git(['clone', '--bare', '--no-hardlinks', source.root, repositoryPath]);
    }
    if (!(await exists(gitMetadataPath))) {
      await git(['--git-dir', repositoryPath, 'worktree', 'add', '-B', branch, workspace.filesPath, source.commit]);
      await this.store.seedDirectory(workspace, source.root);
      await git(['-C', workspace.filesPath, 'config', 'user.name', 'MetaClaw Runtime']);
      await git(['-C', workspace.filesPath, 'config', 'user.email', 'runtime@metaclaw.local']);
      const commonDir = await git(['-C', workspace.filesPath, 'rev-parse', '--git-common-dir']);
      const excludePath = resolve(workspace.filesPath, commonDir, 'info', 'exclude');
      const existingExclude = await readFile(excludePath, 'utf8').catch(() => '');
      if (!existingExclude.split(/\r?\n/u).includes('.metaclaw/')) {
        await writeFile(excludePath, `${existingExclude.replace(/\s*$/u, '')}\n.metaclaw/\n`, 'utf8');
      }
      await git(['-C', workspace.filesPath, 'add', '-A']);
      if (await git(['-C', workspace.filesPath, 'status', '--porcelain'])) {
        await git(['-C', workspace.filesPath, 'commit', '-m', 'chore: capture task generation baseline']);
      }
    }

    const baselineCommit = await git(['-C', workspace.filesPath, 'rev-parse', 'HEAD']);
    const sourceDiff = await git(['-C', source.root, 'diff', '--binary', 'HEAD']);
    const untracked = await git(['-C', source.root, 'ls-files', '--others', '--exclude-standard']);
    const sourceDiffHash = createHash('sha256').update(sourceDiff).update('\0').update(untracked).digest('hex');
    return {
      ...workspace,
      kind: 'git',
      repositoryPath,
      branch,
      sourceCommit: source.commit,
      baselineCommit,
      sourceDiffHash,
      gitMetadataPath,
    };
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
        await git(['-C', workspace.filesPath, 'cherry-pick', commit]);
      } catch (error) {
        await git(['-C', workspace.filesPath, 'cherry-pick', '--abort']).catch(() => undefined);
        throw new Error(`workspace_state_conflict:${commit}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
