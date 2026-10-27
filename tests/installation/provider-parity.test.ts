import { describe, expect, it } from 'vitest';
import { ConfigurationCompletionService } from '../../src/configuration/configuration-completion-service.js';
import { validateConfigurationCandidate } from '../../src/configuration/index.js';

/**
 * The installer and the settings page must create the same resource.
 *
 * The installer writes `provider.provider` with a file-secret reference; the
 * settings page writes `custom-model-N` with a reference derived from its own
 * ref. Both are ordinary Providers: same schema, same completion treatment, and
 * both can be deleted. Nothing may make the install-time Provider special.
 */

const base = {
  schemaVersion: 2,
  harnesses: {
    'anyfusion-planner': {
      kind: 'planner',
      transport: 'local-process',
      commandRef: 'release:planner',
      args: [],
      driverId: 'anyfusion-planner-host-v2',
      supportsProbe: true,
      supportsAbort: true,
      supportsContinuation: true,
      enabled: true,
    },
    'pi-cli': {
      kind: 'executor',
      transport: 'local-cli',
      command: 'pi',
      args: [],
      driverId: 'pi-cli',
      supportsProbe: true,
      supportsAbort: true,
      supportsContinuation: true,
      enabled: true,
    },
  },
  permissionProfiles: {},
  runtimePolicy: { maxConcurrentAttempts: 2, maxConcurrentAttemptsPerTask: 1 },
  gateway: {},
  agentClasses: {
    planner: {
      kind: 'planner',
      harnessRef: 'anyfusion-planner',
      modelPolicy: { mode: 'fixed', modelRef: 'default-model' },
      routingCapabilities: [],
      primaryUseCases: [],
      avoidUseCases: [],
      plannerAffordances: [],
      skills: [],
      mcpServers: [],
      plugins: [],
      generatedRuntimeRef: 'planner',
      enabled: true,
    },
  },
};

/** Shape written by `buildConfiguration` in the native installer. */
function installerProvider() {
  const providerRef = 'provider';
  return {
    ref: providerRef,
    provider: {
      displayName: 'DeepSeek（系统默认）',
      protocol: 'openai-compatible' as const,
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyRef: `file-secret:anyfusion/providers/${providerRef}`,
      region: 'international' as const,
      enabled: true,
    },
  };
}

/** Shape written by the settings save path (`resolveProviderSecretReference`). */
function settingsProvider(providerRef = 'custom-model-1') {
  return {
    ref: providerRef,
    provider: {
      displayName: 'My DeepSeek',
      protocol: 'openai-compatible' as const,
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyRef: `file-secret:anyfusion/providers/${providerRef}`,
      region: 'international' as const,
      enabled: true,
    },
  };
}

function configuration(entry: { ref: string; provider: Record<string, unknown> }) {
  const provider = (ref: string) => ({
    protocol: 'openai-compatible' as const,
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyRef: `file-secret:anyfusion/providers/${ref}`,
    region: 'international' as const,
    enabled: true,
  });
  return {
    ...base,
    providers: {
      // The Planner keeps its own Provider so deleting the Provider under test
      // does not force the Planner to be disabled.
      other: { ...provider('other'), displayName: 'Other' },
      [entry.ref]: entry.provider,
    },
    models: {
      'other-model': {
        providerRef: 'other',
        modelId: 'deepseek-flash',
        capabilities: ['coding', 'planning', 'structured-output', 'tools'],
        reasoning: 'high',
        enabled: true,
      },
      [`${entry.ref}-model`]: {
        providerRef: entry.ref,
        modelId: 'deepseek-v4-pro',
        capabilities: ['coding', 'planning', 'structured-output', 'tools'],
        reasoning: 'high',
        enabled: true,
      },
    },
    agentClasses: {
      ...base.agentClasses,
      planner: { ...base.agentClasses.planner, modelPolicy: { mode: 'fixed', modelRef: 'other-model' } },
    },
  };
}

describe('install-time and settings-time Providers', () => {
  it('produces the same Provider resource from both entry points', () => {
    const install = installerProvider();
    const settings = settingsProvider();

    const installResult = validateConfigurationCandidate(configuration(install));
    const settingsResult = validateConfigurationCandidate(configuration(settings));

    expect(installResult.ok, JSON.stringify(installResult.issues)).toBe(true);
    expect(settingsResult.ok, JSON.stringify(settingsResult.issues)).toBe(true);
    for (const [result, entry] of [
      [installResult, install] as const,
      [settingsResult, settings] as const,
    ]) {
      if (!result.ok) throw new Error('configuration must validate');
      const provider = result.config.providers[entry.ref]!;
      expect(Object.keys(provider).sort()).toEqual([
        'apiKeyRef',
        'baseUrl',
        'displayName',
        'enabled',
        'protocol',
        'region',
      ]);
      // No hidden system-management flag makes one of them special.
      expect('systemManaged' in provider).toBe(false);
    }
  });

  it('treats both Providers identically in the completion catalog', () => {
    for (const entry of [installerProvider(), settingsProvider()]) {
      const config = configuration(entry);
      if (!validateConfigurationCandidate(config).ok) throw new Error('configuration must validate');
      const completion = new ConfigurationCompletionService({
        presets: [{
          providerRef: 'deepseek',
          displayName: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/v1',
          modelIds: ['deepseek-chat'],
        }],
      }).complete({ providers: config.providers as Record<string, Record<string, unknown>>, models: config.models });

      expect(Object.keys(completion.providers).sort()).toEqual(['other', entry.ref].sort());
      expect(completion.providers[entry.ref]).toMatchObject({
        displayName: entry.provider.displayName,
        baseUrl: entry.provider.baseUrl,
      });
    }
  });

  it('allows both Providers to be deleted without special-case handling', () => {
    for (const entry of [installerProvider(), settingsProvider()]) {
      const config = configuration(entry);
      const withoutProvider = {
        ...config,
        providers: { other: config.providers.other },
        models: { 'other-model': config.models['other-model'] },
      };

      const result = validateConfigurationCandidate(withoutProvider);
      expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    }
  });
});
