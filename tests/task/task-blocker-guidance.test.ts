import { describe, expect, it } from 'vitest';
import {
  formatBlockedTaskNextStep,
  formatBlockedTaskReason,
  isUnknownTaskBlocker,
  formatEmptyTaskRecovery,
} from '../../src/task/task-blocker-guidance.js';

describe('task blocker guidance', () => {
  it('uses the current needs_action status and only suggests resume with a remaining target', () => {
    expect(formatEmptyTaskRecovery('t', { status: 'needs_action', canResume: true, blockerReason: '缺少资料' })).toContain('/task resume t');
    expect(formatEmptyTaskRecovery('t', { status: 'needs_action', canResume: false })).not.toContain('/task resume');
    expect(formatEmptyTaskRecovery('t', { status: 'succeeded' })).toBeNull();
  });

  it('does not turn an empty recovery queue into permission to repeat uncertain external effects', () => {
    const message = formatEmptyTaskRecovery('t', { status: 'needs_action', canResume: true,
      blockerReason: 'automatic recovery cannot prove external effect safety' });
    expect(message).not.toContain('/task resume');
    expect(message).toContain('核对实际');
    expect(message).toContain('/task cancel t');
  });
  it('treats an interrupted upstream stream blocked by the safety fence as an explicit recovery case', () => {
    const reason = 'automatic recovery cannot prove external effect safety（上游模型响应流中断：Upstream response stream was interrupted）';

    expect(isUnknownTaskBlocker(reason)).toBe(true);
    expect(formatBlockedTaskReason(reason)).toContain('Executor 已启动');
    expect(formatBlockedTaskNextStep('task_1', reason)).toContain('/task recovery task_1');
  });
});
