import { EventEmitter } from 'events';
import { dirname } from 'path';
import { existsSync, writeFileSync } from 'fs';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  kill() {
    this.emit('close', null);
    return true;
  }
}

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn().mockReturnValue({ status: 0 });

function createExecutorInput() {
  return {
    context: {
      taskBackground: { id: 'task_1', title: '测试任务', goal: '测试目标', instruction: 'background_only' as const },
      currentSubtask: {
        id: 'subtask_1', title: '继续', goal: '继续', expectedOutput: 'summary' as const,
        acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }],
      },
      incomingHandoffs: [], outgoingHandoffRequirements: [], selectedEvidence: [], outOfScopeSiblings: [],
      workspaceContext: { allowFilesystem: true, workingDirectory: process.cwd(), targetPaths: [] },
      identity: { executionId: 'exec_1', taskId: 'task_1', subtaskId: 'subtask_1', attemptId: 'attempt_1', workUnitId: 'wu_1' },
      completionContract: { marker: '<!-- metaclaw:completion:v1 -->' as const, schemaVersion: 1 as const },
      evidenceTools: { availability: 'unavailable' as const, reason: 'test' },
    },
  };
}

function getCodexFinalMessagePath(): string {
  const args = spawnMock.mock.calls.at(-1)?.[1] as string[];
  const outputFlagIndex = args.indexOf('--output-last-message');
  return args[outputFlagIndex + 1];
}

vi.mock('child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

describe('executor interruption semantics', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns only the Codex final message and cleans its capture directory', async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const { CodexCliAdapter } = await import('../../src/executor/codex-cli.js');
    const adapter = new CodexCliAdapter({ command: 'codex', timeout: 300 });

    const resultPromise = adapter.execute(createExecutorInput());
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    const outputFlagIndex = args.indexOf('--output-last-message');
    const outputPath = outputFlagIndex >= 0 ? args[outputFlagIndex + 1] : undefined;
    if (outputPath) {
      writeFileSync(outputPath, 'final answer\n\nsecond paragraph\n', 'utf8');
    }
    child.stdout.emit('data', Buffer.from('工具调用过程\ntokens used\n18,607\n'));
    child.emit('close', 0);

    const result = await resultPromise;
    expect(args).toContain('--output-last-message');
    expect(args).not.toContain('--ephemeral');
    expect(result).toMatchObject({ success: true, output: 'final answer\n\nsecond paragraph\n' });
    expect(outputPath).toBeDefined();
    expect(existsSync(dirname(outputPath!))).toBe(false);
  });

  it.each([
    ['missing', false],
    ['empty', true],
  ])('fails closed when the Codex final message is %s', async (_case, writeEmptyFile) => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const { CodexCliAdapter } = await import('../../src/executor/codex-cli.js');
    const adapter = new CodexCliAdapter({ command: 'codex', timeout: 300 });

    const resultPromise = adapter.execute(createExecutorInput());
    const outputPath = getCodexFinalMessagePath();
    if (writeEmptyFile) {
      writeFileSync(outputPath, '', 'utf8');
    }
    child.stdout.emit('data', Buffer.from('internal process output\n'));
    child.emit('close', 0);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.output).toBe('');
    expect(result.error).toBe('Codex executor completed without a final response');
    expect(existsSync(dirname(outputPath))).toBe(false);
  });

  it('cleans the Codex capture directory after a non-zero exit', async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const { CodexCliAdapter } = await import('../../src/executor/codex-cli.js');
    const adapter = new CodexCliAdapter({ command: 'codex', timeout: 300 });

    const resultPromise = adapter.execute(createExecutorInput());
    const outputPath = getCodexFinalMessagePath();
    child.stderr.emit('data', Buffer.from('executor failed'));
    child.emit('close', 1);

    expect((await resultPromise).success).toBe(false);
    expect(existsSync(dirname(outputPath))).toBe(false);
  });

  it('cleans the Codex capture directory after a spawn error', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    const { CodexCliAdapter } = await import('../../src/executor/codex-cli.js');
    const adapter = new CodexCliAdapter({ command: 'codex', timeout: 300 });

    const resultPromise = adapter.execute(createExecutorInput());
    const outputPath = getCodexFinalMessagePath();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(existsSync(dirname(outputPath))).toBe(false);
  });

  it('marks codex execution as interrupted after abort', async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const { CodexCliAdapter } = await import('../../src/executor/codex-cli.js');
    const adapter = new CodexCliAdapter({ command: 'codex', timeout: 300 });

    const resultPromise = adapter.execute(createExecutorInput());

    const outputPath = getCodexFinalMessagePath();
    adapter.abort();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.interrupted).toBe(true);
    expect(result.error).toContain('interrupted');
    expect(existsSync(dirname(outputPath))).toBe(false);
  });

  it('marks claude execution as interrupted after abort', async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const { ClaudeCodeAdapter } = await import('../../src/executor/claude-code.js');
    const adapter = new ClaudeCodeAdapter({ command: 'claude', timeout: 300 });

    const resultPromise = adapter.execute(createExecutorInput());

    adapter.abort();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.interrupted).toBe(true);
    expect(result.error).toContain('interrupted');
  });

  it('does not time out while codex keeps producing activity', async () => {
    vi.useFakeTimers();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const { CodexCliAdapter } = await import('../../src/executor/codex-cli.js');
    const adapter = new CodexCliAdapter({ command: 'codex', timeout: 1, maxDuration: 10 });

    const resultPromise = adapter.execute(createExecutorInput());

    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(900);
      child.stdout.emit('data', Buffer.from(`working ${i}\n`));
    }
    writeFileSync(getCodexFinalMessagePath(), 'completed', 'utf8');
    child.emit('close', 0);

    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('completed');
  });

  it('marks codex execution as failed after prolonged inactivity', async () => {
    vi.useFakeTimers();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const { CodexCliAdapter } = await import('../../src/executor/codex-cli.js');
    const adapter = new CodexCliAdapter({ command: 'codex', timeout: 1, maxDuration: 10 });

    const resultPromise = adapter.execute(createExecutorInput());

    const outputPath = getCodexFinalMessagePath();
    await vi.advanceTimersByTimeAsync(1001);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.interrupted).toBeFalsy();
    expect(result.error).toContain('idle timeout');
    expect(existsSync(dirname(outputPath))).toBe(false);
  });
});
