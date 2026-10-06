import { describe, expect, it } from 'vitest';
import {
  classifyConfigurationDiff,
  type ConfigurationChangeClass,
} from '../../src/configuration/configuration-diff.js';
import { buildStagedLegacyConfiguration } from '../../src/configuration/staged-legacy-configuration.js';
import { buildExecutorConfigurationCandidate } from '../../src/configuration/executor-configuration.js';

describe('configuration diff classification', () => {
  it('hot activates the settings task limit without allowing unrelated runtime policy changes', () => {
    const base = buildStagedLegacyConfiguration({ testMode: true }).snapshot.config;
    const next = structuredClone(base);
    next.runtimePolicy.maxConcurrentTasks = 3;
    expect(classifyConfigurationDiff(base, next).classification).toBe('hot');
    next.runtimePolicy.maxConcurrentAttempts = 8;
    expect(classifyConfigurationDiff(base, next).restartPaths).toContain('runtimePolicy.maxConcurrentAttempts');
  });
  it('hot activates an agent bound to a model added in the same transaction', () => {
    const base = buildStagedLegacyConfiguration({ testMode: true }).snapshot;
    const config = structuredClone(base.config);
    config.models['new-model'] = { ...Object.values(config.models)[0]!, modelId: 'deepseek-flash' };
    const created = buildExecutorConfigurationCandidate({ ...base, config }, {
      operation: 'create', tool: 'pi', fields: {
        displayName: '日常秘书', modelPolicy: { mode: 'fixed', modelRef: 'new-model' },
        manualSourceText: '回答日常问题。', enabled: true,
      },
    });
    expect(classifyConfigurationDiff(base.config, created.config).classification).toBe('hot');
    created.config.agentClasses[created.createdAgentClassRef!]!.skills = ['untrusted-skill'];
    expect(classifyConfigurationDiff(base.config, created.config).classification).toBe('restart_required');
  });
  it('hot enables an existing executor tool while keeping command changes restart-required', () => {
    const base = buildStagedLegacyConfiguration({ testMode: true }).snapshot;
    const agent = base.config.agentClasses['pi-agent']!;
    agent.enabled = false;
    base.config.harnesses[agent.harnessRef]!.enabled = false;
    const candidate = buildExecutorConfigurationCandidate(base, { operation: 'enable', agentClassRef: 'pi-agent' });
    expect(classifyConfigurationDiff(base.config, candidate.config).classification).toBe('hot');
    candidate.config.agentClasses['pi-agent']!.responsibility = '开展市场和产品调研，整理带来源的分析报告。';
    expect(classifyConfigurationDiff(base.config, candidate.config).classification).toBe('hot');
    const changedPermissions = structuredClone(candidate.config);
    changedPermissions.agentClasses['pi-agent']!.skills = ['untrusted-skill'];
    expect(classifyConfigurationDiff(base.config, changedPermissions).classification).toBe('restart_required');
    const harness = candidate.config.harnesses[agent.harnessRef]!;
    if (harness.transport !== 'local-cli') throw new Error('Expected CLI tool');
    harness.args = ['--unsafe-change'];
    expect(classifyConfigurationDiff(base.config, candidate.config).classification).toBe('restart_required');
  });
  it('hot activates bounded creation, removal and permission changes, not arbitrary tool fields', () => {
    const base = buildStagedLegacyConfiguration({ testMode: true }).snapshot;
    const existing = base.config.agentClasses['pi-agent']!;
    const created = buildExecutorConfigurationCandidate(base, {
      operation: 'create', tool: 'pi', fields: {
        displayName: 'Research', modelPolicy: existing.modelPolicy,
        manualSourceText: '', enabled: true,
      },
    });
    expect(classifyConfigurationDiff(base.config, created.config).classification).toBe('hot');
    expect(classifyConfigurationDiff(created.config, base.config).classification).toBe('hot');
    const changed = buildExecutorConfigurationCandidate(base, {
      operation: 'update', agentClassRef: 'pi-agent', fields: {
        displayName: 'Engineering', modelPolicy: existing.modelPolicy,
        manualSourceText: '', enabled: true,
      },
    });
    expect(classifyConfigurationDiff(base.config, changed.config).classification).toBe('hot');
    created.config.agentClasses[created.createdAgentClassRef!]!.skills = ['untrusted-skill'];
    expect(classifyConfigurationDiff(base.config, created.config).classification).toBe('restart_required');
    const plannerRemoved = structuredClone(base.config);
    delete plannerRemoved.agentClasses.planner;
    expect(classifyConfigurationDiff(base.config, plannerRemoved).classification).toBe('restart_required');
  });

  it('classifies Provider, Model, and AgentClass routing changes as hot activation', () => {
    const result = classifyConfigurationDiff(
      {
        providers: { kimi: { baseUrl: 'https://old.example/v1' } },
        models: { kimi: { modelId: 'old-model' } },
        agentClasses: {
          codex: { modelPolicy: { mode: 'fixed', modelRef: 'kimi' } },
        },
      },
      {
        providers: { kimi: { baseUrl: 'https://new.example/v1' } },
        models: { kimi: { modelId: 'new-model' } },
        agentClasses: {
          codex: { modelPolicy: { mode: 'auto', allowedModelRefs: ['kimi'] } },
        },
      },
    );

    expect(result.classification).toBe<ConfigurationChangeClass>('hot');
    expect(result.restartRequired).toBe(false);
    expect(result.entries.map(entry => entry.path)).toEqual([
      'agentClasses.codex.modelPolicy.allowedModelRefs',
      'agentClasses.codex.modelPolicy.mode',
      'agentClasses.codex.modelPolicy.modelRef',
      'models.kimi.modelId',
      'providers.kimi.baseUrl',
    ]);
  });

  it('classifies AgentClass routing use-case hints as hot activation', () => {
    const result = classifyConfigurationDiff(
      {
        agentClasses: {
          codex: { primaryUseCases: ['repository implementation', 'tests'] },
        },
      },
      {
        agentClasses: {
          codex: {
            primaryUseCases: ['repository implementation', 'tests', 'image generation', 'image editing'],
            avoidUseCases: ['current public-web research'],
          },
        },
      },
    );

    expect(result.classification).toBe<ConfigurationChangeClass>('hot');
    expect(result.restartRequired).toBe(false);
    expect(result.restartPaths).toEqual([]);
    expect(result.entries.map(entry => entry.path)).toEqual([
      'agentClasses.codex.avoidUseCases',
      'agentClasses.codex.primaryUseCases',
    ]);
  });

  it('classifies AgentClass display name changes as hot activation', () => {
    // 展示名在投影时从当前快照解析，不进入编译产物，也不影响路由语义，
    // 因此与 primaryUseCases / executorManual 同类，必须可热激活。
    const result = classifyConfigurationDiff(
      {
        agentClasses: {
          'codex-engineering': { displayName: '智能体 2' },
        },
      },
      {
        agentClasses: {
          'codex-engineering': { displayName: 'Codex Engineering' },
        },
      },
    );

    expect(result.classification).toBe<ConfigurationChangeClass>('hot');
    expect(result.restartRequired).toBe(false);
    expect(result.restartPaths).toEqual([]);
    expect(result.entries.map(entry => entry.path)).toEqual([
      'agentClasses.codex-engineering.displayName',
    ]);
  });

  it('classifies Harness and Permission Profile changes as restart required', () => {
    const result = classifyConfigurationDiff(
      {
        harnesses: { codex: { command: 'codex' } },
        permissionProfiles: { workspace: { version: 1 } },
      },
      {
        harnesses: { codex: { command: 'other-codex' } },
        permissionProfiles: { workspace: { version: 2 } },
      },
    );

    expect(result.classification).toBe<ConfigurationChangeClass>('restart_required');
    expect(result.restartRequired).toBe(true);
    expect(result.restartPaths).toEqual([
      'harnesses.codex.command',
      'permissionProfiles.workspace.version',
    ]);
  });

  it('returns no change for equivalent documents with different key order', () => {
    const result = classifyConfigurationDiff(
      { providers: { kimi: { baseUrl: 'https://kimi.example/v1', enabled: true } } },
      { providers: { kimi: { enabled: true, baseUrl: 'https://kimi.example/v1' } } },
    );

    expect(result.classification).toBe<ConfigurationChangeClass>('none');
    expect(result.entries).toEqual([]);
    expect(result.restartRequired).toBe(false);
  });
});
