import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { captureWorkspaceState, captureWorkspaceStateAtPaths, deriveWorkspaceDelta, parseWorkspaceDelta } from '../../src/execution/workspace-change-tracker.js';

describe('workspace change tracker', () => {
  it('excludes runtime inputs from capture and old observations without excluding similarly named business files', () => {
    const root = mkdtempSync(join(tmpdir(), 'metawork-runtime-inputs-'));
    try {
      spawnSync('git', ['init'], { cwd: root });
      const before = captureWorkspaceState(root);
      mkdirSync(join(root, '.metawork-tmp', 'attempt', 'inputs'), { recursive: true });
      writeFileSync(join(root, '.metawork-tmp', 'attempt', 'inputs', 'upstream.md'), 'input');
      writeFileSync(join(root, '.metawork-tmp-report.md'), 'business result');
      writeFileSync(join(root, 'report.md'), 'report');
      const delta = deriveWorkspaceDelta(before, captureWorkspaceState(root));
      expect(delta.changed.map(item => item.path)).toEqual(['.metawork-tmp-report.md', 'report.md']);
      const historical = { ...delta, changed: [...delta.changed,
        { path: '.metawork-tmp/attempt/inputs/upstream.md', beforeHash: null, afterHash: 'old-input-hash' }] };
      expect(parseWorkspaceDelta(historical)).toEqual(delta);
      expect(historical.changed).toHaveLength(3);
      expect(captureWorkspaceStateAtPaths(root, ['.metawork-tmp', 'report.md']).paths)
        .toEqual({ 'report.md': delta.changed[1]!.afterHash });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('does not attribute unchanged user dirty files to an attempt', () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-workspace-delta-'));
    try {
      spawnSync('git', ['init'], { cwd: root });
      writeFileSync(join(root, 'user-dirty.txt'), 'user change');
      const before = captureWorkspaceState(root);
      writeFileSync(join(root, 'attempt.txt'), 'attempt change');
      const delta = deriveWorkspaceDelta(before, captureWorkspaceState(root));

      expect(delta).toMatchObject({
        changed: [expect.objectContaining({ path: 'attempt.txt', beforeHash: null })],
      });
      expect(JSON.stringify(delta)).not.toContain('user-dirty.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tracks ordinary files in a non-Git Workspace within the authorized target scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-non-git-delta-'));
    try {
      writeFileSync(join(root, 'hello.py'), 'print("before")\n');
      writeFileSync(join(root, 'outside.txt'), 'must stay out of the observation\n');
      const before = captureWorkspaceStateAtPaths(root, ['hello.py']);
      writeFileSync(join(root, 'hello.py'), 'print("after")\n');
      writeFileSync(join(root, 'outside.txt'), 'changed outside the authorized target\n');
      const delta = deriveWorkspaceDelta(before, captureWorkspaceStateAtPaths(root, ['hello.py']));

      expect(before.source).toBe('filesystem');
      expect(delta.changed).toEqual([
        expect.objectContaining({ path: 'hello.py' }),
      ]);
      expect(JSON.stringify(delta)).not.toContain('outside.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects a newly created target file in a non-Git Workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-non-git-create-'));
    try {
      const before = captureWorkspaceStateAtPaths(root, ['hello.py']);
      writeFileSync(join(root, 'hello.py'), 'print("Hello, World!")\n');
      const delta = deriveWorkspaceDelta(before, captureWorkspaceStateAtPaths(root, ['hello.py']));

      expect(delta.changed).toEqual([
        expect.objectContaining({ path: 'hello.py', beforeHash: null }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tracks deletions and nested files for an authorized directory target', () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-non-git-directory-delta-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'keep.ts'), 'const keep = true;\n');
      writeFileSync(join(root, 'src', 'remove.ts'), 'const remove = true;\n');
      const before = captureWorkspaceStateAtPaths(root, ['src']);
      rmSync(join(root, 'src', 'remove.ts'));
      writeFileSync(join(root, 'src', 'keep.ts'), 'const keep = false;\n');
      const delta = deriveWorkspaceDelta(before, captureWorkspaceStateAtPaths(root, ['src']));

      expect(delta.changed.map(change => change.path)).toEqual(['src/keep.ts', 'src/remove.ts']);
      expect(delta.changed.find(change => change.path === 'src/remove.ts')).toMatchObject({
        beforeHash: expect.any(String),
        afterHash: null,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds a non-Git directory observation instead of certifying a truncated baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-non-git-truncated-delta-'));
    try {
      mkdirSync(join(root, 'generated'), { recursive: true });
      for (let index = 0; index < 2_001; index += 1) {
        writeFileSync(join(root, 'generated', `file-${index}.txt`), `${index}\n`);
      }
      const state = captureWorkspaceStateAtPaths(root, ['generated']);

      expect(state.truncated).toBe(true);
      expect(Object.keys(state.paths).length).toBeLessThanOrEqual(2_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
