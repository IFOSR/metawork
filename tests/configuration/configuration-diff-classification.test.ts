import { describe, expect, it } from 'vitest';
import {
  classifyConfigurationDiff,
  type ConfigurationChangeClass,
} from '../../src/configuration/configuration-diff.js';

describe('configuration diff classification', () => {
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
