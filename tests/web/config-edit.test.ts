import { describe, expect, it } from 'vitest';
import {
  MODEL_CAPABILITIES,
  selectModelPolicy,
} from '../../web/src/config-edit.js';

describe('Web configuration editing', () => {
  it('offers exactly the model capabilities accepted by schema v2', () => {
    expect(MODEL_CAPABILITIES).toEqual([
      'coding',
      'long-context',
      'planning',
      'structured-output',
      'tools',
      'vision',
    ]);
  });

  it('converts a fixed policy to a complete automatic policy', () => {
    expect(selectModelPolicy(
      'auto',
      ['model-a', 'model-b'],
      { mode: 'fixed', modelRef: 'model-b' },
    )).toEqual({
      mode: 'auto',
      allowedModelRefs: ['model-b'],
      defaultModelRef: 'model-b',
    });
  });

  it('converts an automatic policy to a strict fixed policy', () => {
    expect(selectModelPolicy(
      'model-b',
      ['model-a', 'model-b'],
      {
        mode: 'auto',
        allowedModelRefs: ['model-a', 'model-b'],
        defaultModelRef: 'model-a',
        fallback: { enabled: true, order: ['model-b'] },
      },
    )).toEqual({
      mode: 'fixed',
      modelRef: 'model-b',
    });
  });

  it('preserves an existing automatic policy when auto remains selected', () => {
    const current = {
      mode: 'auto' as const,
      allowedModelRefs: ['model-a'],
      defaultModelRef: 'model-a',
      fallback: { enabled: false, order: [] },
    };

    expect(selectModelPolicy('auto', ['model-a', 'model-b'], current)).toBe(current);
  });
});
