import { describe, expect, it } from 'vitest';
import {
  hasConfirmedDecisionModelCapability,
  selectableDecisionModels,
} from '../../web/src/components/SpanRoutingSettings.js';
import { rankOpenRouterCandidates } from '../../web/src/components/SettingsPanel.js';
import type { SettingsModelEntry, SettingsProviderEntry } from '../../web/src/settings-model.js';

function model(input: Partial<SettingsModelEntry> & Pick<SettingsModelEntry, 'ref' | 'providerRef' | 'modelId'>): SettingsModelEntry {
  return {
    capabilities: [],
    capabilityState: '需要确认',
    enabled: true,
    ...input,
  };
}

function provider(providerRef: string, enabled = true): SettingsProviderEntry {
  return {
    providerRef,
    displayName: providerRef,
    baseUrl: 'http://127.0.0.1/v1',
    modelIds: [],
    credentialState: '已自动发现',
    enabled,
  };
}

describe('system routing model projection', () => {
  it('matches a local Drex path to its exact OpenRouter model', () => {
    const candidates = rankOpenRouterCandidates('/drex/weights/drex-v1.5-Q8_0.gguf', {
      modelIds: ['nace-ai/drex-v1.5', 'amazon/nova-lite-v1'],
      metadata: {
        'nace-ai/drex-v1.5': { displayName: 'Nace.AI: Drex v1.5' },
        'amazon/nova-lite-v1': { displayName: 'Amazon: Nova Lite' },
      },
    });

    expect(candidates[0]?.modelId).toBe('nace-ai/drex-v1.5');
    expect(candidates[0]?.score).toBeGreaterThanOrEqual(94);
  });

  it('keeps enabled local models visible when the provider publishes no capabilities', () => {
    const local = model({
      ref: 'custom-model-7-9',
      providerRef: 'custom-model-7',
      modelId: '/drex/weights/drex-v1.5-Q8_0.gguf',
      description: '通过 /v1/systemone 契约提供服务，与 TypeSafe 的 Jev 共用接口。',
    });

    expect(selectableDecisionModels(
      { [local.ref]: local },
      { 'custom-model-7': provider('custom-model-7') },
    )).toEqual([local]);
    expect(hasConfirmedDecisionModelCapability(local)).toBe(true);
  });

  it('excludes disabled models and disabled providers', () => {
    const enabled = model({ ref: 'enabled', providerRef: 'p', modelId: 'enabled-model', description: 'System One/Jev decision model' });
    const disabledModel = model({ ref: 'disabled-model', providerRef: 'p', modelId: 'disabled-model', enabled: false });
    const disabledProviderModel = model({ ref: 'disabled-provider', providerRef: 'disabled', modelId: 'disabled-provider' });

    expect(selectableDecisionModels(
      {
        [enabled.ref]: enabled,
        [disabledModel.ref]: disabledModel,
        [disabledProviderModel.ref]: disabledProviderModel,
      },
      { p: provider('p'), disabled: provider('disabled', false) },
    ).map(item => item.ref)).toEqual(['enabled']);
  });

  it('recognizes structured output or routing notes as confirmed metadata', () => {
    expect(hasConfirmedDecisionModelCapability(model({
      ref: 'structured', providerRef: 'p', modelId: 'structured', description: '/v1/systemone', capabilities: ['structured-output'],
    }))).toBe(true);
    expect(hasConfirmedDecisionModelCapability(model({
      ref: 'described', providerRef: 'p', modelId: 'described', routingNotes: { summary: 'System One/Jev decision model' },
    }))).toBe(true);
  });
});
