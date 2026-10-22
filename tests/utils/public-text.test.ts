import { describe, expect, it } from 'vitest';
import { containsInternalRuntimePath, publicText } from '../../src/utils/public-text.js';

describe('ordinary client text boundary', () => {
  it.each([
    '/Users/example/.metawork/accounts/local-default/workspace-store/workspaces/task/attempts/a',
    '/private/runtime/workspace-store/workspaces/task/file.ts',
    '/private/var/folders/x/metawork-delivery-123/result',
    'C:\\Users\\example\\.metawork\\accounts\\local-default\\logs\\attempt',
  ])('removes an internal path from a result or error: %s', path => {
    expect(containsInternalRuntimePath(path)).toBe(true);
    expect(publicText(`failed at ${path} please retry`)).toBe('failed at [内部路径] please retry');
  });
  it('preserves the public Workspace and task paths, relative files, and service URL', () => {
    const text = 'Workspace: /Users/example/projects/my-app\n任务目录: /Users/example/projects/my-app/metaclaw-tasks/api-123\n文件: src/server.ts\nhttp://127.0.0.1:8080/health';
    expect(containsInternalRuntimePath(text)).toBe(false);
    expect(publicText(text)).toBe(text);
  });
});
