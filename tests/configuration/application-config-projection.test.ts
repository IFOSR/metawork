import { describe, expect, it } from 'vitest';
import {
  buildApplicationConfig,
} from '../../src/configuration/application-config-projection.js';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';

describe('application configuration projection', () => {
  it('derives Session and Gateway settings from the active schema-v2 snapshot', () => {
    const config = buildApplicationConfig(snapshot());

    expect(config.executor.command).toBe('codex');
    expect(config.orchestration.max_concurrent_attempts).toBe(2);
    expect(config.gateway?.enabled).toBe(true);
    expect(config.notifications?.feishu?.enabled).toBe(false);
    expect(config.integrations?.markdown_preview).toMatchObject({
      enabled: true,
      host: '127.0.0.1',
      port: 8790,
    });
  });

  it('projects the Feishu platform definition from the snapshot', () => {
    const base = snapshot();
    const config = buildApplicationConfig({
      ...base,
      config: {
        ...base.config,
        gateway: {
          enabled: true,
          platforms: {
            feishu: {
              enabled: true,
              domain: 'feishu',
              connection_mode: 'websocket',
              app_id: 'cli_projection',
              app_secret_env: 'FEISHU_APP_SECRET',
              access: {
                dm_policy: 'pairing',
                allowed_users: [],
                group_policy: 'open',
                require_mention: true,
              },
            },
          },
        },
      },
    });

    expect(config.gateway?.platforms?.feishu).toMatchObject({
      enabled: true,
      app_id: 'cli_projection',
      connection_mode: 'websocket',
    });
    expect(config.gateway?.platforms?.feishu?.access?.dm_policy).toBe('pairing');
  });

  it('keeps the Feishu platform disabled when the snapshot has no platform section', () => {
    const config = buildApplicationConfig(snapshot());
    expect(config.gateway?.platforms?.feishu?.enabled).toBe(false);
  });
});

function snapshot(): ConfigurationSnapshot {
  return {
    revisionId: 'revision-application',
    contentHash: 'sha256:application',
    config: {
      schemaVersion: 2,
      providers: {},
      models: {},
      harnesses: {
        'codex-cli': {
          kind: 'executor',
          transport: 'local-cli',
          command: 'codex',
          args: [],
          driverId: 'codex-cli',
          supportsProbe: true,
          supportsAbort: true,
          supportsContinuation: false,
          enabled: true,
        },
      },
      agentClasses: {
        'codex-engineering': {
          kind: 'executor',
          harnessRef: 'codex-cli',
          modelPolicy: { mode: 'fixed', modelRef: 'disabled-model' },
          permissionProfileRef: 'workspace-engineering',
          routingCapabilities: ['workspace-engineering'],
          primaryUseCases: [],
          avoidUseCases: [],
          plannerAffordances: [],
          skills: [],
          mcpServers: [],
          plugins: [],
          generatedRuntimeRef: 'codex-engineering',
          enabled: false,
        },
      },
      permissionProfiles: {
        'workspace-engineering': {
          profileId: 'workspace-engineering',
          version: 1,
          parameters: {},
        },
      },
      runtimePolicy: { maxConcurrentAttempts: 2 },
      gateway: { enabled: true },
    },
  };
}
