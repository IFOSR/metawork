import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DirectoryProjectionState } from '../../src/workspace/workspace-directory-projection.js';
import type { WorkspaceConversationSummary } from '../../src/workspace/workspace-conversation-projector.js';

interface DiskState {
  state: DirectoryProjectionState | null;
  progress: { token: string; rebuildId: string; cursor: string; sourceConfirmed: boolean } | null;
  rows: WorkspaceConversationSummary[];
  candidates: string[];
  observations: { conversationId: string; rebuildId: string; removed: number }[];
  other: {
    state: DirectoryProjectionState | null;
    rows: WorkspaceConversationSummary[];
    candidates: string[];
    revisions: { workspace_id: string; revision: number }[];
  };
  pageIds: string[];
  pageSizes: number[];
  pageError: string | null;
  sourceSha256: string;
  integrity: { integrity_check: string }[];
  foreignKeys: unknown[];
}

interface RecoveryResult {
  before: DiskState;
  activityReads: string[][];
  disk: DiskState;
}

const require = createRequire(import.meta.url);
let bundleRoot: string;
let fixturePath: string;
const roots: string[] = [];
const validIds = Array.from({ length: 7 }, (_, i) => `conv_00${i}`);

beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), 'directory-recovery-bundle-'));
  fixturePath = join(bundleRoot, 'fixture.cjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../fixtures/workspace-directory-process-recovery.ts', import.meta.url))],
    outfile: fixturePath, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    plugins: [{
      name: 'native-sqlite',
      setup(builder) {
        builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({
          path: require.resolve('better-sqlite3'), external: true,
        }));
      },
    }],
  });
});

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  if (bundleRoot) await rm(bundleRoot, { recursive: true, force: true });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'workspace-directory-process-'));
  roots.push(root);
  return root;
}

function child<T>(root: string, args: string[], killAtPause = false): Promise<T> {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [fixturePath, root, ...args], {
      cwd: root,
      env: { HOME: root, USERPROFILE: root, TMPDIR: root, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let paused: { paused: boolean; operation: string; phase: string; inTransaction: boolean } | null = null;
    let error: Error | null = null;
    const timer = setTimeout(() => {
      error = new Error(`fixture timed out: ${args.join(' ')}\n${stdout}\n${stderr}`);
      process.kill('SIGKILL');
    }, 15_000);
    process.stderr.on('data', chunk => { stderr += String(chunk); });
    process.stdout.on('data', chunk => {
      stdout += String(chunk);
      if (killAtPause && !paused && stdout.includes('\n')) {
        try {
          paused = JSON.parse(stdout.slice(0, stdout.indexOf('\n')));
          if (!paused?.paused) throw new Error(`expected a pause handshake: ${stdout}`);
        } catch (cause) {
          error = cause instanceof Error ? cause : new Error(String(cause));
        }
        process.kill('SIGKILL');
      }
    });
    process.on('error', cause => { error = cause; });
    process.on('close', (code, signal) => {
      clearTimeout(timer);
      if (error) return reject(error);
      if (killAtPause) {
        if (!paused || signal !== 'SIGKILL' || code !== null) {
          return reject(new Error(`fixture did not reach kill boundary: ${code}/${signal}\n${stdout}\n${stderr}`));
        }
        return resolve(paused as T);
      }
      if (code !== 0 || signal) {
        return reject(new Error(`fixture failed: ${code}/${signal}\n${stdout}\n${stderr}`));
      }
      try { resolve(JSON.parse(stdout.trim()) as T); }
      catch (cause) { reject(cause); }
    });
  });
}

function assertHealthy(disk: DiskState, seed: DiskState): void {
  expect(disk.integrity).toEqual([{ integrity_check: 'ok' }]);
  expect(disk.foreignKeys).toEqual([]);
  expect(disk.other).toEqual(seed.other);
  expect(disk.sourceSha256).toBe(seed.sourceSha256);
}

function assertComplete(disk: DiskState, seed: DiskState, ids = validIds): void {
  assertHealthy(disk, seed);
  expect(disk.state).toMatchObject({ status: 'ready', checkpoint: 'conv_006' });
  expect(disk.rows.map(row => row.conversationId)).toEqual(ids);
  expect(new Set(disk.pageIds).size).toBe(ids.length);
  expect([...disk.pageIds].sort()).toEqual(ids);
  expect(disk.pageSizes).toEqual([2, 2, 2, 1]);
  expect(disk.pageError).toBeNull();
  expect(disk.candidates).toEqual([]);
}

