import { describe, expect, it } from 'vitest';
import {
  deriveSecretStates,
  fingerprintProviderCredential,
  maskApiKey,
  normalizeProviderBaseUrl,
  resolveProviderSecretReference,
  providerIdentityKey,
  currentProviderIdentityKey,
} from '../../web/src/components/provider-secret-state.js';

describe('provider secret state projection', () => {
  it('treats a configured shared Provider as configured for Planner and Executor', () => {
    expect(deriveSecretStates(
      ['planner', 'codex-cli'],
      {
        planner: 'kimi',
        'codex-cli': 'kimi',
      },
      { kimi: { configured: true, maskedApiKey: '••••••••kimi' } },
    )).toEqual({
      planner: 'configured',
      'codex-cli': 'configured',
    });
  });

  it('does not turn a configured local credential into invalid because probing failed', () => {
    expect(deriveSecretStates(
      ['planner'],
      { planner: 'kimi' },
      { kimi: { configured: true, maskedApiKey: '••••••••kimi' } },
    )).toEqual({ planner: 'configured' });
  });

  it('requires a key only when the shared Provider has no stored credential', () => {
    expect(deriveSecretStates(
      ['planner', 'pi-agent'],
      {
        planner: 'kimi',
        'pi-agent': 'kimi',
      },
      { kimi: { configured: false, maskedApiKey: null } },
    )).toEqual({
      planner: 'missing',
      'pi-agent': 'missing',
    });
  });

  it('masks an API Key while retaining only its last four characters', () => {
    expect(maskApiKey('sk-secret')).toBe('••••••••cret');
    expect(maskApiKey('abc')).toBe('••••••••abc');
  });

  it('builds a stable Provider identity from normalized URL and a one-way key fingerprint', async () => {
    expect(normalizeProviderBaseUrl('HTTPS://api.deepseek.com/v1///'))
      .toBe('https://api.deepseek.com/v1');
    await expect(fingerprintProviderCredential('secret')).resolves.toMatch(/^sha256:[0-9a-f]{64}$/u);
    await expect(fingerprintProviderCredential(' secret '))
      .resolves.toBe(await fingerprintProviderCredential('secret'));
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

  it('deduplicates only the same URL and complete key, including pending key replacements', async () => {
    const baseUrl = 'https://code-cli.cn/v1';
    const saved = { baseUrl, apiKey: '', credentialFingerprint: await fingerprintProviderCredential('first-key') };
    expect(await currentProviderIdentityKey({ baseUrl: baseUrl + '/', apiKey: 'first-key' }))
      .toBe(providerIdentityKey(saved));
    expect(await currentProviderIdentityKey({ ...saved, apiKey: 'replacement-key' }))
      .not.toBe(providerIdentityKey(saved));
    expect(await currentProviderIdentityKey({ ...saved, apiKey: 'replacement-key' }))
      .toBe(await currentProviderIdentityKey({ baseUrl, apiKey: 'replacement-key' }));
    expect(await currentProviderIdentityKey({ baseUrl: 'https://www.code-cli.cn/v1', apiKey: 'first-key' }))
      .not.toBe(providerIdentityKey(saved));
    expect(providerIdentityKey({ baseUrl, apiKey: '' })).toBeUndefined();
    expect(normalizeProviderBaseUrl('https://EXAMPLE.com/CaseSensitive'))
      .toBe('https://example.com/CaseSensitive');
  });

  it('keeps a distinct reference when another Provider shares the same URL', () => {
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
    )).toBe('file-secret:anyfusion/providers/kimi');
  });

  it('repairs a legacy shared secret reference between Providers', () => {
    expect(resolveProviderSecretReference(
      'code-cli',
      'https://code-cli.cn/v1',
      {
        kimi: {
          baseUrl: 'https://code-cli.cn/v1',
          apiKeyRef: 'file-secret:anyfusion/providers/kimi',
        },
        'code-cli': {
          baseUrl: 'https://code-cli.cn/v1',
          apiKeyRef: 'file-secret:anyfusion/providers/kimi',
        },
      },
      {},
      ['file-secret:anyfusion/providers/kimi'],
    )).toBe('file-secret:anyfusion/providers/code-cli');
  });
});
