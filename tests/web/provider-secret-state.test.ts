import { describe, expect, it } from 'vitest';
import {
  deriveSecretStates,
  resolveProviderSecretReference,
} from '../../web/src/components/provider-secret-state.js';

describe('provider secret state projection', () => {
  it('treats a configured shared Provider as configured for Planner and Executor', () => {
    expect(deriveSecretStates(
      ['planner', 'codex-cli'],
      {
        planner: 'kimi',
        'codex-cli': 'kimi',
      },
      { kimi: true },
    )).toEqual({
      planner: 'configured',
      'codex-cli': 'configured',
    });
  });

  it('does not turn a configured local credential into invalid because probing failed', () => {
    expect(deriveSecretStates(
      ['planner'],
      { planner: 'kimi' },
      { kimi: true },
    )).toEqual({ planner: 'configured' });
  });

  it('requires a key only when the shared Provider has no stored credential', () => {
    expect(deriveSecretStates(
      ['planner', 'pi-agent'],
      {
        planner: 'kimi',
        'pi-agent': 'kimi',
      },
      { kimi: false },
    )).toEqual({
      planner: 'missing',
      'pi-agent': 'missing',
    });
  });

  it('preserves the active reference scheme when a newly selected Provider is activated', () => {
    expect(resolveProviderSecretReference(
      'code-cli',
      'https://www.code-cli.cn/v1',
      {},
      {},
      ['keychain:anyfusion/providers/kimi'],
    )).toBe('keychain:anyfusion/providers/code-cli');
  });

  it('reuses an existing reference when the Provider was previously keyed under another ref', () => {
    expect(resolveProviderSecretReference(
      'kimi',
      'https://api.kimi.com/coding/v1',
      {
        'legacy-openai': {
          baseUrl: 'https://api.kimi.com/coding/v1',
          apiKeyRef: 'file-secret:anyfusion/providers/legacy-openai',
        },
      },
      {},
      ['file-secret:anyfusion/providers/legacy-openai'],
    )).toBe('file-secret:anyfusion/providers/legacy-openai');
  });
});
