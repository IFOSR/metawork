import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { withWorkspaceGitLock } from './workspace-git-lock.js';
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { boundedPathSegment } from '../utils/bounded-path-segment.js';
import type { ConversationGitWorktree, GitTreeEntry, WorkspaceGitRoot } from '../workspace/workspace-git-contracts.js';
export type { ConversationGitWorktree, WorkspaceGitRoot } from '../workspace/workspace-git-contracts.js';

const EXCLUDED = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache']);
const BINARY = /\.(?:pptx?|docx?|xlsx?|pdf|png|jpe?g|gif|webp|ico|zip|gz|mp[34]|woff2?)$/iu;
export class WorkspaceGitCommandError extends Error {
  constructor(message: string, readonly exitCode: number | string | undefined) { super(message); }
}

const OID = /^[a-f0-9]{40}$/u;

export interface WorkspaceGitServiceOptions {
  internalRoot: string;
  gitCommand?: string;
  gitTimeoutMs?: number;
  /** Timeout for initial import and large tree capture/writeback operations. */
  longOperationTimeoutMs?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

/** Byte-preserving private Git. User repository config, filters and hooks never run. */
export class WorkspaceGitService {
  constructor(private readonly options: WorkspaceGitServiceOptions) {}

  paths(workspaceId: string): Pick<WorkspaceGitRoot, 'repositoryPath' | 'integrationPath'> {
    const root = join(this.options.internalRoot, 'workspace-git', boundedPathSegment(workspaceId, { prefix: 'w' }));
    return { repositoryPath: join(root, 'repository.git'), integrationPath: join(root, 'integration') };
  }

  /** The user Workspace is deliberately outside the private repository. This
   * index is the Git index used to observe that external work tree. */
  sourceIndexPath(repositoryPath: string): string {
    return join(repositoryPath, 'metawork-source.index');
  }

  async run(args: string[], input?: Buffer | string | Readable, extraEnv: NodeJS.ProcessEnv = {}, timeoutMs?: number, allowedExitCodes: readonly (number | string)[] = []): Promise<Buffer> {
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'MetaWork', GIT_AUTHOR_EMAIL: 'runtime@metawork.local',
      GIT_COMMITTER_NAME: 'MetaWork', GIT_COMMITTER_EMAIL: 'runtime@metawork.local', ...extraEnv,
    });
    return new Promise((resolve, reject) => {
      const child = execFile(this.options.gitCommand ?? 'git', [
        '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'commit.gpgSign=false',
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'gc.auto=0', ...args,
      ], { env, encoding: 'buffer', timeout: timeoutMs ?? this.options.gitTimeoutMs ?? 120_000,
        maxBuffer: (this.options.maxFileBytes ?? 1024 ** 3) + 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => error && !allowedExitCodes.includes(error.code ?? '')
        ? reject(new WorkspaceGitCommandError(`Git ${args[0]}: ${stderr.toString().slice(0, 4000) || error.message}`, error.code ?? undefined))
        : resolve(stdout));
      child.stdin?.on('error', () => {});
      if (input instanceof Readable) {
        void pipeline(input, child.stdin!).catch(error => { child.kill(); reject(error); });
      } else child.stdin?.end(input);
    });
  }

  async text(args: string[], input?: Buffer | string | Readable, env?: NodeJS.ProcessEnv, timeoutMs?: number): Promise<string> {
    return (await this.run(args, input, env, timeoutMs)).toString('utf8').trim();
  }

  async initialize(input: { accountId: string; workspaceId: string; userRoot: string }): Promise<WorkspaceGitRoot> {
    const paths = this.paths(input.workspaceId);
    await mkdir(dirname(paths.repositoryPath), { recursive: true, mode: 0o700 });
    return withWorkspaceGitLock(dirname(paths.repositoryPath), 'initialize', () => this.initializeLocked(input));
  }

