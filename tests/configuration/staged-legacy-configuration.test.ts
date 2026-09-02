import { describe, expect, it } from 'vitest';
import {
  compileConfigurationRevision,
} from '../../src/configuration/configuration-service.js';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';
import { AnyFusionConfigurationV2Schema } from '../../src/configuration/schema.js';
import { buildStagedLegacyConfiguration } from '../../src/configuration/staged-legacy-configuration.js';
import { load } from 'js-yaml';

describe('buildStagedLegacyConfiguration', () => {
  it('pins test Planner and Kernel views to revision-test', () => {
    const staged = buildStagedLegacyConfiguration({
      testMode: true,
    });

    expect(staged.snapshot.revisionId).toBe('revision-test');
    expect(staged.planner.revisionId).toBe('revision-test');
    expect(staged.planner.routingCatalog.configurationRevision).toBe('revision-test');
    expect(staged.kernel.revisionId).toBe('revision-test');
    expect(staged.plannerBinding.configurationRevision).toBe('revision-test');
  });

  it('fails closed when production startup does not provide a migrated snapshot', () => {
    expect(() => buildStagedLegacyConfiguration({
      testMode: false,
    })).toThrow(/explicit migrated configuration snapshot/u);
  });

  it('projects an explicitly migrated snapshot without consulting legacy runtime files', () => {
    const migratedSnapshot = migratedSnapshotFixture();
    const staged = buildStagedLegacyConfiguration({
      migratedSnapshot,
    });

    expect(staged.snapshot).toBe(migratedSnapshot);
    expect(staged.snapshot.revisionId).toBe('revision-current');
    expect(staged.planner.revisionId).toBe(staged.kernel.revisionId);
    expect(staged.plannerBinding).toMatchObject({
      providerRef: 'openai-main',
      modelRef: 'gpt-5-6-terra',
      configurationRevision: staged.snapshot.revisionId,
    });
    const provider = staged.snapshot.config.providers[
      staged.plannerBinding.providerRef
    ];
    const model = staged.snapshot.config.models[staged.plannerBinding.modelRef];
    expect(provider).toMatchObject({
      baseUrl: 'https://api.example.com/v1',
      apiKeyRef: 'keychain:anyfusion/imported/openai-main',
    });
    expect(model).toMatchObject({
      providerRef: staged.plannerBinding.providerRef,
      modelId: 'gpt-5.6/terra',
    });
  });

  it('rejects a migrated snapshot whose content hash does not match its configuration', () => {
    const migratedSnapshot = migratedSnapshotFixture();

    expect(() => buildStagedLegacyConfiguration({
      migratedSnapshot: {
        ...migratedSnapshot,
        contentHash: 'stale-content-hash',
      },
    })).toThrow(/content hash mismatch/u);
  });

  it('accepts the exact legacy hash from before parallel policy defaults were added', () => {
    const migratedSnapshot = migratedSnapshotFixture();
    const {
      maxConcurrentTasks: _maxConcurrentTasks,
      maxConcurrentAttempts: _maxConcurrentAttempts,
      maxConcurrentAttemptsPerTask: _maxConcurrentAttemptsPerTask,
      schedulingAgingMs: _schedulingAgingMs,
      sameConversationQueueLimit: _sameConversationQueueLimit,
      ...legacyRuntimePolicy
    } = migratedSnapshot.config.runtimePolicy;
    const legacyCompiled = compileConfigurationRevision('legacy-runtime-policy', {
      ...migratedSnapshot.config,
      runtimePolicy: legacyRuntimePolicy,
    });

    const staged = buildStagedLegacyConfiguration({
      migratedSnapshot: {
        revisionId: 'revision-current',
        contentHash: legacyCompiled.contentHash,
        config: migratedSnapshot.config,
      },
    });

    expect(staged.snapshot.config.runtimePolicy).toMatchObject({
      maxConcurrentTasks: 2,
      maxConcurrentAttempts: 4,
      maxConcurrentAttemptsPerTask: 2,
      schedulingAgingMs: 300_000,
      sameConversationQueueLimit: 8,
    });
  });

  it('keeps the configuration hash stable when optional fields are undefined', () => {
    const migratedSnapshot = migratedSnapshotFixture();
    const config = structuredClone(migratedSnapshot.config);
    config.agentClasses['codex-cli']!.executorManual = {
      sourceText: '优先承担代码实现。',
      assertionsSourceFingerprint: undefined,
      semanticReceipt: undefined,
      assertions: [],
    };
    const compiled = compileConfigurationRevision('test-undefined-fields', config);
    const roundTrippedConfig = AnyFusionConfigurationV2Schema.parse(
      load(compiled.files['config.yaml'] as string),
    );

    expect(() => buildStagedLegacyConfiguration({
      migratedSnapshot: {
        revisionId: 'revision-current',
        contentHash: compiled.contentHash,
        config: roundTrippedConfig,
      },
    })).not.toThrow();
  });

  it('rejects an Auto Planner policy', () => {
    const migratedSnapshot = migratedSnapshotFixture();
    const config = structuredClone(migratedSnapshot.config);
    config.agentClasses.planner.modelPolicy = {
      mode: 'auto',
      allowedModelRefs: ['gpt-5-6-terra'],
    };
    const compiled = compileConfigurationRevision('test-migrated', config);
    expect(() => buildStagedLegacyConfiguration({
      migratedSnapshot: {
        revisionId: 'revision-current',
        contentHash: compiled.contentHash,
        config,
      },
    })).toThrow();
  });
});

function migratedSnapshotFixture(): ConfigurationSnapshot {
  const fixture = buildStagedLegacyConfiguration({ testMode: true });
  const config = structuredClone(fixture.snapshot.config);
  config.providers = {
    'openai-main': {
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      apiKeyRef: 'keychain:anyfusion/imported/openai-main',
      region: 'international',
      enabled: true,
    },
  };
  config.models = {
    'gpt-5-6-terra': {
      providerRef: 'openai-main',
      modelId: 'gpt-5.6/terra',
      capabilities: ['coding', 'planning', 'structured-output', 'tools'],
      reasoning: 'high',
      enabled: true,
    },
  };
  for (const agentClass of Object.values(config.agentClasses)) {
    agentClass.modelPolicy = {
      mode: 'fixed',
      modelRef: 'gpt-5-6-terra',
    };
  }
  const compiled = compileConfigurationRevision('test-migrated', config);
  return {
    revisionId: 'revision-current',
    contentHash: compiled.contentHash,
    config,
  };
}
