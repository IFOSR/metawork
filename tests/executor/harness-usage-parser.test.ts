import { describe, expect, it, vi } from 'vitest';
import { CodexCliDriver } from '../../src/executor/codex-cli-driver.js';
import { PiCliDriver } from '../../src/executor/pi-cli-driver.js';

describe('harness usage parsers', () => {
  it('extracts Codex turn usage without treating total tokens as another charge', () => {
    const driver = new CodexCliDriver({ probeCommand: vi.fn() });
    const result = driver.parseUsageLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'turn.completed',
        turn_id: 'turn_7',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 40,
          reasoning_output_tokens: 10,
          total_tokens: 160,
        },
      }),
    });

    expect(result).toEqual({
      sourceEventKey: 'turn.completed:turn_7',
      callId: 'turn_7',
      counters: [
        { resource: 'model_tokens', metric: 'input', unit: 'token', kind: 'delta', value: '100' },
        { resource: 'model_tokens', metric: 'cache_read', unit: 'token', kind: 'delta', value: '20', subsetOf: 'input' },
        { resource: 'model_tokens', metric: 'output', unit: 'token', kind: 'delta', value: '40' },
        { resource: 'model_tokens', metric: 'reasoning', unit: 'token', kind: 'delta', value: '10', subsetOf: 'output' },
      ],
    });
  });

  it('extracts Pi assistant usage only from a completed message', () => {
    const driver = new PiCliDriver({ probeCommand: vi.fn() });
    expect(driver.parseUsageLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'message_update',
        message: { role: 'assistant', usage: { input: 1, output: 2 } },
      }),
    })).toBeNull();

    const line = JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        usage: { input: 12, output: 5, cacheRead: 3, cacheWrite: 1 },
      },
    });
    expect(driver.parseUsageLine?.({
      stream: 'stdout',
      line,
    })).toEqual({
      sourceEventKey: expect.stringMatching(/^message_end:[0-9a-f]{24}$/u),
      callId: expect.stringMatching(/^message_end:[0-9a-f]{24}$/u),
      counters: [
        { resource: 'model_tokens', metric: 'input', unit: 'token', kind: 'delta', value: '12' },
        { resource: 'model_tokens', metric: 'output', unit: 'token', kind: 'delta', value: '5' },
        { resource: 'model_tokens', metric: 'cache_read', unit: 'token', kind: 'delta', value: '3', subsetOf: 'input' },
        { resource: 'model_tokens', metric: 'cache_write', unit: 'token', kind: 'delta', value: '1', subsetOf: 'input' },
      ],
    });
  });

  it('reports missing usage when a completed assistant record has no usage', () => {
    const driver = new PiCliDriver({ probeCommand: vi.fn() });
    const line = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    });
    expect(driver.parseUsageLine?.({
      stream: 'stdout',
      line,
    })).toEqual({
      sourceEventKey: expect.stringMatching(/^message_end:[0-9a-f]{24}$/u),
      callId: expect.stringMatching(/^message_end:[0-9a-f]{24}$/u),
      counters: [],
      missing: [
        { resource: 'model_tokens', metric: 'input', unit: 'token' },
        { resource: 'model_tokens', metric: 'output', unit: 'token' },
      ],
    });
  });

  it('keeps distinct Pi assistant messages distinct when the provider omits ids', () => {
    const driver = new PiCliDriver({ probeCommand: vi.fn() });
    const first = driver.parseUsageLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', usage: { input: 1, output: 2 }, content: 'first' },
      }),
    });
    const second = driver.parseUsageLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', usage: { input: 3, output: 4 }, content: 'second' },
      }),
    });
    expect(first?.sourceEventKey).not.toBe(second?.sourceEventKey);
    expect(first?.callId).not.toBe(second?.callId);
  });
});
