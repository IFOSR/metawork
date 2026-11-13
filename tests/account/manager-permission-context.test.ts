import { describe, expect, it, vi } from 'vitest';
import { createManagerPermissionContextResolver, type ManagerPermissionFacts } from '../../src/account/manager-permission-context.js';
import { capabilityRequestFingerprint } from '../../src/resource/permission-policy.js';
import type { NormalizedCapabilityRequest } from '../../src/resource/types.js';
import type { PlannerConfigurationView } from '../../src/configuration/types.js';

const request: NormalizedCapabilityRequest = {
  id: 'permission', fingerprint: '', taskId: 'task', subtaskId: 'subtask', generationId: 'generation',
  attemptId: 'attempt', agentClassName: 'pi', permissionProfileId: 'standard-agent',
  capability: 'logical_resource_operation', operation: 'inspect', resource: 'resource',
  partition: { kind: 'logical', namespace: 'test', key: 'resource' }, reason: 'inspect the requested resource',
  suggestedScope: 'attempt', distinctRequestOrdinal: 1,
};
request.fingerprint = capabilityRequestFingerprint(request);
const configuration = { revisionId: 'config' } as PlannerConfigurationView;
function setup() {
  const facts: ManagerPermissionFacts = {
    task: { id: 'task', accountId: 'account', conversationId: 'conversation', workspaceId: 'workspace', goal: 'task goal', status: 'running' },
    subtask: { id: 'subtask', taskId: 'task', generationId: 'generation', graphRevision: 1, goal: 'subtask goal', status: 'running' },
    graph: { generationId: 'generation', revision: 1, configurationRevision: 'config' },
    attempt: { taskId: 'task', subtaskId: 'subtask', generationId: 'generation', configurationRevision: 'config',
      status: 'running', agentClassRef: 'pi', permissionProfileId: 'standard-agent' },
  };
  const deps = {
    accountId: 'account', readFacts: vi.fn(() => facts),
    readUserIntent: vi.fn(() => ({ queryId: 'query', text: 'Inspect it but do not send anything externally.' })),
    readConfiguration: vi.fn(async () => configuration), onUsage: vi.fn(),
  };
  return { facts, deps, resolve: createManagerPermissionContextResolver(deps) };
}

describe('Manager permission context', () => {
  it('uses the durable owner, exact pinned revision and original restrictions and reports each call', async () => {
    const { deps, resolve } = setup();
    const context = await resolve(request);
    expect(context.request).toEqual({ sessionId: 'conversation', conversationId: 'conversation', source: 'manager-permission' });
    expect(deps.readUserIntent).toHaveBeenCalledWith('task', 'conversation');
    expect(deps.readConfiguration).toHaveBeenCalledWith('config');
    expect(context.userInput).toContain('do not send anything externally');
    expect(context.userInput).toContain('subtask goal');
    const usage = { sourceEventKey: 'event', callId: 'call', counters: [] };
    context.onUsage!(usage);
    expect(deps.onUsage).toHaveBeenCalledWith({ queryId: 'query', taskId: 'task', requestId: 'permission', configurationRevision: 'config', usage });
  });

  it.each(['account', 'generation', 'attempt', 'profile', 'cancelled', 'subtask'] as const)('rejects stale or foreign %s before loading a model', async field => {
    const { facts, deps, resolve } = setup();
    if (field === 'account') facts.task.accountId = 'foreign';
    if (field === 'generation') facts.graph.generationId = 'new-generation';
    if (field === 'attempt') facts.attempt.subtaskId = 'foreign';
    if (field === 'profile') facts.attempt.permissionProfileId = 'foreign';
    if (field === 'cancelled') facts.task.status = 'cancelled';
    if (field === 'subtask') facts.subtask.status = 'done';
    await expect(resolve(request)).rejects.toThrow('context_stale');
    expect(deps.readConfiguration).not.toHaveBeenCalled();
  });

  it('rechecks cancellation after asynchronously resolving the configuration', async () => {
    const { facts, deps, resolve } = setup();
    deps.readConfiguration.mockImplementation(async () => {
      facts.task.status = 'cancelled';
      return configuration;
    });
    await expect(resolve(request)).rejects.toThrow('context_stale');
  });

  it('does not truncate away restrictions or substitute a task goal for missing original intent', async () => {
    const { deps, resolve } = setup();
    deps.readUserIntent.mockReturnValue({ queryId: 'query', text: '' });
    await expect(resolve(request)).rejects.toThrow('user_intent_unavailable');
    deps.readUserIntent.mockReturnValue({ queryId: 'query', text: 'x'.repeat(40_000) });
    await expect(resolve(request)).rejects.toThrow('context_too_large');
  });

  it('rejects a forged fingerprint', async () => {
    const { resolve } = setup();
    await expect(resolve({ ...request, operation: 'mutate' })).rejects.toThrow('context_stale');
  });
});
