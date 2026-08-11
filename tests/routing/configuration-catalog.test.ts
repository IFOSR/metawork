import { describe, expect, it } from 'vitest';
import { AnyFusionConfigurationV2Schema } from '../../src/configuration/schema.js';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';
import {
  buildConfigurationCatalog,
  validateRoutingCapabilityReferences,
} from '../../src/routing/configuration-catalog.js';

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
            'Research current public-web information, preserve traceable sources, and deliver source-backed findings.',
        },
        {
          id: 'workspace-engineering',
          deliveryContract:
            'Understand, modify, and verify code or text files in a controlled workspace and deliver the resulting changes or artifacts.',
        },
      ],
      agentClasses: [
        {
          id: 'engineering',
          routingCapabilities: ['workspace-engineering'],
          primaryUseCases: ['repository implementation'],
          avoidUseCases: ['current public-web research'],
          affordances: ['workspace-command-validation', 'workspace-read-write'],
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
});
