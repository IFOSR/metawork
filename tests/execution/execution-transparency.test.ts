import { describe, expect, it } from 'vitest';
import {
  buildExecutorDisplayFacts,
  displayNameFromRef,
  executionEventDetails,
} from '../../src/execution/execution-transparency.js';

describe('execution transparency projection', () => {
  it('derives stable user-readable display names from internal refs', () => {
    expect(displayNameFromRef('codex-engineering')).toBe('Codex Engineering');
    expect(displayNameFromRef('kimi')).toBe('Kimi');
    expect(displayNameFromRef('provider:deepseek-chat')).toBe('Deepseek Chat');
    expect(displayNameFromRef('')).toBe('');
  });

  it('builds executor display facts from an authorized binding', () => {
    const facts = buildExecutorDisplayFacts({
      binding: {
        agentClassRef: 'pi-research',
        harnessRef: 'anyfusion-pi',
        providerRef: 'moonshot',
        modelRef: 'kimi-k2',
      },
      subtaskId: 'subtask_1',
      subtaskTitle: '调研章节',
    });

    expect(facts).toEqual({
      subtaskId: 'subtask_1',
      subtaskTitle: '调研章节',
      executorDisplayName: 'Pi Research',
      harnessDisplayName: 'Anyfusion Pi',
      providerDisplayName: 'Moonshot',
      modelDisplayName: 'Kimi K2',
    });
  });

  it('normalizes milestone details without fabricating progress', () => {
    const display = buildExecutorDisplayFacts({
      binding: {
        agentClassRef: 'codex-cli',
        harnessRef: 'codex-cli',
        providerRef: 'openai',
        modelRef: 'gpt-5',
      },
      subtaskId: 'subtask_9',
      subtaskTitle: '实现模块',
    });
    const details = executionEventDetails({
      display,
      step: { stepKey: 'executor_started', stepLabel: '已启动 Codex Cli' },
      startedAt: '2026-08-24T01:00:00.000Z',
      updatedAt: '2026-08-24T01:00:05.000Z',
    });

    expect(details).toMatchObject({
      subtaskId: 'subtask_9',
      subtaskTitle: '实现模块',
      executorDisplayName: 'Codex Cli',
      harnessDisplayName: 'Codex Cli',
      providerDisplayName: 'Openai',
      modelDisplayName: 'Gpt 5',
      stepKey: 'executor_started',
      stepLabel: '已启动 Codex Cli',
      progress: null,
      startedAt: '2026-08-24T01:00:00.000Z',
      updatedAt: '2026-08-24T01:00:05.000Z',
    });
    // 不携带内部执行标识：binding fingerprint、revision、命令与日志不进入投影。
    expect(JSON.stringify(details)).not.toContain('configurationRevision');
    expect(JSON.stringify(details)).not.toContain('fingerprint');
  });
});
