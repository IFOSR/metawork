import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GatewayEventEnvelope, GatewayReplay } from '../../src/gateway/client-events.js';
import type {
  ConversationSnapshot, JournalSegment, JournalStreamState,
} from '../../src/gateway/event-journal-segment-index.js';

interface DiskState {
  state: JournalStreamState | null;
  segments: JournalSegment[];
  events: { eventId: string; sequence: number; segmentId: string }[];
  files: string[];
  legacySha256: string;
  integrity: { integrity_check: string }[];
  foreignKeys: unknown[];
}

interface RecoveryResult {
  before: DiskState;
  replay: GatewayReplay;
  snapshot: ConversationSnapshot;
  resume: GatewayReplay;
  duplicate: GatewayEventEnvelope;
  retry: GatewayEventEnvelope[];
  recovered: GatewayReplay;
  disk: DiskState;
}

let bundleRoot: string;
let fixturePath: string;
const roots: string[] = [];
const require = createRequire(import.meta.url);

beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), 'journal-recovery-bundle-'));
  fixturePath = join(bundleRoot, 'fixture.cjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../fixtures/account-journal-process-recovery.ts', import.meta.url))],
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
  const root = await mkdtemp(join(tmpdir(), 'account-journal-process-'));
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
          return reject(new Error(`fixture did not reach the kill boundary: ${code}/${signal}\n${stdout}\n${stderr}`));
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

