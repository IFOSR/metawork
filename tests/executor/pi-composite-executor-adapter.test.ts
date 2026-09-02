import { describe, expect, it, vi } from 'vitest';
import type { ExecutorAdapter, ExecutorInput } from '../../src/executor/adapter.js';
import {
  PiCompositeExecutorAdapter,
} from '../../src/executor/pi-composite-executor-adapter.js';

describe('PiCompositeExecutorAdapter', () => {
  it('routes image generation to the image engine and ordinary work to Pi', async () => {
    const pi = adapter('pi');
    const image = adapter('image');
    const composite = new PiCompositeExecutorAdapter({ piAdapter: pi, imageAdapter: image });

    await composite.execute(input([]));
    await composite.execute(input(['image-generation']));

    expect(pi.execute).toHaveBeenCalledTimes(1);
    expect(image.execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed when generation and editing are both requested', async () => {
    const pi = adapter('pi');
    const image = adapter('image');
    const composite = new PiCompositeExecutorAdapter({ piAdapter: pi, imageAdapter: image });

    const result = await composite.execute(input(['image-generation', 'image-editing']));

    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/both image generation and image editing/i),
      failure: { kind: 'configuration' },
    });
    expect(pi.execute).not.toHaveBeenCalled();
    expect(image.execute).not.toHaveBeenCalled();
  });

  it('probes both internal engines and aborts both', async () => {
    const pi = adapter('pi');
    const image = adapter('image');
    const composite = new PiCompositeExecutorAdapter({ piAdapter: pi, imageAdapter: image });

    await composite.probe();
    composite.abort('attempt-1');

    expect(pi.probe).toHaveBeenCalled();
    expect(image.probe).toHaveBeenCalled();
    expect(pi.abort).toHaveBeenCalledWith('attempt-1');
    expect(image.abort).toHaveBeenCalledWith('attempt-1');
  });
});

function adapter(name: string): ExecutorAdapter {
  return {
    name,
    execute: vi.fn(async () => ({
      success: true,
      output: name,
      exitCode: 0,
      durationMs: 1,
    })),
    probe: vi.fn(async () => ({ available: true, failure: null })),
    abort: vi.fn(),
  };
}

function input(requiredCapabilities: string[]): ExecutorInput {
  return {
    context: {
      currentSubtask: {
        id: 'subtask-1',
        title: 'image task',
        goal: 'do the task',
        deliveryKind: 'edit',
        requiredCapabilities,
        acceptance: [],
      },
    } as never,
  };
}