// Real process-crash acceptance, not a power-loss or concurrent-writer guarantee.
describe.skipIf(process.platform === 'win32')('Workspace directory process recovery', () => {
  for (const operation of ['batch', 'completion'] as const) {
    it.each(['before', 'during', 'after'] as const)(
      `resumes after SIGKILL %s the ${operation} transaction`,
      async phase => {
        const root = await fixtureRoot();
        const seed = (await child<{ disk: DiskState }>(root, ['seed'])).disk;
        const paused = await child<{ operation: string; phase: string; inTransaction: boolean }>(
          root, ['interrupt', operation, phase], true,
        );
        expect(paused).toMatchObject({ operation, phase, inTransaction: phase === 'during' });
        const recovered = await child<RecoveryResult>(root, ['recover']);
        assertHealthy(recovered.before, seed);
        const completed = operation === 'completion' && phase === 'after';
        const checkpoint = operation === 'completion' ? 'conv_006' : phase === 'after' ? 'conv_003' : 'conv_001';
        expect(recovered.before.state).toMatchObject({
          status: completed ? 'ready' : 'building', checkpoint,
        });
        expect(recovered.before.pageError).toBe(completed ? null : 'directory_rebuilding');
        const imported = operation === 'completion' ? 7 : phase === 'after' ? 4 : 2;
        expect(recovered.before.rows.filter(row => validIds.includes(row.conversationId)).map(row => row.conversationId))
          .toEqual(validIds.slice(0, imported));
        expect(recovered.before.candidates).toHaveLength(operation === 'batch' ? 207 : completed ? 0 : 7);
        expect(recovered.activityReads.flat()).toEqual(completed ? validIds : validIds.slice(imported));
        expect(recovered.activityReads.every(batch => batch.length <= 2)).toBe(true);
        if (!completed) {
          expect(recovered.disk.progress?.rebuildId).toBe(recovered.before.progress?.rebuildId);
          expect(recovered.disk.progress?.token).not.toBe(recovered.before.progress?.token);
        }
        assertComplete(recovered.disk, seed);
        for (const row of recovered.disk.rows) {
          expect(row.activity).toMatchObject({ state: 'blocked', taskId: `task_${row.conversationId}` });
        }
        const reopened = await child<{ disk: DiskState }>(root, ['read']);
        expect(reopened.disk).toEqual(recovered.disk);
      },
      30_000,
    );
  }

  it('resumes a committed bounded deletion sweep without lost rows or cross-account deletion', async () => {
    const root = await fixtureRoot();
    const seed = (await child<{ disk: DiskState }>(root, ['seed'])).disk;
    const paused = await child<{ inTransaction: boolean }>(root, ['interrupt', 'sweep', 'after'], true);
    expect(paused.inTransaction).toBe(false);
    const recovered = await child<RecoveryResult>(root, ['recover']);
    assertHealthy(recovered.before, seed);
    expect(recovered.before.state).toMatchObject({ status: 'building', checkpoint: 'conv_006' });
    expect(recovered.before.candidates).toHaveLength(107);
    expect(recovered.before.rows).toHaveLength(114);
    expect(recovered.before.pageError).toBe('directory_rebuilding');
    expect(recovered.activityReads).toEqual([]);
    expect(recovered.disk.progress?.rebuildId).toBe(recovered.before.progress?.rebuildId);
    assertComplete(recovered.disk, seed);
    expect((await child<{ disk: DiskState }>(root, ['read'])).disk).toEqual(recovered.disk);
  }, 30_000);

  it('retains live metadata, creation and unbinding guards across a killed rebuild', async () => {
    const root = await fixtureRoot();
    const seed = (await child<{ disk: DiskState }>(root, ['seed'])).disk;
    const paused = await child<{ inTransaction: boolean }>(root, ['interrupt', 'live', 'after'], true);
    expect(paused.inTransaction).toBe(false);
    const recovered = await child<RecoveryResult>(root, ['recover']);
    expect(recovered.before.state).toMatchObject({ status: 'building', checkpoint: 'conv_001' });
    expect(recovered.before.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: 'conv_004', removed: 0 }),
      expect.objectContaining({ conversationId: 'conv_005', removed: 1 }),
      expect.objectContaining({ conversationId: 'conv_live', removed: 0 }),
    ]));
    expect(recovered.activityReads.flat()).toEqual(validIds.slice(2));
    expect(recovered.disk.progress?.rebuildId).toBe(recovered.before.progress?.rebuildId);
    assertComplete(recovered.disk, seed, [...validIds.filter(id => id !== 'conv_005'), 'conv_live']);
    expect(recovered.disk.rows.find(row => row.conversationId === 'conv_004')?.title)
      .toBe('Live title, unchanged timestamp');
    expect(recovered.disk.rows.find(row => row.conversationId === 'conv_005')).toBeUndefined();
    expect((await child<{ disk: DiskState }>(root, ['read'])).disk).toEqual(recovered.disk);
  }, 30_000);
});
