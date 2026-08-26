import { describe, expect, it } from 'vitest';
import { requiresCompositionLock } from '../../src/installation/composition-runtime.js';

describe('requiresCompositionLock', () => {
  it('locks only standalone Server startup', () => {
    expect(requiresCompositionLock({ kind: 'server', action: 'start' })).toBe(true);
  });

  it('does not let Clients or management commands acquire the Server lock', () => {
    expect(requiresCompositionLock({ kind: 'tui' })).toBe(false);
    expect(requiresCompositionLock({ kind: 'web' })).toBe(false);
    expect(requiresCompositionLock({ kind: 'server', action: 'stop' })).toBe(false);
    expect(requiresCompositionLock({ kind: 'server', action: 'restart' })).toBe(false);
    expect(requiresCompositionLock({ kind: 'server', action: 'status' })).toBe(false);
    expect(requiresCompositionLock({ kind: 'server', action: 'doctor' })).toBe(false);
    expect(requiresCompositionLock({ kind: 'help' })).toBe(false);
    expect(requiresCompositionLock({
      kind: 'admin',
      command: { kind: 'config', subcommand: 'show' },
    })).toBe(false);
  });
});
