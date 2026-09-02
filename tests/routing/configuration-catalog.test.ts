import { describe, expect, it } from 'vitest';
import { AnyFusionConfigurationV2Schema } from '../../src/configuration/schema.js';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';
import {
  buildConfigurationCatalog,
  validateRoutingCapabilityReferences,
} from '../../src/routing/configuration-catalog.js';
import { buildExecutorCapabilityManual } from '../../src/routing/executor-capability-manual.js';

function snapshot(): ConfigurationSnapshot {
  return {
    revisionId: 'revision-1',
    contentHash: 'sha256:catalog',
    config: AnyFusionConfigurationV2Schema.parse({
      schemaVersion: 2,
      providers: {
        openai: {
          protocol: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          apiKeyRef: 'keychain:anyfusion/openai',
          region: 'international',
          enabled: true,
        },
      },
      models: {
        engineering: {
          providerRef: 'openai',
          modelId: 'engineering-model',
          capabilities: ['coding', 'tools'],
          reasoning: 'medium',
          enabled: true,
        },
      },
      harnesses: {
        codex: {
          kind: 'executor',
          transport: 'local-cli',
          command: 'codex',
          driverId: 'codex-cli',
          supportsProbe: true,
          supportsAbort: true,
          supportsContinuation: true,
          enabled: true,
        },
      },
      agentClasses: {
        engineering: {
          kind: 'executor',
          harnessRef: 'codex',
          modelPolicy: {
            mode: 'fixed',
            modelRef: 'engineering',
          },
          permissionProfileRef: 'workspace-default',
          routingCapabilities: ['workspace-engineering'],
          primaryUseCases: ['repository implementation'],
          avoidUseCases: ['current public-web research'],
          plannerAffordances: ['workspace-command-validation', 'workspace-read-write'],
          generatedRuntimeRef: 'engineering',
          enabled: true,
        },
        disabled: {
          kind: 'executor',
          harnessRef: 'codex',
          modelPolicy: {
            mode: 'fixed',
            modelRef: 'engineering',
          },
          permissionProfileRef: 'workspace-default',
          routingCapabilities: ['workspace-engineering'],
          primaryUseCases: [],
          avoidUseCases: [],
          plannerAffordances: ['workspace-command-validation', 'workspace-read-write'],
          generatedRuntimeRef: 'disabled',
          enabled: false,
        },
      },
      permissionProfiles: {
        'workspace-default': {
          profileId: 'workspace-engineering',
          version: 1,
          parameters: {},
        },
      },
      runtimePolicy: {},
      gateway: {},
    }),
  };
}

describe('configuration routing catalog', () => {
  it('projects deterministic Planner-safe capability and AgentClass facts', () => {
    const catalog = buildConfigurationCatalog(snapshot());

    expect(catalog).toEqual({
      version: 2,
      configurationRevision: 'revision-1',
      capabilities: [
        {
          id: 'current-web-research',
          deliveryContract:
            '研究当前公共网络信息，保留可追溯来源，并交付有来源支撑的结论。',
        },
        {
          id: 'image-editing',
          deliveryContract:
            '使用明确支持图片编辑的模型处理输入图片，并交付可验证的图片产物。',
        },
        {
          id: 'image-generation',
          deliveryContract:
            '使用明确支持图片生成的模型根据文本要求生成图片，并交付可验证的图片产物。',
        },
        {
          id: 'workspace-engineering',
          deliveryContract:
            '在受控工作区理解、修改和验证代码或文本文件，并交付变更或产物。',
        },
      ],
      agentClasses: [
        {
          id: 'engineering',
          routingCapabilities: ['workspace-engineering'],
        capabilityPreferences: [{
          capabilityId: 'workspace-engineering',
          disposition: 'allowed',
        }],
        modelCapabilities: {
          engineering: ['coding', 'tools'],
        },
        profileFingerprint: expect.stringMatching(/^sha256:/u),
          modelPolicy: {
            mode: 'fixed',
            modelRef: 'engineering',
          },
        },
      ],
    });
    expect(JSON.stringify(catalog)).not.toMatch(
      /"(?:apiKeyRef|baseUrl|command|harnessRef|permissionProfileRef|generatedRuntimeRef)"\s*:/,
    );
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.agentClasses)).toBe(true);
  });

  it('validates only registered, unique controlled Routing Capability IDs', () => {
    expect(validateRoutingCapabilityReferences([
      'workspace-engineering',
      'current-web-research',
    ])).toEqual([]);
    expect(validateRoutingCapabilityReferences([
      'workspace-engineering',
      'workspace-engineering',
      'arbitrary-shell',
    ])).toEqual([
      'duplicate Routing Capability reference: workspace-engineering',
      'unregistered Routing Capability: arbitrary-shell',
    ]);
  });

  it('derives image Routing Capabilities from the Executor model policy', () => {
    const candidate = structuredClone(snapshot());
    candidate.config.models.image = {
      providerRef: 'openai',
      modelId: 'gpt-image-2',
      capabilities: ['vision'],
      reasoning: 'disabled',
      enabled: true,
    };
    candidate.config.agentClasses.engineering.modelPolicy = {
      mode: 'auto',
      allowedModelRefs: ['engineering', 'image'],
      defaultModelRef: 'engineering',
    };

    const catalog = buildConfigurationCatalog(candidate);

    expect(catalog.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'image-generation' }),
      expect.objectContaining({ id: 'image-editing' }),
    ]));
    expect(catalog.agentClasses[0]?.routingCapabilities).toEqual([
      'image-editing',
      'image-generation',
      'workspace-engineering',
    ]);

    candidate.config.agentClasses.engineering.modelPolicy = {
      mode: 'fixed',
      modelRef: 'engineering',
    };
    expect(buildConfigurationCatalog(candidate).agentClasses[0]?.routingCapabilities)
      .toEqual(['workspace-engineering']);
  });

  it('projects the same profile fingerprint as the Executor manual', () => {
    const candidate = snapshot();
    const agentClass = candidate.config.agentClasses.engineering!;
    const manual = buildExecutorCapabilityManual({
      agentClassRef: 'engineering',
      agentClass,
      models: candidate.config.models,
      providers: candidate.config.providers,
      configurationRevision: candidate.revisionId,
    });

    expect(buildConfigurationCatalog(candidate).agentClasses[0]).toMatchObject({
      profileFingerprint: manual.sourceFingerprint,
      routingCapabilities: manual.routableCapabilities,
    });
  });

  it('removes a user-disabled capability from the machine-readable projection', () => {
    const candidate = structuredClone(snapshot());
    candidate.config.agentClasses.engineering!.executorManual = {
      sourceText: '不要把工作区工程任务交给这个 Executor。',
      assertions: [{
        topic: 'capability-policy',
        text: '禁止承担工作区工程任务。',
        routingCapability: 'workspace-engineering',
        disposition: 'disabled',
      }],
    };

    expect(buildConfigurationCatalog(candidate).agentClasses[0]).toMatchObject({
      routingCapabilities: [],
      capabilityPreferences: [],
    });
  });
});
