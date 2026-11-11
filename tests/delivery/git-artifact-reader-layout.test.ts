import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import {
  internalRootFromArtifactObjectRoot,
  workspaceGitRepositoryPath,
} from '../../src/execution/workspace-git-service.js';

// Convergence review §4.2: the pinned-artifact reader must not guess a
// neighbouring repository root. Writer and reader share one layout contract.
describe('private Git layout contract', () => {
  const internalRoot = '/data';
  const workspaceStore = join(internalRoot, 'workspace-store');
  const artifactObjectRoot = join(workspaceStore, 'objects', 'sha256', 'artifacts');

  it('derives the repository the writer creates from the artifact object root', () => {
    expect(internalRootFromArtifactObjectRoot(artifactObjectRoot)).toBe(internalRoot);
    expect(workspaceGitRepositoryPath(internalRootFromArtifactObjectRoot(artifactObjectRoot), 'legacy-workspace'))
      .toBe(workspaceGitRepositoryPath(internalRoot, 'legacy-workspace'));
  });

  it('keeps the workspace store one level below the internal root', () => {
    expect(dirname(workspaceStore)).toBe(internalRoot);
    // The segment is bounded deterministically, not truncated arbitrarily.
    expect(workspaceGitRepositoryPath(internalRoot, 'legacy-workspace'))
      .toMatch(/^\/data\/workspace-git\/w_legacy-works_[a-f0-9]{8}\/repository\.git$/u);
  });
});
