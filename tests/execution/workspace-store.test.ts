import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceStore } from '../../src/execution/workspace-store.js';

describe('WorkspaceStore', () => {
  let temporaryRoot = '';

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'metaclaw-workspace-store-'));
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  test('persists a workspace across attempts and deduplicates objects by hash', async () => {
    const source = join(temporaryRoot, 'source');
    await mkdir(source);
    await writeFile(join(source, 'a.txt'), 'same content');
    await writeFile(join(source, 'b.txt'), 'same content');
    const store = new WorkspaceStore(join(temporaryRoot, 'store'));
    await store.initialize();
    const workspace = await store.ensureWorkspace({ taskId: 't1', generationId: 'g1', subtaskId: 's1' }, 'directory');
    await store.seedDirectory(workspace, source);
    const checkpoint = await store.createCheckpoint(workspace, { reason: 'attempt_start', attemptId: 'a1', now: '2026-07-22T00:00:00.000Z' });
    const files = checkpoint.manifest.entries.filter(entry => entry.type === 'file');
    expect(files).toHaveLength(2);
    expect(new Set(files.map(entry => entry.hash)).size).toBe(1);

    await writeFile(join(workspace.filesPath, 'a.txt'), 'changed');
    await store.restoreCheckpoint(workspace, checkpoint.manifestPath);
    expect(await readFile(join(workspace.filesPath, 'a.txt'), 'utf8')).toBe('same content');
  });

  test('rejects workspace identity traversal', async () => {
    const store = new WorkspaceStore(join(temporaryRoot, 'store'));
    await expect(store.ensureWorkspace({ taskId: '..', generationId: 'g', subtaskId: 's' }, 'directory')).rejects.toThrow();
  });

  test('seeds and checkpoints workspaces containing virtualenv symlinks', async () => {
    const source = join(temporaryRoot, 'source');
    await mkdir(join(source, '.venv', 'bin'), { recursive: true });
    await writeFile(join(source, '.venv', 'bin', 'activate'), 'venv payload\n');
    await writeFile(join(source, '.venv', 'bin', 'python3.13'), 'binary placeholder\n');
    await symlink('python3.13', join(source, '.venv', 'bin', 'python'));
    await writeFile(join(source, 'report.md'), 'task content\n');
    const store = new WorkspaceStore(join(temporaryRoot, 'store'));
    await store.initialize();
    const workspace = await store.ensureWorkspace({ taskId: 't-venv', generationId: 'g-venv', subtaskId: 's-venv' }, 'directory');

    await store.seedDirectory(workspace, source);
    const checkpoint = await store.createCheckpoint(workspace, { reason: 'attempt_start', attemptId: 'a-venv', now: '2026-07-22T00:00:00.000Z' });
    const paths = checkpoint.manifest.entries.map(entry => entry.path);
    expect(paths).toContain('report.md');
    expect(paths.some(path => path.startsWith('.venv/'))).toBe(false);
  });

  test('checkpoints skip non-representable entries without failing the attempt', async () => {
    const source = join(temporaryRoot, 'source');
    await mkdir(source);
    await writeFile(join(source, 'data.txt'), 'payload\n');
    await symlink('data.txt', join(source, 'data-link.txt'));
    const store = new WorkspaceStore(join(temporaryRoot, 'store'));
    await store.initialize();
    const workspace = await store.ensureWorkspace({ taskId: 't-skip', generationId: 'g-skip', subtaskId: 's-skip' }, 'directory');
    await mkdir(workspace.filesPath, { recursive: true });
    await writeFile(join(workspace.filesPath, 'data.txt'), 'payload\n');
    await symlink('data.txt', join(workspace.filesPath, 'data-link.txt'));

    const checkpoint = await store.createCheckpoint(workspace, { reason: 'attempt_start', attemptId: 'a-skip', now: '2026-07-22T00:00:00.000Z' });
    const paths = checkpoint.manifest.entries.map(entry => entry.path);
    expect(paths).toContain('data.txt');
    expect(paths).not.toContain('data-link.txt');
  });
});
