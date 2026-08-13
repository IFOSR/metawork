import { describe, expect, it } from 'vitest';
import { runConfigurationAdmin } from '../../src/commands/configuration-admin.js';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';

function snapshot(): ConfigurationSnapshot {
  return {
    revisionId: 'revision-10',
    contentHash: 'sha256:abc123',
    config: {
      schemaVersion: 2,
      providers: {
        'provider-main': {
          protocol: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          apiKeyRef: 'keychain:anyfusion/provider-main',
          region: 'global',
          enabled: true,
        },
      },
      models: {
        'engineering-v1': {
          providerRef: 'provider-main',
          modelId: 'engineering-v1',
          capabilities: ['coding'],
          reasoning: 'medium',
          enabled: true,
        },
      },
      harnesses: {
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
        planner: {
          kind: 'planner',
          harnessRef: 'anyfusion-planner',
          modelPolicy: { mode: 'fixed', modelRef: 'engineering-v1' },
          routingCapabilities: [],
          primaryUseCases: [],
          avoidUseCases: [],
          plannerAffordances: [],
          skills: [],
          mcpServers: [],
          plugins: [],
          generatedRuntimeRef: 'planner',
          enabled: true,
        },
        'codex-cli': {
          kind: 'executor',
          harnessRef: 'codex-cli',
          modelPolicy: { mode: 'fixed', modelRef: 'engineering-v1' },
          permissionProfileRef: 'workspace-engineering',
          routingCapabilities: ['workspace-engineering'],
          primaryUseCases: [],
          avoidUseCases: [],
          plannerAffordances: [],
          skills: [],
          mcpServers: [],
          plugins: [],
          generatedRuntimeRef: 'codex-cli',
          enabled: true,
        },
      },
      permissionProfiles: {},
      runtimePolicy: {},
      gateway: {},
    },
  };
}

function deps() {
  return { getActiveSnapshot: async () => snapshot() };
}

describe('runConfigurationAdmin', () => {
  it('formats status from the active snapshot', async () => {
    const lines = await runConfigurationAdmin({ kind: 'status' }, deps());
    expect(lines[0]).toBe('revision: revision-10');
    expect(lines).toContain('providers: 1');
    expect(lines).toContain('agentClasses: 2');
  });

  it('shows config from the active snapshot', async () => {
    const lines = await runConfigurationAdmin({ kind: 'config', subcommand: 'show' }, deps());
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ schemaVersion: 2 });
  });

  it('lists providers and models', async () => {
    expect(await runConfigurationAdmin({ kind: 'provider', subcommand: 'list' }, deps()))
      .toEqual(['provider-main']);
    expect(await runConfigurationAdmin({ kind: 'model', subcommand: 'list' }, deps()))
      .toEqual(['engineering-v1']);
  });

  it('lists enabled executor AgentClasses', async () => {
    const lines = await runConfigurationAdmin({ kind: 'executor', subcommand: 'list' }, deps());
    expect(lines).toEqual(['codex-cli (enabled)']);
  });

  it('shows the planner AgentClass binding', async () => {
    const lines = await runConfigurationAdmin({ kind: 'planner', subcommand: 'show' }, deps());
    expect(lines).toEqual(['planner: anyfusion-planner (enabled)']);
  });

  it('reports invalid configuration issues', async () => {
    const lines = await runConfigurationAdmin({ kind: 'config', subcommand: 'validate' }, deps());
    expect(lines[0]).toBe('configuration is invalid:');
    expect(lines.some(line => line.includes('unknown Harness reference'))).toBe(true);
  });
});
