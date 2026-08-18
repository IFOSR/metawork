import { describe, expect, it } from 'vitest';
import {
  createMigrationContextFromSnapshot,
} from '../../src/installation/schema30-migration-context.js';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';

describe('schema 30 installer migration context', () => {
  it('seals exact Planner and legacy Executor aliases from one active revision', () => {
    const context = createMigrationContextFromSnapshot(snapshot(), '2026-08-14T00:00:00.000Z');

    expect(context.revisionId).toBe('revision-1');
    expect(context.plannerBinding).toMatchObject({
      agentClassRef: 'planner-default',
      harnessRef: 'anyfusion-planner',
      modelRef: 'model',
      providerRef: 'provider',
    });
    expect(context.legacyAgentClassBindings['codex-engineering']).toMatchObject({
      agentClassRef: 'codex-engineering',
    });
    expect(context.legacyAgentClassBindings['codex-cli']).toEqual(
      context.legacyAgentClassBindings['codex-engineering'],
    );
  });

  it('fails closed when migration would need to guess an auto-selected model', () => {
    const input = snapshot();
    input.config.agentClasses['codex-engineering']!.modelPolicy = {
      mode: 'auto',
      allowedModelRefs: ['model'],
    };

    expect(() => createMigrationContextFromSnapshot(input))
      .toThrow('fixed Model');
  });

  it('fails closed when a legacy alias maps to multiple AgentClasses', () => {
    const input = snapshot();
    input.config.agentClasses['codex-review'] = {
      ...input.config.agentClasses['codex-engineering']!,
      generatedRuntimeRef: 'codex-review',
    };

    expect(() => createMigrationContextFromSnapshot(input))
      .toThrow('ambiguous legacy AgentClass alias: codex-cli');
  });
});

function snapshot(): ConfigurationSnapshot {
  return {
    revisionId: 'revision-1',
    contentHash: 'content-hash',
    config: {
      schemaVersion: 2,
      providers: {
        provider: {
          protocol: 'openai-compatible',
          baseUrl: 'https://example.com/v1',
          apiKeyRef: 'file-secret:anyfusion/provider',
          region: 'international',
          enabled: true,
        },
      },
      models: {
        model: {
          providerRef: 'provider',
          modelId: 'model',
          capabilities: ['coding', 'planning'],
          reasoning: 'high',
          enabled: true,
        },
      },
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
        'codex-cli': {
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
        'planner-default': {
          kind: 'planner',
          harnessRef: 'anyfusion-planner',
          modelPolicy: { mode: 'fixed', modelRef: 'model' },
          routingCapabilities: [],
          primaryUseCases: [],
          avoidUseCases: [],
          plannerAffordances: [],
          skills: [],
          mcpServers: [],
          plugins: [],
          generatedRuntimeRef: 'planner-default',
          enabled: true,
        },
        'codex-engineering': {
          kind: 'executor',
          harnessRef: 'codex-cli',
          modelPolicy: { mode: 'fixed', modelRef: 'model' },
          permissionProfileRef: 'workspace',
          routingCapabilities: ['workspace-engineering'],
          primaryUseCases: [],
          avoidUseCases: [],
          plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
          skills: [],
          mcpServers: [],
          plugins: [],
          generatedRuntimeRef: 'codex-engineering',
          enabled: true,
        },
      },
      permissionProfiles: {
        workspace: {
          profileId: 'workspace-engineering',
          version: 1,
          parameters: {},
        },
      },
      runtimePolicy: {},
      gateway: {},
    },
  };
}
