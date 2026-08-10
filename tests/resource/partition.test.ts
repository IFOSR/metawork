import {
  normalizeMountedRelativePath,
  normalizePartitionIdentity,
  partitionCanonicalKey,
  partitionCovers,
  resourceClaimsConflict,
} from '../../src/resource/index.js';

describe('resource partition model', () => {
  test('normalizes Windows and POSIX spellings through a mount registration', () => {
    const mount = { mountId: 'SOURCE', caseSensitive: false };
    expect(normalizeMountedRelativePath(mount, 'Src\\Feature//Index.ts')).toEqual({
      kind: 'path',
      mountId: 'source',
      normalizedRelativePath: 'src/feature/index.ts',
    });
    expect(partitionCanonicalKey(normalizeMountedRelativePath(mount, 'src/feature/index.ts')))
      .toBe('path:source:src/feature/index.ts');
  });

  test.each(['../secret', '/host/path', 'C:\\host\\path', '\\\\server\\share', 'safe/../../secret'])(
    'rejects path escape %s',
    input => expect(() => normalizeMountedRelativePath({ mountId: 'source', caseSensitive: true }, input)).toThrow(),
  );

  test('models repository/worktree membership and path parent coverage', () => {
    expect(partitionCovers(
      { kind: 'repository', repositoryId: 'repo-1' },
      { kind: 'worktree', repositoryId: 'repo-1', workspaceId: 'ws-1' },
    )).toBe(true);
    expect(partitionCovers(
      { kind: 'path', mountId: 'workspace', normalizedRelativePath: 'src' },
      { kind: 'path', mountId: 'workspace', normalizedRelativePath: 'src/a.ts' },
    )).toBe(true);
  });

  test('supports whole-segment logical and external wildcards', () => {
    expect(partitionCovers(
      { kind: 'logical', namespace: 'queue', key: 'task/*' },
      { kind: 'logical', namespace: 'queue', key: 'task/42' },
    )).toBe(true);
    expect(partitionCovers(
      { kind: 'external_object', provider: 'github', account: 'org', collection: '*', objectId: 'issue/*' },
      { kind: 'external_object', provider: 'github', account: 'org', collection: 'repo', objectId: 'issue/42' },
    )).toBe(true);
    expect(() => normalizePartitionIdentity({ kind: 'logical', namespace: 'q', key: 'task/prefix*' })).toThrow();
  });

  test('allows overlapping readers but conflicts whenever either claim writes', () => {
    const parent = { kind: 'path' as const, mountId: 'workspace', normalizedRelativePath: 'src' };
    const child = { kind: 'path' as const, mountId: 'workspace', normalizedRelativePath: 'src/a.ts' };
    expect(resourceClaimsConflict({ partition: parent, access: 'read' }, { partition: child, access: 'read' })).toBe(false);
    expect(resourceClaimsConflict({ partition: parent, access: 'write' }, { partition: child, access: 'read' })).toBe(true);
  });
});
