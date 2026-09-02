import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';
import { createProductionConfigurationProbe } from '../../src/configuration/production-configuration-probe.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('production configuration probe', () => {
  it('checks referenced secrets, the Planner artifact, and enabled Executor commands', async () => {
    const releaseRoot = await fixtureRelease();
    const get = vi.fn(async () => 'secret');
    const detectCommand = vi.fn(async command => command === 'codex');
    const probe = createProductionConfigurationProbe({
      releaseRoot,
      secretStore: { get, put: vi.fn(), delete: vi.fn() },
      detectCommand,
    });

    await expect(probe(snapshot(true, false), { contentHash: 'hash', files: {} }))
      .resolves.toEqual({ ok: true });
    expect(get).toHaveBeenCalledWith('file-secret:anyfusion/provider');
    expect(detectCommand).toHaveBeenCalledWith('codex');
    expect(detectCommand).not.toHaveBeenCalledWith('pi');
  });

  it('accepts the vendored Planner layout used by a source checkout', async () => {
    const releaseRoot = await fixtureRelease(false);
    const planner = join(
      releaseRoot,
      'planner',
      'AnyFusion-Pi',
      'packages',
      'coding-agent',
      'dist',
    );
    await mkdir(planner, { recursive: true });
    await writeFile(join(planner, 'cli.js'), 'planner\n');
    const probe = createProductionConfigurationProbe({
      releaseRoot,
      secretStore: {
        get: async () => 'secret',
        put: vi.fn(),
        delete: vi.fn(),
      },
      detectCommand: async () => true,
    });

    await expect(probe(snapshot(true, false), { contentHash: 'hash', files: {} }))
      .resolves.toEqual({ ok: true });
  });

  it('does not treat the vendored Planner artifact as a Pi Executor fallback', async () => {
    const releaseRoot = await fixtureRelease();
    const probe = createProductionConfigurationProbe({
      releaseRoot,
      secretStore: {
        get: async () => 'secret',
        put: vi.fn(),
        delete: vi.fn(),
      },
      detectCommand: async command => command !== 'pi',
    });

    const result = await probe(snapshot(true, true), { contentHash: 'hash', files: {} });

    expect(result.ok).toBe(false);
    expect(result.issues).toContain('Executor command is unavailable: pi');
  });

  it('returns every blocking issue instead of silently activating', async () => {
    const releaseRoot = await fixtureRelease(false);
    const probe = createProductionConfigurationProbe({
      releaseRoot,
      secretStore: {
        get: vi.fn(async () => { throw new Error('missing'); }),
        put: vi.fn(),
        delete: vi.fn(),
      },
      detectCommand: async () => false,
    });

    const result = await probe(snapshot(true, true), { contentHash: 'hash', files: {} });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      'Provider provider secret is unavailable',
      'Planner artifact is missing',
      'Executor command is unavailable: codex',
      'Executor command is unavailable: pi',
    ]));
  });
});

async function fixtureRelease(withPlanner = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'anyfusion-production-probe-'));
  roots.push(root);
  if (withPlanner) {
    const planner = join(root, 'planner', 'packages', 'coding-agent', 'dist');
    await mkdir(planner, { recursive: true });
    await writeFile(join(planner, 'cli.js'), 'planner\n');
  }
  return root;
}

function snapshot(codexEnabled: boolean, piEnabled: boolean): ConfigurationSnapshot {
  return {
    revisionId: 'revision-1',
    contentHash: 'hash',
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
          capabilities: ['coding'],
          reasoning: 'medium',
          enabled: true,
        },
      },
      harnesses: {
        planner: {
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
        codex: {
          kind: 'executor',
          transport: 'local-cli',
          command: 'codex',
          args: [],
          driverId: 'codex-cli',
          supportsProbe: true,
          supportsAbort: true,
          supportsContinuation: true,
          enabled: codexEnabled,
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
          enabled: piEnabled,
        },
      },
      agentClasses: {},
      permissionProfiles: {},
      runtimePolicy: {},
      gateway: {},
    },
  };
}
