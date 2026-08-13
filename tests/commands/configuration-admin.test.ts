import { describe, expect, it } from 'vitest';
import { runConfigurationAdmin, type ConfigurationMutationResult } from '../../src/commands/configuration-admin.js';
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

function writeDeps() {
  return {
    getActiveSnapshot: async () => snapshot(),
    rollback: async (): Promise<ConfigurationMutationResult> => ({ ok: true, revisionId: 'revision-11' }),
    listRevisions: async () => ['revision-09', 'revision-10'],
    getSnapshot: async () => ({ ...snapshot(), revisionId: 'revision-09', contentHash: 'sha256:old' }),
    activate: async (): Promise<ConfigurationMutationResult> => ({ ok: true, revisionId: 'revision-11' }),
  };
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

  it('lists configuration history with the active revision marked', async () => {
    const lines = await runConfigurationAdmin({ kind: 'config', subcommand: 'history' }, writeDeps());
    expect(lines).toEqual(['revision-09', 'revision-10 (active)']);
  });

  it('rolls back to a target revision', async () => {
    const lines = await runConfigurationAdmin(
      { kind: 'config', subcommand: 'rollback', targetRevisionId: 'revision-09' },
      writeDeps(),
    );
    expect(lines).toEqual(['activated: revision-11']);
  });

  it('reports config diff against a target revision', async () => {
    const lines = await runConfigurationAdmin(
      { kind: 'config', subcommand: 'diff', targetRevisionId: 'revision-09' },
      writeDeps(),
    );
    expect(lines[0]).toBe('different: revision-09 (sha256:old) vs revision-10 (sha256:abc123)');
  });

  it('disables an executor through the write surface', async () => {
    let activatedConfig: unknown;
    const d = writeDeps();
    d.activate = async config => {
      activatedConfig = config;
      return { ok: true, revisionId: 'revision-11' };
    };
    const lines = await runConfigurationAdmin(
      { kind: 'executor', subcommand: 'disable', id: 'codex-cli' },
      d,
    );
    expect(lines).toEqual(['activated: revision-11']);
    expect((activatedConfig as { agentClasses: Record<string, { enabled: boolean }> })
      .agentClasses['codex-cli']!.enabled).toBe(false);
  });
});
