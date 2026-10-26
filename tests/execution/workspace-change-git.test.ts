import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureGitSnapshot } from '../../src/execution/workspace-change-git.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'metawork-git-snapshot-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  writeFileSync(join(root, 'README.md'), 'one\ntwo\n');
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return root;
}

describe('Git snapshot channel', () => {
  it('diffs two captures by tree and reports per-file line counts', () => {
    const root = repository();
    const before = captureGitSnapshot({ workspaceRoot: root });
    expect(before.status).toBe('ok');
    if (before.status !== 'ok') return;

    writeFileSync(join(root, 'README.md'), 'one\ntwo\nthree\nfour\n');
    writeFileSync(join(root, 'new.md'), 'alpha\n');
    execFileSync('git', ['rm', '-q', '--cached', 'README.md'], { cwd: root });
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    rmSync(join(root, 'README.md'));
    writeFileSync(join(root, 'README.md'), 'one\ntwo\nthree\nfour\n');

    const after = captureGitSnapshot({ workspaceRoot: root, baselineTree: before.snapshot.tree });
    expect(after.status).toBe('ok');
    if (after.status !== 'ok') return;
    expect(after.snapshot.baselineTree).toBe(before.snapshot.tree);
    const files = Object.fromEntries(after.snapshot.files.map(file => [file.path, file]));
    expect(files['README.md']).toMatchObject({ added: 2, deleted: 0 });
    expect(files['new.md']).toMatchObject({ added: 1, deleted: 0 });
  });

  it('keeps a dirty baseline tree available across the before/after pair', () => {
    const root = repository();
    writeFileSync(join(root, 'README.md'), 'base change\n');
    const scratch = mkdtempSync(join(tmpdir(), 'metawork-git-snapshot-session-'));
    roots.push(scratch);
    const before = captureGitSnapshot({ workspaceRoot: root, scratchDirectory: scratch });
    expect(before.status).toBe('ok');
    if (before.status !== 'ok') return;

    writeFileSync(join(root, 'README.md'), 'base change\nround change\n');
    const after = captureGitSnapshot({
      workspaceRoot: root,
      baselineTree: before.snapshot.tree,
      scratchDirectory: scratch,
    });
    expect(after.status).toBe('ok');
    if (after.status !== 'ok') return;
    expect(after.snapshot.files).toEqual([
      expect.objectContaining({ path: 'README.md', added: 1, deleted: 0 }),
    ]);
  });

  it('reports deletions and renames instead of dropping them', () => {
    const root = repository();
    const before = captureGitSnapshot({ workspaceRoot: root });
    if (before.status !== 'ok') throw new Error('baseline capture failed');

    rmSync(join(root, 'README.md'));
    writeFileSync(join(root, 'notes.md'), 'one\ntwo\n');
    const after = captureGitSnapshot({ workspaceRoot: root, baselineTree: before.snapshot.tree });
    if (after.status !== 'ok') throw new Error('capture failed');

    // A rename is one change entry naming its destination, which is what the
    // record has to show; the source is implied and never silently dropped as a
    // separate "no-op".
    expect(after.snapshot.files.map(file => file.path)).toEqual(['notes.md']);
  });

  it('reports ignored paths so coverage cannot claim completeness', () => {
    const root = repository();
    const before = captureGitSnapshot({ workspaceRoot: root });
    if (before.status !== 'ok') throw new Error('baseline capture failed');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'app.js'), 'built');
    const after = captureGitSnapshot({ workspaceRoot: root, baselineTree: before.snapshot.tree });
    if (after.status !== 'ok') throw new Error('capture failed');

    // The build output is invisible to the tree diff...
    expect(after.snapshot.files.map(file => file.path)).not.toContain('dist/app.js');
    // ...but the channel says so.
    expect(after.snapshot.ignoredPaths).toContain('dist/app.js');
  });

  it('never writes the user index or objects', () => {
    const root = repository();
    writeFileSync(join(root, 'staged.md'), 'staged\n');
    execFileSync('git', ['add', 'staged.md'], { cwd: root });
    const statusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });

    expect(captureGitSnapshot({ workspaceRoot: root }).status).toBe('ok');

    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }))
      .toBe(statusBefore);
  });

  it('classifies a non-repository Workspace instead of pretending it is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'metawork-git-snapshot-norepo-'));
    roots.push(root);
    const result = captureGitSnapshot({ workspaceRoot: root });
    expect(result.status).toBe('not_repository');
  });

  it('classifies an ignored-path listing that exceeds the output bound', () => {
    const root = repository();
    mkdirSync(join(root, 'dist'), { recursive: true });
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(root, 'dist', `file-${index}.js`), 'built');
    }
    const result = captureGitSnapshot({
      workspaceRoot: root,
      limits: { maxOutputBytes: 32 },
    });
    expect(result.status).toBe('output_limited');
  });
});
