import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  managerProviderEnv,
  writeManagerProviderConfig,
  type ManagerProviderConfiguration,
} from '../../src/planning/manager-host/provider-config.js';
import { buildManagerPlannerServices } from '../../src/planning/manager-host/session-transport.js';

// ADR-0055 D6: the Manager runs the packaged Pi, so MetaWork must render that
// Pi's provider configuration from the active revision and hand it the keys
// under exactly the variable names the renderer emits.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function configuration(overrides: Partial<ManagerProviderConfiguration> = {}): ManagerProviderConfiguration {
  return {
    providers: {
      alpha: {
        apiKeyRef: 'file-secret:alpha',
        baseUrl: 'https://alpha.example/v1',
        displayName: 'Alpha',
        enabled: true,
        protocol: 'openai-compatible',
        region: 'international',
      },
      beta: {
        apiKeyRef: 'file-secret:beta',
        baseUrl: 'https://beta.example',
        displayName: 'Beta',
        enabled: true,
        protocol: 'anthropic',
        region: 'international',
      },
      disabled: {
        apiKeyRef: 'file-secret:disabled',
        baseUrl: 'https://disabled.example',
        displayName: 'Off',
        enabled: false,
        protocol: 'openai-compatible',
        region: 'international',
      },
    },
    models: {
      'alpha-model': {
        providerRef: 'alpha', modelId: 'alpha-1', enabled: true, reasoning: 'high',
        capabilities: ['coding', 'tools'],
      },
      'beta-model': {
        providerRef: 'beta', modelId: 'beta-1', enabled: true, reasoning: 'disabled',
        capabilities: ['coding'],
      },
    },
    agentClasses: {
      planner: {
        modelPolicy: { mode: 'fixed', modelRef: 'alpha-model' },
      },
    },
  } as unknown as ManagerProviderConfiguration;
}

describe('manager provider configuration', () => {
  it('forwards provider configuration through the production transport composition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-transport-provider-'));
    dirs.push(root);
    const services = buildManagerPlannerServices({
      runtimeRoot: root,
      piCommand: fileURLToPath(new URL('../fixtures/fake-pi-rpc.mjs', import.meta.url)),
      resolveScope: () => ({ workspaceRoot: root, permissionProfileRef: 'engineering' }),
      providerConfig: { configuration: configuration(), agentClassId: 'planner', apiKeys: { alpha: 'test-key' } },
    });
    try {
      const settings = JSON.parse(readFileSync(join(root, 'manager/config/settings.json'), 'utf8'));
      const models = JSON.parse(readFileSync(join(root, 'manager/config/models.json'), 'utf8'));
      expect(settings).toMatchObject({ defaultProvider: 'alpha', defaultModel: 'alpha-1' });
      expect(models.providers.alpha.apiKey).toBe('$OPENAI_API_KEY__ALPHA');
      expect(JSON.stringify(models)).not.toContain('test-key');
    } finally { await services.close?.(); }
  });
  it('renders models.json and settings.json for the packaged Pi', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manager-provider-'));
    dirs.push(dir);
    const written = writeManagerProviderConfig({
      configDir: dir,
      configuration: configuration(),
      agentClassId: 'planner',
      providerSecrets: { OPENAI_API_KEY__ALPHA: 'sk-alpha' },
    });
    const models = JSON.parse(readFileSync(written.modelsPath, 'utf8'));
    expect(Object.keys(models.providers)).toEqual(['alpha', 'beta']);
    expect(models.providers.alpha).toMatchObject({
      baseUrl: 'https://alpha.example/v1',
      api: 'openai-completions',
      apiKey: '$OPENAI_API_KEY__ALPHA',
    });
    expect(models.providers.beta.api).toBe('anthropic-messages');
    const settings = JSON.parse(readFileSync(written.settingsPath, 'utf8'));
    expect(settings).toMatchObject({ defaultProvider: 'alpha', defaultModel: 'alpha-1', quietStartup: true });
    expect(written.modelCount).toBe(2);
    // Provider keys are credentials: the rendered files stay owner-only.
    expect(statSync(written.modelsPath).mode & 0o077).toBe(0);
  });

  it('maps provider keys onto the exact variables the renderer emits', () => {
    const env = managerProviderEnv(configuration(), { alpha: 'sk-alpha', beta: 'sk-beta', disabled: 'x' });
    expect(env).toEqual({
      OPENAI_API_KEY__ALPHA: 'sk-alpha',
      ANTHROPIC_API_KEY__BETA: 'sk-beta',
    });
  });

  it('uses the bare variable when a single provider is enabled', () => {
    const single = configuration();
    delete (single.providers as Record<string, unknown>).beta;
    delete (single.providers as Record<string, unknown>).disabled;
    expect(managerProviderEnv(single, { alpha: 'sk-alpha' })).toEqual({ OPENAI_API_KEY: 'sk-alpha' });
  });

  it('omits providers without a key instead of writing an empty secret', () => {
    expect(managerProviderEnv(configuration(), { alpha: 'sk-alpha' })).toEqual({
      OPENAI_API_KEY__ALPHA: 'sk-alpha',
    });
  });
});
