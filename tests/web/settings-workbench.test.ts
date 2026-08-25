import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PUBLIC_PROVIDER_PRESETS } from '../../src/configuration/public-provider-catalog.js';
import {
  buildProviderModelOptions,
  dedupeModelEntries,
  evaluateModelCompatibility,
  invalidRoutingDrafts,
  isGptRelatedModel,
  mergeCompletedModelFacts,
  removeModelRefsFromRoutingDraft,
  refsForModelIdentity,
  replaceModelIdentity,
  toggleModelRef,
  type AgentClassRoutingFacts,
  type SettingsModelEntry,
  type SettingsProviderEntry,
} from '../../web/src/settings-model.js';

const webRoot = new URL('../../web/src/', import.meta.url);

describe('Settings workbench model semantics', () => {
  it('exposes the current DeepSeek V4 Flash model IDs in the Provider preset', () => {
    expect(PUBLIC_PROVIDER_PRESETS.find(preset => preset.providerRef === 'deepseek')?.modelIds)
      .toEqual(expect.arrayContaining([
        'deepseek-v4-flash',
        'deepseek-v4-flash-vision-exp',
      ]));
  });

  const providers: SettingsProviderEntry[] = [
    {
      providerRef: 'code-cli',
      displayName: 'Code CLI',
      baseUrl: 'https://code.example/v1',
      modelIds: ['gpt-5.6-sol', 'gpt-5.5-mini'],
      credentialState: '已自动发现',
    },
  ];
  const models: SettingsModelEntry[] = [
    {
      ref: 'code-gpt-56',
      providerRef: 'code-cli',
      modelId: 'gpt-5.6-sol',
      capabilities: ['coding', 'tools'],
      capabilityState: '已自动发现',
    },
  ];

  it('derives selectable model options from the selected Provider catalog', () => {
    expect(buildProviderModelOptions(providers, models, 'code-cli')).toEqual([
      { modelId: 'gpt-5.5-mini', configured: false, modelRef: null },
      { modelId: 'gpt-5.6-sol', configured: true, modelRef: 'code-gpt-56' },
    ]);
  });

  it('toggles an allowed model pool without collapsing it to one model', () => {
    expect(toggleModelRef(['code-gpt-56'], 'code-gpt-55-mini', true)).toEqual([
      'code-gpt-55-mini',
      'code-gpt-56',
    ]);
    expect(toggleModelRef(['code-gpt-56', 'code-gpt-55-mini'], 'code-gpt-56', false))
      .toEqual(['code-gpt-55-mini']);
  });

  it('explains baseline capability eligibility using the same routing capability mapping', () => {
    const facts: AgentClassRoutingFacts = {
      agentClassRef: 'codex-cli',
      displayName: 'Code CLI',
      kind: 'executor',
      harnessRef: 'codex-cli',
      harnessLabel: 'Code CLI',
      transport: 'local-cli',
      driverId: 'codex-cli',
      primaryUseCases: ['repository implementation'],
      avoidUseCases: [],
      routingCapabilities: ['workspace-engineering'],
      capabilityContracts: ['在受控工作区理解、修改和验证代码或文本文件，并交付变更或产物。'],
      affordances: ['workspace-read-write', 'workspace-command-validation'],
    };

    expect(evaluateModelCompatibility(models[0]!, facts)).toEqual({
      eligible: true,
      requiredCapabilities: ['gpt-family'],
      missingCapabilities: [],
    });
    expect(evaluateModelCompatibility({
      ...models[0]!,
      modelId: 'deepseek-v4-pro',
      capabilities: ['tools'],
    }, facts)).toEqual({
      eligible: false,
      requiredCapabilities: ['gpt-family'],
      missingCapabilities: ['gpt-family'],
    });
  });

  it('matches Codex GPT candidates across Providers without accepting unrelated models', () => {
    expect(isGptRelatedModel('gpt-5.6-sol')).toBe(true);
    expect(isGptRelatedModel('openai/gpt-5.6-fast')).toBe(true);
    expect(isGptRelatedModel('deepseek-v4-pro')).toBe(false);

    const codexFacts: AgentClassRoutingFacts = {
      agentClassRef: 'codex-cli',
      displayName: 'Code CLI',
      kind: 'executor',
      harnessRef: 'codex-cli',
      harnessLabel: 'Code CLI',
      transport: 'local-cli',
      driverId: 'codex-cli',
      primaryUseCases: [],
      avoidUseCases: [],
      routingCapabilities: ['workspace-engineering'],
      capabilityContracts: [],
      affordances: ['workspace-read-write', 'workspace-command-validation'],
    };
    expect(evaluateModelCompatibility({
      ...models[0]!,
      providerRef: 'other-provider',
      modelId: 'gpt-5.6-fast',
    }, codexFacts).eligible).toBe(true);
    expect(evaluateModelCompatibility({
      ...models[0]!,
      providerRef: 'deepseek',
      modelId: 'deepseek-v4-pro',
    }, codexFacts).missingCapabilities).toContain('gpt-family');
    expect(evaluateModelCompatibility({
      ...models[0]!,
      providerRef: 'kimi',
      modelId: 'k3',
      capabilities: [],
    }, {
      ...codexFacts,
      agentClassRef: 'pi-agent',
      harnessRef: 'pi-cli',
      routingCapabilities: ['current-web-research'],
    }).eligible).toBe(true);
  });

  it('does not carry model A metadata into model B after a Provider catalog switch', () => {
    expect(replaceModelIdentity({
      ...models[0]!,
      contextLimit: 200_000,
      qualityTier: 'high',
      costInputPerMillion: 1,
    }, 'code-cli', 'gpt-5.5-mini')).toMatchObject({
      providerRef: 'code-cli',
      modelId: 'gpt-5.5-mini',
      capabilities: [],
      capabilityState: '需要确认',
    });
    expect(replaceModelIdentity({
      ...models[0]!,
      enabled: false,
    }, 'deepseek', 'deepseek-v4-pro').enabled).toBe(false);
  });

  it('merges completion facts into a model that still needs confirmation', () => {
    expect(mergeCompletedModelFacts({
      ref: 'custom',
      providerRef: 'code-cli',
      modelId: 'gpt-5.6-sol',
      capabilities: [],
      capabilityState: '需要确认',
    }, {
      capabilities: ['coding', 'tools'],
      capabilityState: '已从 Provider 补全',
      contextLimit: 128_000,
      qualityTier: 'high',
    })).toMatchObject({
      capabilities: ['coding', 'tools'],
      capabilityState: '已从 Provider 补全',
      contextLimit: 128_000,
      qualityTier: 'high',
    });
  });

  it('treats Provider models as the candidate source without duplicating shared identities', () => {
    const duplicate = {
      ...models[0]!,
      ref: 'code-gpt-56-alias',
    };
    expect(dedupeModelEntries([models[0]!, duplicate, {
      ...models[0]!,
      ref: 'deepseek-v4',
      providerRef: 'deepseek',
      modelId: 'deepseek-v4-pro',
    }]).map(model => model.ref)).toEqual([
      'code-gpt-56',
      'deepseek-v4',
    ]);
    expect(refsForModelIdentity(
      [models[0]!, duplicate],
      'code-cli',
      'gpt-5.6-sol',
    )).toEqual(['code-gpt-56', 'code-gpt-56-alias']);
  });

  it('removes deleted Provider models from Auto pools and marks Fixed refs unavailable', () => {
    const draft = {
      planner: {
        mode: 'fixed' as const,
        modelRef: 'code-gpt-56',
        allowedModelRefs: ['code-gpt-56'],
        defaultModelRef: 'code-gpt-56',
        objective: 'balanced' as const,
        minimumQualityTier: 'low' as const,
      },
      'codex-cli': {
        mode: 'auto' as const,
        modelRef: '',
        allowedModelRefs: ['code-gpt-56', 'code-gpt-55-mini'],
        defaultModelRef: 'code-gpt-56',
        objective: 'balanced' as const,
        minimumQualityTier: 'low' as const,
      },
    };
    const next = removeModelRefsFromRoutingDraft(draft, ['code-gpt-56']);
    expect(next.planner.modelRef).toBe('');
    expect(next['codex-cli'].allowedModelRefs).toEqual(['code-gpt-55-mini']);
    expect(next['codex-cli'].defaultModelRef).toBe('code-gpt-55-mini');
    expect(invalidRoutingDrafts(next, [{
      ...models[0]!,
      ref: 'code-gpt-55-mini',
      modelId: 'gpt-5.5-mini',
    }])).toEqual(['planner']);
  });

  it('keeps internal revision identifiers out of the primary Settings UI', async () => {
    const [panel, routing] = await Promise.all([
      readFile(new URL('components/SettingsPanel.tsx', webRoot), 'utf8'),
      readFile(new URL('components/AgentClassConfig.tsx', webRoot), 'utf8'),
    ]);
    const header = await readFile(new URL('components/WorkspaceHeader.tsx', webRoot), 'utf8');
    const styles = await readFile(new URL('styles.css', webRoot), 'utf8');

    expect(panel).toContain('高级诊断');
    expect(panel).not.toContain('../preset-providers');
    expect(panel).toContain('providerPresets.find');
    expect(panel).toContain('draftValidationIssues.length > 0');
    expect(routing).toContain('当前没有可用模型，请重新选择');
    expect(routing).toContain('适合做什么');
    expect(routing).toContain('为什么这样路由');
    expect(panel).not.toContain('运行 {runningRevisionId');
    expect(header).not.toContain('rev ${revisionId}');
    expect(styles).toContain('settings-workbench');
    expect(styles).toContain('overflow-x: hidden');
  });
});