function assertDisk(disk: DiskState, count: number) {
  expect(disk.state?.lastSequence).toBe(count);
  expect(disk.events.map(row => row.eventId)).toEqual(ids(count));
  expect(disk.events.map(row => row.sequence)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
  expect(disk.integrity).toEqual([{ integrity_check: 'ok' }]);
  expect(disk.foreignKeys).toEqual([]);
  for (const event of disk.events) {
    expect(disk.segments.some(segment => segment.id === event.segmentId
      && segment.firstSequence <= event.sequence && segment.lastSequence >= event.sequence)).toBe(true);
  }
}

function ids(count: number) {
  return Array.from({ length: count }, (_, i) => `event_${i + 1}`);
}

// SIGKILL is a process-crash gate, not a power-loss or multi-writer guarantee.
describe.skipIf(process.platform === 'win32')('account journal process recovery', () => {
  for (const operation of ['import', 'append', 'compact'] as const) {
    it.each(['before', 'during', 'after'] as const)(
      `reopens after SIGKILL %s the ${operation} index transaction`,
      async phase => {
        const root = await fixtureRoot();
        const seed = await child<{
          disk: DiskState; legacy: { events: GatewayEventEnvelope[] };
        }>(root, ['seed', operation]);
        const paused = await child<{
          operation: string; phase: string; inTransaction: boolean;
        }>(root, ['interrupt', operation, phase], true);
        expect(paused).toMatchObject({ operation, phase, inTransaction: phase === 'during' });
        const recovered = await child<RecoveryResult>(root, ['recover', operation]);
        const committed = phase === 'after';
        const beforeCount = operation === 'import' ? 3 : operation === 'append' && committed ? 7 : 5;
        if (operation === 'import' && !committed) {
          expect(recovered.before.state).toBeNull();
          expect(recovered.before.events).toEqual([]);
          expect(recovered.before.segments).toEqual([]);
        } else {
          assertDisk(recovered.before, beforeCount);
        }
        if (operation !== 'import' && (operation === 'compact' || !committed)) {
          expect(recovered.before.state).toEqual(seed.disk.state);
        }
        const oldSegments = seed.disk.segments.length;
        if (operation === 'compact') {
          expect(oldSegments).toBeGreaterThan(1);
          expect(recovered.before.segments).toHaveLength(committed ? 1 : oldSegments);
          // Replacement body is durable, but old-file unlink has not run.
          expect(recovered.before.files).toHaveLength(oldSegments + 1);
        } else {
          // The body exists in every case, including an uncommitted orphan.
          expect(recovered.before.files).toHaveLength(oldSegments + 1);
        }
        expect(recovered.replay.lastSequence).toBe(beforeCount);
        expect(recovered.replay.deltas.map(row => row.eventId)).toEqual(ids(beforeCount));
        expect(recovered.replay.deltas.slice(0, 3)).toEqual(seed.legacy.events);
        expect(recovered.snapshot).toMatchObject({
          lastSequence: beforeCount, snapshot: recovered.replay.snapshot, deltas: [],
        });
        expect(recovered.resume.cursorReset).toBeUndefined();
        expect(recovered.resume.deltas.map(row => row.eventId)).toEqual(
          operation === 'import' ? ids(3) : operation === 'append' && committed ? ['event_6', 'event_7'] : [],
        );
        expect(recovered.duplicate).toEqual(seed.legacy.events[0]);
        const afterCount = operation === 'import' ? 4 : operation === 'append' ? 7 : 6;
        expect(recovered.retry.map(row => row.sequence)).toEqual(
          operation === 'append' ? [6, 7] : [afterCount],
        );
        if (operation === 'append' && committed) {
          expect(recovered.retry).toEqual(recovered.replay.deltas.slice(-2));
        }
        assertDisk(recovered.disk, afterCount);
        expect(recovered.recovered.deltas.slice(0, beforeCount)).toEqual(recovered.replay.deltas);
        expect(recovered.recovered.deltas.map(row => row.eventId)).toEqual(ids(afterCount));
        expect(recovered.disk.files).toEqual(recovered.disk.segments.map(row => `${row.id}.json`).sort());
        expect(recovered.before.legacySha256).toBe(seed.disk.legacySha256);
        expect(recovered.disk.legacySha256).toBe(seed.disk.legacySha256);
        const reopened = await child<{
          disk: DiskState; replay: GatewayReplay; snapshot: ConversationSnapshot;
        }>(root, ['read']);
        expect(reopened.replay).toEqual(recovered.recovered);
        assertDisk(reopened.disk, afterCount);
      },
      30_000,
    );
  }

  it('does not equate an unchanged legacy file or database backup with lossless post-write rollback', async () => {
    const root = await fixtureRoot();
    const seed = await child<{ disk: DiskState }>(root, ['seed', 'import']);
    const result = await child<{
      backup: { sha256: string; schemaVersion: number };
      before: DiskState; disk: DiskState; oldState: JournalStreamState;
      current: GatewayReplay; legacy: { lastSequence: number; events: GatewayEventEnvelope[] };
    }>(root, ['rollback-boundary']);
    expect(result.backup.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.oldState.lastSequence).toBe(3);
    expect(result.legacy.lastSequence).toBe(3);
    expect(result.legacy.events.map(row => row.eventId)).toEqual(ids(3));
    expect(result.disk.legacySha256).toBe(seed.disk.legacySha256);
    expect(result.current.lastSequence).toBe(4);
    expect(result.current.deltas.map(row => row.eventId)).toEqual(ids(4));
    assertDisk(result.disk, 4);
  });

  it('exposes the missing segment-body gate when restoring a SQLite-only backup after compaction', async () => {
    const root = await fixtureRoot();
    const seed = await child<{ disk: DiskState }>(root, ['seed', 'compact']);
    const result = await child<{
      oldState: JournalStreamState;
      oldSegments: JournalSegment[];
      rollbackReadError: string | null;
      current: GatewayReplay;
      disk: DiskState;
    }>(root, ['backup-compaction-boundary']);
    expect(result.oldState).toEqual(seed.disk.state);
    expect(result.oldSegments).toEqual(seed.disk.segments);
    expect(result.rollbackReadError).toBe('ENOENT');
    for (const segment of result.oldSegments) {
      expect(result.disk.files).not.toContain(`${segment.id}.json`);
    }
    expect(result.current.deltas.map(row => row.eventId)).toEqual(ids(5));
    assertDisk(result.disk, 5);
    expect(result.disk.legacySha256).toBe(seed.disk.legacySha256);
  });
});
