import { describe, expect, it } from 'vitest';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';
import { resolvePublicRoutingIdentity } from '../../src/configuration/public-routing-identity.js';
import {
  buildExecutorDisplayFacts,
  executionEventDetails,
} from '../../src/execution/execution-transparency.js';

describe('execution transparency projection', () => {
  it('resolves the configured modelId instead of exposing the internal modelRef', () => {
    const identity = resolvePublicRoutingIdentity(snapshot('revision-a', 'gpt-5.6-terra'), {
      agentClassRef: 'codex-cli',
      harnessRef: 'codex-cli',
      providerRef: 'code-cli',
      modelRef: 'code-cli-5',
      configurationRevision: 'revision-a',
    });

    expect(identity).toEqual({
      executorDisplayName: 'Codex CLI',
      harnessDisplayName: 'Codex CLI',
      providerDisplayName: 'Code CLI',
      modelDisplayName: 'gpt-5.6-terra',
      availability: 'available',
    });
    expect(JSON.stringify(identity)).not.toContain('code-cli-5');
  });

  it('uses the binding revision instead of an active revision with the same modelRef', () => {
    const oldIdentity = resolvePublicRoutingIdentity(snapshot('revision-old', 'gpt-5.6-terra'), {
      agentClassRef: 'codex-cli',
      harnessRef: 'codex-cli',
      providerRef: 'code-cli',
      modelRef: 'code-cli-5',
      configurationRevision: 'revision-old',
    });
    const newIdentity = resolvePublicRoutingIdentity(snapshot('revision-new', 'gpt-5.7-sol'), {
      agentClassRef: 'codex-cli',
      harnessRef: 'codex-cli',
      providerRef: 'code-cli',
      modelRef: 'code-cli-5',
      configurationRevision: 'revision-new',
    });

    expect(oldIdentity.modelDisplayName).toBe('gpt-5.6-terra');
    expect(newIdentity.modelDisplayName).toBe('gpt-5.7-sol');
  });

  it('builds executor display facts from resolved public identity', () => {
    const facts = buildExecutorDisplayFacts({
      identity: {
        executorDisplayName: 'Pi Agent',
        harnessDisplayName: 'Pi CLI',
        providerDisplayName: 'Kimi',
        modelDisplayName: 'k3',
        availability: 'available',
      },
      subtaskId: 'subtask_1',
      subtaskTitle: '调研章节',
    });

    expect(facts).toEqual({
      subtaskId: 'subtask_1',
      subtaskTitle: '调研章节',
      executorDisplayName: 'Pi Agent',
      harnessDisplayName: 'Pi CLI',
      providerDisplayName: 'Kimi',
      modelDisplayName: 'k3',
    });
  });

  it('normalizes milestone details without fabricating progress', () => {
    const display = buildExecutorDisplayFacts({
      identity: {
        executorDisplayName: 'Codex CLI',
        harnessDisplayName: 'Codex CLI',
        providerDisplayName: 'Code CLI',
        modelDisplayName: 'gpt-5.6-sol',
        availability: 'available',
      },
      subtaskId: 'subtask_9',
      subtaskTitle: '实现模块',
    });
    const details = executionEventDetails({
      display,
      step: { stepKey: 'executor_started', stepLabel: '已启动 Codex Cli' },
      startedAt: '2026-08-24T01:00:00.000Z',
      updatedAt: '2026-08-24T01:00:05.000Z',
    });

    expect(details).toMatchObject({
      subtaskId: 'subtask_9',
      subtaskTitle: '实现模块',
      executorDisplayName: 'Codex CLI',
      harnessDisplayName: 'Codex CLI',
      providerDisplayName: 'Code CLI',
      modelDisplayName: 'gpt-5.6-sol',
      stepKey: 'executor_started',
      stepLabel: '已启动 Codex Cli',
      progress: null,
      startedAt: '2026-08-24T01:00:00.000Z',
      updatedAt: '2026-08-24T01:00:05.000Z',
    });
    // 不携带内部执行标识：binding fingerprint、revision、命令与日志不进入投影。
    expect(JSON.stringify(details)).not.toContain('configurationRevision');
    expect(JSON.stringify(details)).not.toContain('fingerprint');
  });
});

function snapshot(revisionId: string, modelId: string): ConfigurationSnapshot {
  return {
    revisionId,
    contentHash: `sha256:${revisionId}`,
    config: {
      schemaVersion: 2,
      providers: {
        'code-cli': {
          protocol: 'openai-compatible',
          baseUrl: 'https://www.code-cli.cn/v1',
          apiKeyRef: 'file-secret:anyfusion/code-cli',
          region: 'international',
          enabled: true,
        },
      },
      models: {
        'code-cli-5': {
          providerRef: 'code-cli',
          modelId,
          capabilities: [],
          reasoning: 'high',
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
        'codex-cli': {
          kind: 'executor',
          harnessRef: 'codex-cli',
          modelPolicy: { mode: 'fixed', modelRef: 'code-cli-5' },
          permissionProfileRef: 'workspace-engineering',
          routingCapabilities: ['workspace-engineering'],
          primaryUseCases: [],
          avoidUseCases: [],
          plannerAffordances: ['workspace-read-write'],
          skills: [],
          mcpServers: [],
          plugins: [],
          generatedRuntimeRef: 'codex-cli',
          enabled: true,
        },
      },
      permissionProfiles: {
        'workspace-engineering': {
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
