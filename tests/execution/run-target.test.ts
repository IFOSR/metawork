import { describe, expect, it } from 'vitest';
import { normalizeServiceId } from '../../src/execution/local-service-discovery.js';
import {
  isWithinTarget,
  resolveRunTargetCandidates,
} from '../../src/execution/run-target.js';

describe('run target resolution', () => {
  it('targets the project directory a Task delivered', () => {
    expect(resolveRunTargetCandidates({
      artifactPaths: ['deliverables/ai-radar-site/server.js'],
    })).toEqual([{ targetPath: 'deliverables/ai-radar-site', evidence: 'artifact' }]);
  });

  it('does not let an old Workspace-root manifest become the target of a new project', () => {
    // The Workspace still holds the fireworks service from an earlier Task.
    // The new Task delivered a different project, so the root file is not a
    // candidate for this follow-up.
    const candidates = resolveRunTargetCandidates({
      artifactPaths: ['deliverables/ai-radar-site/server.js'],
      manifestPaths: ['.metawork-service.json'],
    });
    expect(candidates.map(candidate => candidate.targetPath))
      .toEqual(['deliverables/ai-radar-site']);
  });

  it('uses the root manifest only when the Task delivered no project of its own', () => {
    expect(resolveRunTargetCandidates({
      artifactPaths: ['README.md'],
      manifestPaths: ['.metawork-service.json'],
    })).toEqual([{ targetPath: '', evidence: 'manifest' }]);
  });

  it('prefers a project-local manifest over the entry-file evidence', () => {
    expect(resolveRunTargetCandidates({
      artifactPaths: ['apps/site/server.js'],
      manifestPaths: ['apps/site/.metawork-service.json'],
    })).toEqual([{ targetPath: 'apps/site', evidence: 'manifest' }]);
  });

  it('reports every distinct project when the target is genuinely ambiguous', () => {
    const candidates = resolveRunTargetCandidates({
      artifactPaths: ['apps/a/server.js', 'apps/b/main.py', 'apps/a/package.json'],
    });
    expect(candidates.map(candidate => candidate.targetPath)).toEqual(['apps/a', 'apps/b']);
  });

  it('ignores absolute, traversing and non-entry artifact paths', () => {
    expect(resolveRunTargetCandidates({
      artifactPaths: ['/etc/server.js', '../server.js', 'reports/answer.md'],
    })).toEqual([]);
  });

  it('keeps the target containment check explicit', () => {
    expect(isWithinTarget('deliverables/site', 'deliverables/site')).toBe(true);
    expect(isWithinTarget('deliverables/site/server.js', 'deliverables/site')).toBe(true);
    expect(isWithinTarget('deliverables/other', 'deliverables/site')).toBe(false);
    expect(isWithinTarget('anything', '')).toBe(true);
  });
});

describe('discovered service identity', () => {
  it('derives a stable identifier instead of reusing the old project name', () => {
    expect(normalizeServiceId('deliverables/ai-radar-site')).toBe('ai-radar-site');
    expect(normalizeServiceId('我的 网站')).toBe('local-service');
    expect(normalizeServiceId('My_Site.v2')).toBe('my_site-v2');
  });
});
