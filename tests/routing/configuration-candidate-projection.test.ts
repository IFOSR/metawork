import { describe, expect, it } from 'vitest';
import {
  projectConfigurationCandidates,
  type CandidateProjectionConfiguration,
} from '../../src/routing/configuration-candidate-projection.js';

function configuration(): CandidateProjectionConfiguration {
  return {
    agentClasses: {
      'codex-cli': { harnessRef: 'codex-harness' },
      'pi-agent': { harnessRef: 'pi-harness' },
    },
    providers: {
      primary: { enabled: true },
      secondary: { enabled: true },
      disabled: { enabled: false },
    },
    models: {
      'gpt-primary': {
        providerRef: 'primary',
        modelId: 'gpt-5.6-sol',
        capabilities: ['coding', 'tools'],
        enabled: true,
      },
      'gpt-secondary': {
        providerRef: 'secondary',
        modelId: 'openai/gpt-5.6-terra',
        capabilities: ['coding', 'tools'],
        enabled: true,
      },
      deepseek: {
        providerRef: 'secondary',
        modelId: 'deepseek-v4-pro',
        capabilities: ['coding', 'tools'],
        enabled: true,
      },
      disabledProviderModel: {
        providerRef: 'disabled',
        modelId: 'gpt-5.6-disabled',
        capabilities: ['coding', 'tools'],
        enabled: true,
      },
    },
  };
}

describe('configuration candidate projection', () => {
  it('projects GPT candidates for Codex across enabled Providers without using Provider names', () => {
    const candidates = projectConfigurationCandidates(configuration(), 'codex-cli');

    expect(candidates.map(candidate => candidate.modelRef)).toEqual([
      'deepseek',
      'gpt-primary',
      'gpt-secondary',
    ]);
    expect(candidates.find(candidate => candidate.modelRef === 'deepseek')).toMatchObject({
      harnessCompatible: false,
    });
    expect(candidates.find(candidate => candidate.modelRef === 'gpt-secondary')).toMatchObject({
      providerRef: 'secondary',
      harnessCompatible: true,
    });
    expect(candidates.some(candidate => candidate.modelRef === 'disabledProviderModel')).toBe(false);
  });

  it('projects every enabled model for Pi while excluding disabled Providers', () => {
    const candidates = projectConfigurationCandidates(configuration(), 'pi-agent');

    expect(candidates.map(candidate => candidate.modelRef)).toEqual([
      'deepseek',
      'gpt-primary',
      'gpt-secondary',
    ]);
    expect(candidates.every(candidate => candidate.harnessCompatible !== false)).toBe(true);
  });

  it('does not apply the Codex GPT filter to a user-selected Fixed model', () => {
    const candidates = projectConfigurationCandidates(configuration(), 'codex-cli', {
      mode: 'fixed',
    });

    expect(candidates.find(candidate => candidate.modelRef === 'deepseek')).toMatchObject({
      harnessCompatible: true,
    });
  });

  it('uses per-Executor user-confirmed model capabilities for Kernel candidates', () => {
    const input = configuration();
    input.agentClasses['pi-agent']!.modelCapabilities = {
      'gpt-primary': ['coding', 'tools', 'image-generation'],
    };

    const candidates = projectConfigurationCandidates(input, 'pi-agent');

    expect(candidates.find(candidate => candidate.modelRef === 'gpt-primary')?.capabilities)
      .toContain('image-generation');
    expect(candidates.find(candidate => candidate.modelRef === 'gpt-secondary')?.capabilities)
      .not.toContain('image-generation');
  });
});
