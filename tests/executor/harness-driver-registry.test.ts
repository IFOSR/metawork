import { describe, expect, it, vi } from 'vitest';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';
import type {
  RuntimeConfigurationView,
  RuntimePrivateConfigurationBinding,
} from '../../src/configuration/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { HarnessDriver } from '../../src/executor/harness-driver.js';
import { PiCliDriver } from '../../src/executor/pi-cli-driver.js';
import { CodexCliDriver } from '../../src/executor/codex-cli-driver.js';
import { ExecutionRuntime, ExecutorRegistry } from '../../src/execution/execution-runtime.js';
import {
  HarnessDriverRegistry,
  type HarnessDriverAdapterFactoryInput,
} from '../../src/executor/harness-driver-registry.js';

describe('HarnessDriverRegistry', () => {
  it.each([new PiCliDriver(), new CodexCliDriver()])(
    'resolves evidence tools from the pinned driver $id for custom agents', driver => {
      const drivers = new HarnessDriverRegistry();
      drivers.register(driver, () => executorAdapter('custom'));
      const configuration = runtimeConfiguration(driver.id as 'pi-cli' | 'codex-cli');
      const binding = authorizedBinding('quality-beta', 'model-review');
      const runtime = new ExecutionRuntime(new ExecutorRegistry({
        driverRegistry: drivers,
        getRuntimeConfiguration: revision => revision === configuration.revisionId ? configuration : null,
        getRuntimeBinding: () => runtimeBinding('unused'),
        getActiveRuntimeConfiguration: () => { throw new Error('must use pinned revision'); },
      }));
      expect(runtime.supportsEvidenceTools(binding)).toBe(true);
      expect(runtime.supportsEvidenceTools({ ...binding, configurationRevision: 'missing' })).toBe(false);
      expect(runtime.supportsEvidenceTools({ ...binding, harnessRef: 'other' })).toBe(false);
      configuration.harnesses['shared-harness']!.enabled = false;
      expect(runtime.supportsEvidenceTools(binding)).toBe(false);
      configuration.harnesses['shared-harness']!.enabled = true;
      configuration.agentClasses['quality-beta']!.enabled = false;
      expect(runtime.supportsEvidenceTools(binding)).toBe(false);
    },
  );

  it('does not advertise evidence tools for drivers without that capability', () => {
    const registry = new HarnessDriverRegistry();
    const input = {
      configuration: runtimeConfiguration('pi-cli'),
      authorizedBinding: authorizedBinding('quality-beta', 'model-review'),
    };
    expect(registry.supportsEvidenceTools(input)).toBe(false);
    registry.register(harnessDriver('pi-cli'), () => executorAdapter('custom'));
    expect(registry.supportsEvidenceTools(input)).toBe(false);
  });

  it('registers a Harness driver by driverId and rejects duplicates', () => {
    const registry = new HarnessDriverRegistry();
    const driver = harnessDriver('codex-cli');
    const createAdapter = vi.fn(() => executorAdapter('first'));

    registry.register(driver, createAdapter);

    expect(() => registry.register(harnessDriver('codex-cli'), createAdapter))
      .toThrow('Harness driver is already registered: codex-cli');
  });

  it('rejects a Harness driver whose execution protocols differ from the driver catalog', () => {
    const registry = new HarnessDriverRegistry();

    expect(() => registry.register(
      harnessDriver('codex-cli', []),
      vi.fn(() => executorAdapter('unexpected')),
    )).toThrow('Harness driver execution protocol mismatch: codex-cli');
  });

  it('fails closed when the configured Harness driver is not registered', () => {
    const registry = new HarnessDriverRegistry();

    expect(() => registry.createAdapter({
      configuration: runtimeConfiguration('pi-cli'),
      authorizedBinding: authorizedBinding('implementation-alpha', 'model-engineering'),
      runtimeBinding: runtimeBinding('private-alpha'),
    })).toThrow('Harness driver is not registered: pi-cli');
  });

  it('uses the configured Harness driver to create isolated adapters for distinct bindings', () => {
    const registry = new HarnessDriverRegistry();
    const driver = harnessDriver('codex-cli');
    const received: HarnessDriverAdapterFactoryInput[] = [];
    registry.register(driver, input => {
      received.push(input);
      return executorAdapter(`${input.authorizedBinding.agentClassRef}:${input.runtimeBinding.bindingFingerprint}`);
    });
    const configuration = runtimeConfiguration('codex-cli');
    const engineeringBinding = authorizedBinding('implementation-alpha', 'model-engineering');
    const reviewBinding = authorizedBinding('quality-beta', 'model-review');

    const engineering = registry.createAdapter({
      configuration,
      authorizedBinding: engineeringBinding,
      runtimeBinding: runtimeBinding('private-engineering'),
    });
    const review = registry.createAdapter({
      configuration,
      authorizedBinding: reviewBinding,
      runtimeBinding: runtimeBinding('private-review'),
    });

    expect(engineering).not.toBe(review);
    expect(engineering.name).toBe('implementation-alpha:private-engineering');
    expect(review.name).toBe('quality-beta:private-review');
    expect(received).toHaveLength(2);
    expect(received.map(input => input.driver)).toEqual([driver, driver]);
    expect(received.map(input => input.harness.driverId)).toEqual(['codex-cli', 'codex-cli']);
    expect(received.map(input => input.runtimeBinding.bindingFingerprint))
      .toEqual(['private-engineering', 'private-review']);
  });

  it('rejects bindings that do not match the selected configuration revision', () => {
    const registry = new HarnessDriverRegistry();
    const createAdapter = vi.fn(() => executorAdapter('unexpected'));
    registry.register(harnessDriver('codex-cli'), createAdapter);

    expect(() => registry.createAdapter({
      configuration: runtimeConfiguration('codex-cli'),
      authorizedBinding: {
        ...authorizedBinding('implementation-alpha', 'model-engineering'),
        harnessRef: 'invented-harness',
      },
      runtimeBinding: runtimeBinding('private-alpha'),
    })).toThrow(
      'AgentClass implementation-alpha is bound to Harness shared-harness, not invented-harness',
    );
    expect(createAdapter).not.toHaveBeenCalled();
  });
});

