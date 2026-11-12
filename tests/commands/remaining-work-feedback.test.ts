import { describe, expect, it } from 'vitest';
import { retryRemainingWork } from '../../src/commands/task-commands.js';
import type { CommandContext, ResolvedCommandArgs } from '../../src/commands/catalog.js';

describe('remaining-work command feedback', () => {
  it.each(['failed', 'cancelled', 'succeeded', 'running'] as const)('reports the actual %s successor and associates its Task', async status => {
    const result = await retryRemainingWork({ positionals: { taskId: 'source' }, options: {} } as ResolvedCommandArgs, {
      taskControl: { retryRemainingWork: async () => ({ taskId: 'successor' }) },
      taskEngine: { getTaskRepo: () => ({ findById: () => ({ id: 'successor', status,
        stateDetail: { reason: { message: '服务目录尚未准备完成' } } }) }) },
    } as unknown as CommandContext);
    expect(result).toMatchObject({ type: 'text', relatedTaskId: 'successor' });
    expect(result.content).not.toContain('已创建');
    expect(result.content).toContain({ failed: '已失败', cancelled: '已取消', succeeded: '已完成', running: '实时状态' }[status]);
    if (status === 'failed') expect(result.content).toContain('重复提交相同重试命令不会重新执行');
  });
});
