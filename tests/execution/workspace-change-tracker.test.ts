import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { captureWorkspaceState, deriveWorkspaceDelta } from '../../src/execution/workspace-change-tracker.js';

describe('workspace change tracker', () => {
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
});