  private async initializeLocked(input: { accountId: string; workspaceId: string; userRoot: string }): Promise<WorkspaceGitRoot> {
    const userRoot = await realpath(input.userRoot);
    if (!(await stat(userRoot)).isDirectory()) throw new Error('workspace_path_invalid');
    const paths = this.paths(input.workspaceId);
    if (within(userRoot, paths.repositoryPath) || within(dirname(paths.repositoryPath), userRoot)) throw new Error('workspace_runtime_overlap');
    await mkdir(dirname(paths.repositoryPath), { recursive: true, mode: 0o700 });
    if (!(await exists(paths.repositoryPath))) await this.text(['init', '--bare', '--object-format=sha1', paths.repositoryPath]);
    let main = await this.ref(paths.repositoryPath, 'refs/heads/main').catch(() => null);
    if (!main) {
      const tree = await this.text(['--git-dir', paths.repositoryPath, 'mktree'], '');
      main = await this.commitTree(paths.repositoryPath, tree, [], 'Initialize Workspace');
      await this.updateRef(paths.repositoryPath, 'refs/heads/main', main, '0'.repeat(40));
    }
    if (!(await exists(join(paths.integrationPath, '.git')))) {
      await this.text(['--git-dir', paths.repositoryPath, 'worktree', 'add', paths.integrationPath, 'main']);
    }
    let delivered = await this.ref(paths.repositoryPath, 'refs/metawork/delivered').catch(() => null);
    if (!delivered) {
      main = await this.capture(paths.repositoryPath, userRoot, main, 'Capture Workspace baseline');
      await this.updateRef(paths.repositoryPath, 'refs/heads/main', main);
      await this.text(['-C', paths.integrationPath, 'reset', '--hard', main]);
      await this.updateRef(paths.repositoryPath, 'refs/metawork/delivered', main, '0'.repeat(40));
      delivered = main;
    }
    await this.refreshSourceIndex(paths.repositoryPath, userRoot, delivered);
    return { ...input, userRoot, ...paths, mainCommit: main, deliveredCommit: delivered, state: 'ready' };
  }

