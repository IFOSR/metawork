import { parseAnyFusionConfigurationV2 } from '../../src/configuration/schema.js';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';

export function spanSnapshot(revisionId = 'revision-test'): ConfigurationSnapshot {
  return { revisionId, contentHash: `hash-${revisionId}`, config: parseAnyFusionConfigurationV2({
    schemaVersion: 2,
    providers: { p: { protocol: 'openai-compatible', baseUrl: 'https://example.com/v1',
      apiKeyRef: 'file-secret:anyfusion/providers/p', region: 'international', enabled: true } },
    models: Object.fromEntries(['fast', 'deep'].map(id => [id, { providerRef: 'p', modelId: `gpt-${id}`,
      capabilities: ['coding', 'tools'], reasoning: 'low', enabled: true }])),
    harnesses: {
      planner: { kind: 'planner', transport: 'local-process', commandRef: 'release:planner', args: [],
        driverId: 'anyfusion-planner-host-v2', supportsProbe: true, supportsAbort: true, supportsContinuation: true, enabled: true },
      codex: { kind: 'executor', transport: 'local-cli', command: 'codex', args: [], driverId: 'codex-cli',
        supportsProbe: true, supportsAbort: true, supportsContinuation: true, enabled: true },
    },
    agentClasses: {
      planner: { kind: 'planner', harnessRef: 'planner', modelPolicy: { mode: 'fixed', modelRef: 'fast' },
        routingCapabilities: [], primaryUseCases: [], avoidUseCases: [], plannerAffordances: [],
        skills: [], mcpServers: [], plugins: [], generatedRuntimeRef: 'planner', enabled: true },
      'codex-cli': { kind: 'executor', harnessRef: 'codex', modelPolicy: { mode: 'auto', allowedModelRefs: ['fast', 'deep'], defaultModelRef: 'fast' },
        permissionProfileRef: 'workspace', routingCapabilities: ['workspace-engineering'],
        primaryUseCases: [], avoidUseCases: [], plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
        skills: [], mcpServers: [], plugins: [], generatedRuntimeRef: 'codex', enabled: true },
    },
    permissionProfiles: { workspace: { profileId: 'workspace-engineering', version: 1, parameters: {} } },
    runtimePolicy: { maxConcurrentTasks: 2, maxConcurrentAttempts: 4, maxConcurrentAttemptsPerTask: 2,
      schedulingAgingMs: 300_000, sameConversationQueueLimit: 8 }, gateway: {},
    routing: { span: { enabled: true, model: 'inception/mercury-decide:free', timeoutMs: 3000,
      apiKeyRef: 'file-secret:anyfusion/internal/routing-span' } },
  }) };
}
