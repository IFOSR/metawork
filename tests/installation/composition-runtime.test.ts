import { describe, expect, it } from 'vitest';
import { requiresCompositionLock } from '../../src/installation/composition-runtime.js';

describe('requiresCompositionLock', () => {
  it('locks every mode that enters Session and Planner Host composition', () => {
    expect(requiresCompositionLock({})).toBe(true);
    expect(requiresCompositionLock({ web: true })).toBe(true);
    expect(requiresCompositionLock({ gateway: true })).toBe(true);
    expect(requiresCompositionLock({ gateway: true, gatewayCommand: 'run' })).toBe(true);
    expect(requiresCompositionLock({ scriptPath: '/tmp/flow.txt' })).toBe(true);
  });

  it('does not lock commands that return before composition', () => {
    expect(requiresCompositionLock({ connect: true })).toBe(false);
    for (const gatewayCommand of [
      'setup', 'install', 'start', 'stop', 'restart', 'status', 'pairing', 'doctor',
    ] as const) {
      expect(requiresCompositionLock({ gatewayCommand })).toBe(false);
    }
  });
});