  async validateRoot(root: WorkspaceGitRoot): Promise<void> {
    const [main, delivered, common] = await Promise.all([
      this.ref(root.repositoryPath, 'refs/heads/main'), this.ref(root.repositoryPath, 'refs/metawork/delivered'),
      this.text(['-C', root.integrationPath, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
    ]);
    if (main !== root.mainCommit || delivered !== root.deliveredCommit
      || await realpath(common) !== await realpath(root.repositoryPath)) throw new Error('workspace_git_refs_require_recovery');
  }

  async ensureConversation(root: WorkspaceGitRoot, conversationId: string, incarnation = 1): Promise<ConversationGitWorktree> {
    const segment = boundedPathSegment(conversationId, { prefix: 'c' });
    const branch = `sessions/${segment}-${incarnation}`;
    const rootPath = join(dirname(root.repositoryPath), 'sessions', `${segment}-${incarnation}`);
    await mkdir(dirname(rootPath), { recursive: true, mode: 0o700 });
    if (!(await exists(join(rootPath, '.git')))) {
      await this.text(['--git-dir', root.repositoryPath, 'worktree', 'add', ...((await this.ref(root.repositoryPath, `refs/heads/${branch}`).catch(()=>null)) ? [rootPath, branch] : ['-b', branch, rootPath, root.deliveredCommit])]);
    }
    const headCommit = await this.ref(root.repositoryPath, `refs/heads/${branch}`);
    const worktree = { ...root, conversationId, worktreeId: `wt_${randomUUID()}`, incarnation, branch,
      rootPath, baseCommit: root.deliveredCommit, headCommit };
    await this.validateWorktree(worktree);
    return worktree;
  }

  async validateWorktree(worktree: ConversationGitWorktree): Promise<void> {
    const common = await this.text(['-C', worktree.rootPath, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    const branch = await this.text(['-C', worktree.rootPath, 'symbolic-ref', 'HEAD']);
    if (await realpath(common) !== await realpath(worktree.repositoryPath) || branch !== `refs/heads/${worktree.branch}`) {
      throw new Error('conversation_worktree_identity_mismatch');
    }
    const expected = await realpath(join(dirname(worktree.repositoryPath), 'sessions'));
    if (!within(expected, await realpath(worktree.rootPath))) throw new Error('conversation_worktree_path_mismatch');
  }

  async syncConversation(worktree: ConversationGitWorktree, targetCommit?: string): Promise<ConversationGitWorktree> {
    await this.validateWorktree(worktree);
    const target = targetCommit ?? await this.ref(worktree.repositoryPath, 'refs/metawork/delivered');
    if (!(await this.isWorktreeClean(worktree.rootPath, worktree.headCommit))) throw new Error('conversation_has_unsealed_work');
    if (worktree.headCommit !== worktree.baseCommit && !(await this.isAncestor(worktree.repositoryPath, worktree.headCommit, target))) {
      throw new Error('conversation_has_undelivered_work');
    }
    await this.text(['-C', worktree.rootPath, 'reset', '--hard', target]);
    return { ...worktree, baseCommit: target, headCommit: target };
  }

  async seal(worktree: ConversationGitWorktree, message: string): Promise<{ commit: string; changedPaths: string[] }> {
    await this.validateWorktree(worktree);
    // The durable head is the parent; model-made commits cannot advance trusted refs.
    const commit = await this.capture(worktree.repositoryPath, worktree.rootPath, worktree.headCommit, message);
    const changedPaths = (await this.changedFiles(worktree.repositoryPath, worktree.headCommit, commit)).map(file => file.path);
    const actualHead = await this.ref(worktree.repositoryPath, `refs/heads/${worktree.branch}`);
    await this.updateRef(worktree.repositoryPath, `refs/heads/${worktree.branch}`, commit, actualHead);
    await this.text(['-C', worktree.rootPath, 'read-tree', commit]);
    return { commit, changedPaths };
  }

  /**
   * Check an internal Session Worktree without reading every file into Git
   * objects. Git uses its work-tree stat cache and only inspects candidates
   * that may have changed. Full capture remains the sealing operation.
   */
  async isWorktreeClean(worktreeRoot: string, headCommit: string): Promise<boolean> {
    const output = await this.run([
      '-C', worktreeRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all',
    ]);
    if (output.length > 0) return false;
    const head = await this.text(['-C', worktreeRoot, 'rev-parse', 'HEAD']);
    return head === headCommit;
  }

  /**
   * Incrementally capture the user Workspace using one persistent Git index.
   * The index contains the last captured tree and stat data; unchanged files
   * reuse their existing object ids. Only changed, deleted, explicitly
   * requested, or newly discovered paths are read and hashed.
   */
  async captureUserRoot(
    repositoryPath: string,
    userRoot: string,
    parent: string,
    message: string,
    explicitPaths: string[] = [],
  ): Promise<string> {
    const index = this.sourceIndexPath(repositoryPath);
    await mkdir(dirname(index), { recursive: true, mode: 0o700 });
    const parentTree = await this.text(['--git-dir', repositoryPath, 'rev-parse', `${parent}^{tree}`]);
    const longTimeout = this.options.longOperationTimeoutMs ?? 30 * 60 * 1_000;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let indexTree: string | null = null;
      if (await exists(index)) {
        indexTree = await this.text(['--git-dir', repositoryPath, 'write-tree'], undefined, { GIT_INDEX_FILE: index }, longTimeout).catch(() => null);
      }
      if (indexTree !== parentTree) {
        await this.text(['--git-dir', repositoryPath, 'read-tree', parent], undefined, { GIT_INDEX_FILE: index }, longTimeout);
        await this.refreshSourceIndex(repositoryPath, userRoot, parent);
      }

      const changed = await this.sourceIndexChanges(repositoryPath, userRoot, parent, index);
      const candidates = new Set<string>(changed.map(item => item.path));
      for (const path of await this.sourceIndexUntracked(repositoryPath, userRoot, index)) candidates.add(path);
      for (const path of explicitPaths) { assertGitPath(path); candidates.add(path); }
      const tracked = new Map((await this.entries(repositoryPath, parent)).map(entry => [entry.path, entry]));
      const changes: Array<{ path: string; entry: GitTreeEntry | null }> = [];
      let unstable = false;
      for (const path of [...candidates].sort()) {
        const absolute = join(userRoot, ...path.split('/'));
        const statBefore = await lstat(absolute).catch(() => null);
        if (!statBefore) {
          if (tracked.has(path)) changes.push({ path, entry: null });
          continue;
        }
        if (!statBefore.isFile() && !statBefore.isSymbolicLink()) continue;
        if (statBefore.size > (this.options.maxFileBytes ?? 1024 ** 3)) throw new Error(`workspace_file_limit: ${path}`);
        const entry = await this.hashSourceEntry(repositoryPath, absolute, path, statBefore.mode, statBefore.isSymbolicLink(), longTimeout);
        changes.push({ path, entry });
        const statAfter = await lstat(absolute).catch(() => null);
        if (!statAfter || statAfter.ino !== statBefore.ino || statAfter.size !== statBefore.size
          || statAfter.mtimeMs !== statBefore.mtimeMs || statAfter.ctimeMs !== statBefore.ctimeMs || statAfter.mode !== statBefore.mode) {
          unstable = true;
          break;
        }
      }
      if (unstable) continue;
      if (changes.length) await this.updateIndex(repositoryPath, changes, { GIT_INDEX_FILE: index });
      await this.refreshSourceIndexStats(repositoryPath, userRoot);
      const tree = await this.text(['--git-dir', repositoryPath, 'write-tree'], undefined, { GIT_INDEX_FILE: index }, longTimeout);
      if (tree === parentTree) return parent;
      const commit = await this.commitTree(repositoryPath, tree, [parent], message);
      await this.refreshSourceIndex(repositoryPath, userRoot, commit);
      return commit;
    }
    throw new Error('source_changing: Workspace changed during incremental capture');
  }

  /** Rebind the persistent source index to a delivered commit and refresh its stat cache. */
  async refreshSourceIndex(repositoryPath: string, userRoot: string, commit: string): Promise<void> {
    const index = this.sourceIndexPath(repositoryPath);
    await mkdir(dirname(index), { recursive: true, mode: 0o700 });
    await this.text(['--git-dir', repositoryPath, 'read-tree', commit], undefined, { GIT_INDEX_FILE: index });
    await this.refreshSourceIndexStats(repositoryPath, userRoot);
  }

  private async refreshSourceIndexStats(repositoryPath: string, userRoot: string): Promise<void> {
    const index = this.sourceIndexPath(repositoryPath);
    await this.text(['--git-dir', repositoryPath, '--work-tree', userRoot, 'update-index', '--refresh'], undefined, { GIT_INDEX_FILE: index }).catch(error => {
      // Git exits 1 when a file differs from the commit. The index still has
      // the refreshed stat data; the next diff-index reports the candidate.
      if (!(error instanceof WorkspaceGitCommandError) || error.exitCode !== 1) throw error;
    });
  }

  private async sourceIndexChanges(repositoryPath: string, userRoot: string, parent: string, index: string): Promise<Array<{ status: string; path: string }>> {
    const output = await this.run(['--git-dir', repositoryPath, '--work-tree', userRoot, 'diff-index', '--no-renames', '--name-status', '-z', parent], undefined, { GIT_INDEX_FILE: index }, undefined, [1]);
    const parts = output.toString('utf8').split('\0');
    const result: Array<{ status: string; path: string }> = [];
    for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i] && parts[i + 1]) result.push({ status: parts[i]!, path: parts[i + 1]! });
    return result;
  }

  private async sourceIndexUntracked(repositoryPath: string, userRoot: string, index: string): Promise<string[]> {
    const output = await this.run(['--git-dir', repositoryPath, '--work-tree', userRoot, 'ls-files', '--others', '--exclude-standard', '-z'], undefined, { GIT_INDEX_FILE: index });
    return output.toString('utf8').split('\0').filter(Boolean).map(path => { assertGitPath(path); return path; })
      .filter(path => !isExcludedSourcePath(path));
  }

  private async hashSourceEntry(repositoryPath: string, absolute: string, path: string, mode: number, symlink: boolean, timeout: number): Promise<GitTreeEntry> {
    const source = symlink ? Readable.from([Buffer.from(await readlink(absolute))]) : createReadStream(absolute);
    const oid = await this.text(['--git-dir', repositoryPath, 'hash-object', '--no-filters', '-w', '--stdin'], source, undefined, timeout);
    return { path, oid, mode: symlink ? '120000' : (mode & 0o111) ? '100755' : '100644', kind: symlink ? 'symlink' : 'file' };
  }

  async capture(repositoryPath: string, sourceRoot: string, parent: string, message: string, explicitPaths: string[] = []): Promise<string> {
    const longTimeout = this.options.longOperationTimeoutMs ?? 30 * 60 * 1_000;
    const tracked = new Set((await this.entries(repositoryPath, parent)).map(entry => entry.path));
    for (let retry = 0; retry < 3; retry++) {
      let files: ScannedFile[];
      try { files = await this.scan(sourceRoot, [...tracked, ...explicitPaths]); } catch (error) {
        if (String(error).includes('source_changing:')) continue;
        throw error;
      }
      const candidates = files.filter(file => !tracked.has(file.path) && !explicitPaths.includes(file.path));
      const ignored = candidates.length ? await this.run(['--git-dir', repositoryPath, '--work-tree', sourceRoot,
        'check-ignore', '--no-index', '-z', '--stdin'], candidates.map(file => file.path).join('\0') + '\0')
        .catch(error => { if (error instanceof WorkspaceGitCommandError && error.exitCode === 1) return Buffer.alloc(0); throw error; }) : Buffer.alloc(0);
      const ignoredPaths = new Set(ignored.toString('utf8').split('\0').filter(Boolean));
      const included = files.filter(file => !ignoredPaths.has(file.path));
      const index = join(repositoryPath, `metawork-index-${randomUUID()}`);
      try {
        await this.text(['--git-dir', repositoryPath, 'read-tree', '--empty'], undefined, { GIT_INDEX_FILE: index }, longTimeout);
        const rows: string[] = [];
        for (const file of included) {
          const digest = createHash('sha256');
          const source = file.kind === 'symlink'
            ? Readable.from([Buffer.from(await readlink(join(sourceRoot, file.path)))])
            : createReadStream(join(sourceRoot, file.path));
          const content = new Transform({ transform(chunk, _encoding, callback) { digest.update(chunk); callback(null, chunk); } });
          source.on('error', error => content.destroy(error));
          source.pipe(content);
          const oid = await this.text(['--git-dir', repositoryPath, 'hash-object', '--no-filters', '-w', '--stdin'], content, undefined, longTimeout);
          if (digest.digest('hex') !== file.sha256) throw new Error(`source_changing: ${file.path}`);
          rows.push(`${file.mode} ${oid}\t${file.path}\0`);
        }
        await this.text(['--git-dir', repositoryPath, 'update-index', '-z', '--index-info'], rows.join(''), { GIT_INDEX_FILE: index }, longTimeout);
        const tree = await this.text(['--git-dir', repositoryPath, 'write-tree'], undefined, { GIT_INDEX_FILE: index }, longTimeout);
        let second: ScannedFile[];
        try { second = await this.scan(sourceRoot, [...tracked, ...explicitPaths]); }
        catch(error) { if(String(error).includes('source_changing:'))continue; throw error; }
        if (fileSetDigest(files) !== fileSetDigest(second)) continue;
        if (tree === await this.text(['--git-dir', repositoryPath, 'rev-parse', `${parent}^{tree}`], undefined, undefined, longTimeout)) return parent;
        return await this.commitTree(repositoryPath, tree, [parent], message);
      } catch (error) {
        if (!String(error).includes('source_changing:')) throw error;
      } finally { await rm(index, { force: true }); }
    }
    throw new Error('source_changing: Workspace changed during three scans');
  }

  async scan(sourceRoot: string, retained: string[] = []): Promise<ScannedFile[]> {
    const result: ScannedFile[] = [];
    let bytes = 0;
    const walk = async (directory: string, prefix = ''): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.name.toLowerCase() === '.git' || (!prefix && item.name === '.metawork-tmp') || item.name.startsWith('.metawork-write-')) continue;
        if (EXCLUDED.has(item.name) && !retained.some(file => file === path || file.startsWith(`${path}/`))) continue;
        assertGitPath(path);
        const absolute = join(directory, item.name);
        if (item.isDirectory()) { await walk(absolute, path); continue; }
        if (!item.isFile() && !item.isSymbolicLink()) continue;
        const before = await lstat(absolute);
        if (before.size > (this.options.maxFileBytes ?? 1024 ** 3)) throw new Error(`workspace_file_limit: ${path}`);
        const sha256 = item.isSymbolicLink() ? createHash('sha256').update(await readlink(absolute)).digest('hex') : await hashFile(absolute);
        const after = await lstat(absolute);
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode) throw new Error(`source_changing: ${path}`);
        bytes += after.size;
        if (bytes > (this.options.maxTotalBytes ?? 20 * 1024 ** 3) || result.length >= (this.options.maxFiles ?? 100_000)) throw new Error(`workspace_capacity_limit: ${path}`);
        result.push({ path, mode: item.isSymbolicLink() ? '120000' : (after.mode & 0o111) ? '100755' : '100644',
          oid: '', kind: item.isSymbolicLink() ? 'symlink' : 'file', sha256, byteLength: after.size });
      }
    };
    for (const path of retained) assertGitPath(path);
    await walk(sourceRoot);
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  async entries(repositoryPath: string, commit: string): Promise<GitTreeEntry[]> {
    assertOid(commit);
    const output = await this.run(['--git-dir', repositoryPath, 'ls-tree', '-rz', '--full-tree', commit]);
    return output.toString('utf8').split('\0').filter(Boolean).map(row => {
      const tab = row.indexOf('\t');
      const [mode, type, oid] = row.slice(0, tab).split(' ');
      if (type !== 'blob') throw new Error('unsupported_git_entry');
      const path = row.slice(tab + 1); assertGitPath(path);
      return { path, mode, oid, kind: mode === '120000' ? 'symlink' : 'file' };
    });
  }

  async changedFiles(repositoryPath: string, from: string, to = 'HEAD'): Promise<Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>> {
    const output = await this.run(['--git-dir', repositoryPath, 'diff', '--no-renames', '--name-status', '-z', from, to]);
    const parts = output.toString('utf8').split('\0');
    const changes: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }> = [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
      changes.push({ path: parts[index + 1], status: parts[index] === 'A' ? 'added' : parts[index] === 'D' ? 'deleted' : 'modified' });
    }
    return changes;
  }


  async treeWithEntries(repositoryPath: string, base: string, changes: Array<{ path: string; entry: GitTreeEntry | null }>): Promise<string> {
    const index = join(repositoryPath, `metawork-index-${randomUUID()}`);
    try {
      await this.text(['--git-dir', repositoryPath, 'read-tree', base], undefined, { GIT_INDEX_FILE: index });
      await this.updateIndex(repositoryPath, changes, { GIT_INDEX_FILE: index });
      return await this.text(['--git-dir', repositoryPath, 'write-tree'], undefined, { GIT_INDEX_FILE: index });
    } finally { await rm(index, { force: true }); }
  }
  async updateIndex(repositoryPath: string, changes: Array<{ path: string; entry: GitTreeEntry | null }>, env: NodeJS.ProcessEnv): Promise<void> {
    const rows: string[] = [];
    for (const { path, entry } of changes) {
      assertGitPath(path);
      rows.push(`0 ${'0'.repeat(40)}\t${path}\0`);
      if (entry) rows.push(`${entry.mode} ${entry.oid}\t${path}\0`);
    }
    await this.run(['--git-dir', repositoryPath, 'update-index', '-z', '--index-info'], rows.join(''), env);
  }
  async integrationIndex(root: WorkspaceGitRoot): Promise<string> {
    return this.text(['-C', root.integrationPath, 'rev-parse', '--path-format=absolute', '--git-path', 'index']);
  }

  /** Bounded-memory range reader, including binary Office versions. */
  async blobRange(repositoryPath: string, oid: string, offset: number, length: number): Promise<Buffer> {
    assertOid(oid);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 256 * 1024) throw new Error('invalid_blob_range');
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, {GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'});
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.gitCommand ?? 'git', ['--git-dir', repositoryPath, 'cat-file', 'blob', oid], {env, stdio: ['ignore', 'pipe', 'pipe']});
      const chunks: Buffer[] = []; let position = 0; let diagnostic = '';
      const timeout = setTimeout(() => { child.kill(); reject(new Error('git_blob_read_timeout')); }, 120_000);
      child.stdout.on('data', (chunk: Buffer) => {
        const start = Math.max(0, offset - position), end = Math.min(chunk.length, offset + length - position);
        if (end > start) chunks.push(Buffer.from(chunk.subarray(start, end)));
        position += chunk.length;
      });
      child.stderr.on('data', (chunk: Buffer) => { if (diagnostic.length < 2000) diagnostic += chunk.toString(); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', code => { clearTimeout(timeout); if (code === 0) resolve(Buffer.concat(chunks)); else reject(new Error(`git_blob_read_failed:${diagnostic}`)); });
    });
  }
  async blob(repositoryPath: string, oid: string): Promise<Buffer> { assertOid(oid); return this.run(['--git-dir', repositoryPath, 'cat-file', 'blob', oid]); }
  async ref(repositoryPath: string, ref: string): Promise<string> { return this.text(['--git-dir', repositoryPath, 'rev-parse', '--verify', ref]); }
  async updateRef(repositoryPath: string, ref: string, commit: string, expected?: string): Promise<void> {
    assertOid(commit);
    await this.text(['--git-dir', repositoryPath, 'update-ref', ref, commit, ...(expected ? [expected] : [])]);
  }
  async commitTree(repositoryPath: string, tree: string, parents: string[], message: string): Promise<string> {
    return this.text(['--git-dir', repositoryPath, 'commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message]);
  }
  async isAncestor(repositoryPath: string, from: string, to: string): Promise<boolean> {
    return this.text(['--git-dir', repositoryPath, 'merge-base', '--is-ancestor', from, to]).then(() => true, error => { if (error instanceof WorkspaceGitCommandError && error.exitCode === 1) return false; throw error; });
  }
  async commitExists(repositoryPath: string, commit: string): Promise<boolean> {
    assertOid(commit); return this.text(['--git-dir', repositoryPath, 'cat-file', '-e', `${commit}^{commit}`]).then(() => true, () => false);
  }
  async removeConversation(worktree: ConversationGitWorktree): Promise<void> {
    if(await exists(worktree.rootPath)) {
      await this.validateWorktree(worktree);
      await this.text(['--git-dir', worktree.repositoryPath, 'worktree', 'remove', worktree.rootPath]);
    }
    const registry=await this.text(['--git-dir',worktree.repositoryPath,'worktree','list','--porcelain','-z']);
    if(registry.split('\0').includes(`worktree ${worktree.rootPath}`))throw new Error('conversation_cleanup_registry_requires_recovery');
    const ref=`refs/heads/${worktree.branch}`;
    const head=await this.ref(worktree.repositoryPath,ref).catch(()=>null);
    if(head) {
      if(head!==worktree.headCommit)throw new Error('conversation_cleanup_head_changed');
      await this.text(['--git-dir',worktree.repositoryPath,'update-ref','-d',ref,head]);
    }
  }
  async prepareMergeAttributes(repositoryPath: string, commits: string[]): Promise<void> {
    const paths = new Map<string, GitTreeEntry>();
    for (const commit of commits) for (const entry of await this.entries(repositoryPath, commit)) paths.set(entry.path,entry);
    const rules: string[] = ['** -filter -text -ident -working-tree-encoding merge=text'];
    for (const entry of paths.values()) {
      // Only one blob at a time; never retain a Workspace-sized collection of buffers.
      const content = BINARY.test(entry.path) ? null : await this.blob(repositoryPath, entry.oid);
      const binary = !content || content.includes(0) || !Buffer.from(content.toString('utf8')).equals(content);
      rules.push(`${JSON.stringify(entry.path)} -filter -text -ident -working-tree-encoding merge=${binary ? 'binary' : 'text'}`);
    }
    await writeFile(join(repositoryPath, 'info', 'attributes'), [...rules,''].join('\n'));
  }
}

export function assertOid(value: string): void { if (!OID.test(value)) throw new Error('invalid_git_oid'); }
export function assertGitPath(path: string): void {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some(segment => !segment || segment === '..' || segment === '.' || segment.toLowerCase() === '.git')) throw new Error('invalid_git_path');
}
function isExcludedSourcePath(path: string): boolean {
  const segments = path.split('/');
  return segments.some(segment => EXCLUDED.has(segment) || segment.startsWith('.metawork-write-'))
    || segments[0] === '.metawork-tmp';
}
function within(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); }
async function exists(path: string): Promise<boolean> { return lstat(path).then(() => true, () => false); }
interface ScannedFile extends GitTreeEntry { sha256:string; byteLength:number; }
function fileSetDigest(files: ScannedFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file.path).update('\0').update(file.mode).update('\0').update(file.sha256).update('\0');
  return hash.digest('hex');
}
export async function workspaceGitFileHash(path: string): Promise<string | null> {
  return readFile(path).then(data => createHash('sha256').update(data).digest('hex'), () => null);
}

async function hashFile(path:string):Promise<string> {
  const hash=createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
