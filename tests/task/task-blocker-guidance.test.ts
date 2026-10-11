import { describe, expect, it } from 'vitest';
import {
  formatBlockedTaskNextStep,
  formatBlockedTaskReason,
  isUnknownTaskBlocker,
} from '../../src/task/task-blocker-guidance.js';

describe('task blocker guidance', () => {
  it('treats an interrupted upstream stream blocked by the safety fence as an explicit recovery case', () => {
    const reason = 'automatic recovery cannot prove external effect safety（上游模型响应流中断：Upstream response stream was interrupted）';

    expect(isUnknownTaskBlocker(reason)).toBe(true);
    expect(formatBlockedTaskReason(reason)).toContain('Executor 已启动');
    expect(formatBlockedTaskNextStep('task_1', reason)).toContain('/task recovery task_1');
  });
});
