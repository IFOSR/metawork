import { describe, expect, it } from 'vitest';
import { WorkspaceGatewayRuntime } from '../../src/gateway/workspace-gateway-runtime.js';

function directory() {
  const calls: string[] = [];
  return {
    calls,
    value: {
      selectByPath: async (path: string) => {
        calls.push(`select:${path}`);
        return { created: false, workspace: { id: 'workspace_repo' } };
      },
      listConversations: async (workspaceId: string) => {
        calls.push(`list:${workspaceId}`);
        return { items: [], nextCursor: null };
      },
      createConversation: async (workspaceId: string) => {
        calls.push(`create:${workspaceId}`);
        return { id: 'conv_new' };
      },
      archiveConversation: async (conversationId: string, workspaceId: string) => {
        calls.push(`archive:${workspaceId}:${conversationId}`);
      },
    },
  };
}

describe('WorkspaceGatewayRuntime', () => {
  it('requires selection before directory commands', async () => {
    const fixture = directory();
    const runtime = new WorkspaceGatewayRuntime(fixture.value as never);
    await expect(runtime.handle({
      kind: 'create_conversation',
      workspaceId: 'workspace_repo',
    }, {
      principalId: 'local:local-installation',
      connectionId: 'conn_1',
    })).resolves.toMatchObject({
      status: 'rejected',
      reason: 'workspace_required',
    });
  });

  it('shares one selected Workspace across commands on the same connection', async () => {
    const fixture = directory();
    const runtime = new WorkspaceGatewayRuntime(fixture.value as never);
    const context = {
      principalId: 'local:local-installation',
      connectionId: 'conn_1',
    };
    await runtime.handle({ kind: 'select_workspace', path: '/repo' }, context);
    const created = await runtime.handle({
      kind: 'create_conversation',
      workspaceId: 'workspace_repo',
    }, context);
    expect(runtime.activeWorkspaceId('conn_1')).toBe('workspace_repo');
    expect(created).toEqual({
      status: 'accepted',
      workspaceId: 'workspace_repo',
      conversationId: 'conv_new',
    });
    expect(fixture.calls).toEqual([
      'select:/repo',
      'list:workspace_repo',
      'create:workspace_repo',
      'list:workspace_repo',
    ]);
  });

  it('does not leak selection between connections', async () => {
    const fixture = directory();
    const runtime = new WorkspaceGatewayRuntime(fixture.value as never);
    await runtime.handle({ kind: 'select_workspace', path: '/repo' }, {
      principalId: 'local:local-installation',
      connectionId: 'conn_a',
    });
    await expect(runtime.handle({
      kind: 'list_workspace_conversations',
      workspaceId: 'workspace_repo',
    }, {
      principalId: 'local:local-installation',
      connectionId: 'conn_b',
    })).resolves.toMatchObject({ status: 'rejected', reason: 'workspace_required' });
  });
});
