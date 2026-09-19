import { describe, expect, it } from 'vitest';
import {
  projectConfigurationCandidates,
  type CandidateProjectionConfiguration,
} from '../../src/routing/configuration-candidate-projection.js';

function configuration(): CandidateProjectionConfiguration {
  return {
    agentClasses: {
      // 故意使用与工具无关的键名与 Harness 名：兼容性必须由真实 driverId 决定。
      'codex-cli': { kind: 'executor', harnessRef: 'codex-harness', driverId: 'codex-cli' },
      'pi-agent': { kind: 'executor', harnessRef: 'pi-harness', driverId: 'pi-cli' },
      planner: { kind: 'planner', harnessRef: 'planner-harness', driverId: 'anyfusion-planner-host-v2' },
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

  it('resolves Codex compatibility from the harness driverId, not from names', () => {
    const input = configuration();
    // 自定义助手名与 Harness 键名，真实 Driver 仍是 codex-cli。
    input.agentClasses['dev-assistant'] = {
      kind: 'executor',
      harnessRef: 'my-build-tool',
    };
    input.harnesses = {
      'my-build-tool': { driverId: 'codex-cli' },
    };

    const candidates = projectConfigurationCandidates(input, 'dev-assistant');
    expect(candidates.find(candidate => candidate.modelRef === 'deepseek'))
      .toMatchObject({ harnessCompatible: false });
    expect(candidates.find(candidate => candidate.modelRef === 'gpt-primary'))
      .toMatchObject({ harnessCompatible: true });
  });

  it('does not apply Codex rules to a Pi driver even when names contain codex', () => {
    const input = configuration();
    input.agentClasses['codex-helper'] = {
      kind: 'executor',
      harnessRef: 'codex-lookalike',
      driverId: 'pi-cli',
    };

    const candidates = projectConfigurationCandidates(input, 'codex-helper');
    expect(candidates.every(candidate => candidate.harnessCompatible !== false)).toBe(true);
  });

  it('fails closed for executors with an unknown driver', () => {
    const input = configuration();
    input.agentClasses.mystery = {
      kind: 'executor',
      harnessRef: 'mystery-harness',
      driverId: 'a2a-v1',
    };

    const candidates = projectConfigurationCandidates(input, 'mystery');
    expect(candidates.every(candidate => candidate.harnessCompatible === false)).toBe(true);
  });

  it('keeps the Planner candidate projection driver-independent', () => {
    const candidates = projectConfigurationCandidates(configuration(), 'planner');
    expect(candidates.length).toBeGreaterThan(0);
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

  it('fills catalogued capabilities for models that declare none', () => {
    const input = configuration();
    input.models['imported'] = {
      providerRef: 'secondary',
      modelId: 'deepseek-v4-pro',
      capabilities: [],
      enabled: true,
    };
    input.models['unknown'] = {
      providerRef: 'secondary',
      modelId: 'some-uncatalogued-model',
      capabilities: [],
      enabled: true,
    };

    const candidates = projectConfigurationCandidates(input, 'pi-agent');

    // 激活与 Kernel 投影会为目录收录的 modelId 补上能力，避免空能力模型在
    // Planner 绑定等硬性要求下被无提示拒绝。
    expect(candidates.find(candidate => candidate.modelRef === 'imported')?.capabilities)
      .toContain('structured-output');
    expect(candidates.find(candidate => candidate.modelRef === 'unknown')?.capabilities)
      .toEqual([]);
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
