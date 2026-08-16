import { describe, expect, it, vi } from 'vitest';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';
import { probeLocalExecutorHarnesses } from '../../src/executor/configuration-probe.js';

describe('local executor configuration probe', () => {
  it('reports an unavailable driver used by an enabled executor AgentClass', async () => {
    const codexProbe = vi.fn(async () => ({
      available: false,
      detail: 'codex not found',
    }));
    const unusedPiProbe = vi.fn(async () => ({
      available: true,
      detail: 'pi 1.0',
    }));

    await expect(probeLocalExecutorHarnesses(
      configurationSnapshot(),
      new Map([
        ['codex-cli', { probe: codexProbe }],
        ['pi-cli', { probe: unusedPiProbe }],
      ]),
    )).resolves.toEqual({
      ok: false,
      issues: ['Harness codex (codex-cli) unavailable: codex not found'],
    });
    expect(codexProbe).toHaveBeenCalledOnce();
    expect(unusedPiProbe).not.toHaveBeenCalled();
  });
});

function configurationSnapshot(): ConfigurationSnapshot {
  return {
    revisionId: 'revision-next',
    contentHash: 'sha256:test',
    config: {
      schemaVersion: 2,
      providers: {},
      models: {},
      harnesses: {
        codex: {
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
        pi: {
          kind: 'executor',
          transport: 'local-cli',
          command: 'pi',
          args: [],
          driverId: 'pi-cli',
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
          modelPolicy: { mode: 'fixed', modelRef: 'unused' },
          permissionProfileRef: 'workspace-default',
          routingCapabilities: [],
          primaryUseCases: [],
          avoidUseCases: [],
          plannerAffordances: [],
          skills: [],
          mcpServers: [],
          plugins: [],
          generatedRuntimeRef: 'engineering',
          enabled: true,
        },
      },
      permissionProfiles: {},
      runtimePolicy: {},
      gateway: {},
    },
  };
}
