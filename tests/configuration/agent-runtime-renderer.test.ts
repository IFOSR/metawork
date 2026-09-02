import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentRuntimeRenderer,
  resolveCurrentRuntimeHome,
} from '../../src/configuration/agent-runtime-renderer.js';
import { buildPlannerConfigurationView } from '../../src/configuration/projections.js';
import type { AnyFusionConfigurationV2, ConfigurationSnapshot } from '../../src/configuration/types.js';

function makeConfig(): AnyFusionConfigurationV2 {
  return {
    schemaVersion: 2,
    providers: {
      'provider-a': {
        protocol: 'openai-compatible',
        baseUrl: 'https://a.example/v1',
        apiKeyRef: 'file-secret:anyfusion/providers/provider-a',
        region: null,
        enabled: true,
      },
      'provider-b': {
        protocol: 'openai-compatible',
        baseUrl: 'https://b.example/v1',
        apiKeyRef: 'file-secret:anyfusion/providers/provider-b',
        region: null,
        enabled: true,
      },
    },
    models: {
      'model-a': {
        modelId: 'gpt-a',
        providerRef: 'provider-a',
        capabilities: [],
        reasoning: 'high',
        costTier: null,
        latencyTier: null,
        enabled: true,
      },
      'model-b': {
        modelId: 'gpt-b',
        providerRef: 'provider-b',
        capabilities: [],
        reasoning: 'high',
        costTier: null,
        latencyTier: null,
        enabled: true,
      },
      image: {
        modelId: 'gpt-image-2',
        providerRef: 'provider-a',
        capabilities: ['vision'],
        reasoning: 'disabled',
        enabled: true,
      },
    },
    harnesses: {
      'engineering-local': {
        kind: 'executor',
        transport: 'local-cli',
        command: 'codex',
        args: [],
        driverId: 'codex-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
    },
    agentClasses: {
      planner: {
        kind: 'planner',
        harnessRef: 'anyfusion-planner',
        modelPolicy: {
          mode: 'fixed',
          modelRef: 'model-a',
        },
        permissionProfileRef: null,
        routingCapabilities: [],
        enabled: true,
      },
      engineering: {
        kind: 'executor',
        harnessRef: 'engineering-local',
        modelPolicy: {
          mode: 'auto',
          allowedModelRefs: ['model-a', 'image'],
          defaultModelRef: 'model-a',
        },
        permissionProfileRef: 'workspace-engineering',
        routingCapabilities: ['workspace-engineering'],
        primaryUseCases: ['repository implementation'],
        avoidUseCases: [],
        plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: 'engineering',
        enabled: true,
      },
    },
    permissionProfiles: {},
    runtimePolicy: {},
    gateway: null,
  } as unknown as AnyFusionConfigurationV2;
}

function snapshot(revisionId: string, config: AnyFusionConfigurationV2): ConfigurationSnapshot {
  return { revisionId, contentHash: revisionId, config };
}

describe('AgentRuntimeRenderer', () => {
  it('renders one provider section per enabled provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-renderer-'));
    try {
      const renderer = new AgentRuntimeRenderer(root);
      await renderer.render(snapshot('rev-1', makeConfig()));

      const modelsRaw = await readFile(join(root, 'rev-1', 'planner', 'models.json'), 'utf8');
      const models = JSON.parse(modelsRaw) as { providers: Record<string, { baseUrl: string }> };
      expect(Object.keys(models.providers).sort()).toEqual(['provider-a', 'provider-b']);
      expect(models.providers['provider-a'].baseUrl).toBe('https://a.example/v1');
      expect(models.providers['provider-b'].baseUrl).toBe('https://b.example/v1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes default model/provider into settings.json and the current pointer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-renderer-'));
    try {
      const renderer = new AgentRuntimeRenderer(root);
      await renderer.render(snapshot('rev-1', makeConfig()));

      const settingsRaw = await readFile(join(root, 'rev-1', 'planner', 'settings.json'), 'utf8');
      const settings = JSON.parse(settingsRaw) as { defaultProvider: string; defaultModel: string };
      expect(settings.defaultProvider).toBe('provider-a');
      expect(settings.defaultModel).toBe('gpt-a');

      expect(resolveCurrentRuntimeHome(root, 'planner')).toBe(join(root, 'rev-1', 'planner'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renders an independent capability manual for each Executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-renderer-'));
    try {
      const renderer = new AgentRuntimeRenderer(root);
      await renderer.render(snapshot('rev-1', makeConfig()));

      const manual = await readFile(
        join(root, 'rev-1', 'executors', 'engineering', 'CAPABILITY.md'),
        'utf8',
      );
      const expected = buildPlannerConfigurationView(snapshot('rev-1', makeConfig()))
        .executorCapabilityManuals?.find(entry => entry.agentClassRef === 'engineering');
      expect(manual).toContain('# Executor：engineering');
      expect(manual).toContain('代码仓库实现');
      expect(manual).toBe(expected?.markdown);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('switches the current pointer atomically and keeps the previous revision directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-renderer-'));
    try {
      const renderer = new AgentRuntimeRenderer(root);
      await renderer.render(snapshot('rev-1', makeConfig()));
      await renderer.render(snapshot('rev-2', makeConfig()));

      expect(resolveCurrentRuntimeHome(root, 'planner')).toBe(join(root, 'rev-2', 'planner'));
      await expect(stat(join(root, 'rev-1', 'planner', 'models.json'))).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renders multi-provider codex config.toml with per-provider sections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-renderer-'));
    try {
      const renderer = new AgentRuntimeRenderer(root);
      await renderer.render(snapshot('rev-1', makeConfig()));

      const toml = await readFile(join(root, 'rev-1', 'codex', 'config.toml'), 'utf8');
      expect(toml).toContain('[model_providers.provider-a]');
      expect(toml).toContain('[model_providers.provider-b]');
      expect(toml).toContain('base_url = "https://a.example/v1"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns undefined when no current pointer exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-renderer-'));
    try {
      expect(resolveCurrentRuntimeHome(root, 'planner')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