function harnessDriver(
  id: string,
  executionProtocols = id === 'codex-cli' || id === 'pi-cli'
    ? ['workspace-image-artifact-v1'] as const
    : [],
): HarnessDriver {
  return {
    id,
    executionProtocols,
    probe: vi.fn(async () => ({ available: true })),
    materializeHome: vi.fn(async input => ({
      homePath: `${input.attemptsRoot}/${input.attemptId}`,
      environment: {},
    })),
    buildLaunch: vi.fn(input => ({
      command: id,
      args: [input.prompt],
      cwd: input.cwd,
      environment: {},
    })),
    parseResult: vi.fn(() => ({ success: true, output: 'ok' })),
  };
}

function executorAdapter(name: string): ExecutorAdapter {
  return {
    name,
    execute: vi.fn(async () => ({ success: true, output: 'ok' })),
    probe: vi.fn(async () => ({ available: true, failure: null })),
    abort: vi.fn(),
  };
}

function authorizedBinding(
  agentClassRef: 'implementation-alpha' | 'quality-beta',
  modelRef: 'model-engineering' | 'model-review',
): AuthorizedExecutorBinding {
  return {
    agentClassRef,
    harnessRef: 'shared-harness',
    providerRef: 'provider-main',
    modelRef,
    permissionProfileRef: 'workspace-default',
    configurationRevision: 'revision-10',
  };
}

function runtimeBinding(bindingFingerprint: string): RuntimePrivateConfigurationBinding {
  return {
    revisionId: 'revision-10',
    bindingFingerprint,
  };
}

function runtimeConfiguration(
  driverId: 'codex-cli' | 'pi-cli',
): RuntimeConfigurationView {
  return {
    revisionId: 'revision-10',
    contentHash: 'sha256:revision-10',
    schemaVersion: 2,
    providers: {
      'provider-main': {
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKeyRef: 'keychain:anyfusion/provider-main',
        region: 'international',
        enabled: true,
      },
    },
    models: {
      'model-engineering': {
        providerRef: 'provider-main',
        modelId: 'engineering-v1',
        capabilities: ['coding', 'tools'],
        reasoning: 'medium',
        enabled: true,
      },
      'model-review': {
        providerRef: 'provider-main',
        modelId: 'review-v1',
        capabilities: ['coding', 'structured-output'],
        reasoning: 'high',
        enabled: true,
      },
    },
    harnesses: {
      'shared-harness': {
        kind: 'executor',
        transport: 'local-cli',
        command: driverId === 'codex-cli' ? 'codex' : 'pi',
        args: [],
        driverId,
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
    },
    agentClasses: {
      'implementation-alpha': agentClass('model-engineering'),
      'quality-beta': agentClass('model-review'),
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
  };
}

function agentClass(modelRef: 'model-engineering' | 'model-review') {
  return {
    kind: 'executor' as const,
    harnessRef: 'shared-harness',
    modelPolicy: { mode: 'fixed' as const, modelRef },
    permissionProfileRef: 'workspace-default',
    routingCapabilities: ['workspace-engineering' as const],
    primaryUseCases: [],
    avoidUseCases: [],
    plannerAffordances: ['workspace-read-write' as const],
    skills: [],
    mcpServers: [],
    plugins: [],
    generatedRuntimeRef: 'generated-runtime',
    enabled: true,
  };
}
