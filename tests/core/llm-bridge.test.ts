import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { LlmBridge } from '../../src/core/llm-bridge.js';

describe('LlmBridge', () => {
  it('keeps generic interaction ranking available without task-intent APIs', async () => {
    const bridge = new LlmBridge('claude');
    vi.spyOn(bridge, 'query').mockResolvedValue('["int_1", 7, "int_2", null]');

    await expect(bridge.rankInteractions('prior research', [
      { id: 'int_1', userInput: 'research agent runtimes' },
      { id: 'int_2', userInput: 'prepare weekly report' },
    ])).resolves.toEqual(['int_1', 'int_2']);
    expect('resolveTaskResumeIntent' in bridge).toBe(false);
    expect('resolveTaskPriority' in bridge).toBe(false);
  });

  it('does not invoke the LLM when ranking has no candidates', async () => {
    const bridge = new LlmBridge('claude');
    const querySpy = vi.spyOn(bridge, 'query');

    await expect(bridge.rankInteractions('hello', [])).resolves.toEqual([]);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('filters preference recall results to known candidate IDs', async () => {
    const bridge = new LlmBridge('claude');
    vi.spyOn(bridge, 'query').mockResolvedValue(JSON.stringify([
      { preferenceId: 'pref_known', action: 'auto_apply', reason: 'relevant', score: 0.9 },
      { preferenceId: 'pref_unknown', action: 'auto_apply', reason: 'not allowed', score: 1 },
    ]));

    await expect(bridge.recallPreferences('use my format', [{
      id: 'pref_known',
      scope: 'global',
      subject: null,
      type: 'format',
      content: 'concise output',
    }])).resolves.toEqual([{
      preferenceId: 'pref_known',
      action: 'auto_apply',
      reason: 'relevant',
      score: 0.9,
    }]);
  });

  it('uses Codex non-interactive arguments for generic bridge calls', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    const spawn = vi.fn(() => proc as never);
    const bridge = new LlmBridge('codex', { spawn: spawn as never, cwd: () => '/tmp/project' });

    const result = bridge.query('rank this');
    proc.stdout.emit('data', Buffer.from('[]'));
    proc.emit('close', 0);

    await expect(result).resolves.toBe('[]');
    expect(spawn).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['exec', '--skip-git-repo-check', '--ephemeral', 'rank this']),
      expect.objectContaining({ cwd: '/tmp/project' }),
    );
  });

  it('reports bounded stderr when the subprocess exits unsuccessfully', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    const bridge = new LlmBridge('claude', {
      spawn: vi.fn(() => proc as never) as never,
      cwd: () => '/tmp/project',
    });

    const result = bridge.query('prompt');
    proc.stderr.emit('data', Buffer.from('failure details'));
    proc.emit('close', 2);

    await expect(result).rejects.toThrow('failure details');
  });
});
