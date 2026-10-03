import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { GatewayAttachmentStore } from '../../src/gateway/attachment-store-port.js';
import type { GatewayEventEnvelope, GatewayReplay } from '../../src/gateway/client-events.js';
import type { WebGatewayAdapter } from '../../src/management/web-gateway-adapter.js';
import { FileAttachmentStore } from '../../src/storage/file-attachment-store.js';
import { WebGatewaySessionRuntime } from '../../src/management/web-gateway-session-runtime.js';
import type {
  WebSessionRuntimeCatalog,
  WebSessionRuntimeEvent,
} from '../../src/management/web-session-runtime-types.js';
import type { WebSessionRecord } from '../../src/management/web-session-types.js';
import type { ExecutionTimeline } from '../../src/management/execution-projector.js';

describe('WebGatewaySessionRuntime', () => {
  it('switches via metadata only with no execution attach, audit replay or content hydration', async () => {
    const forbidden = vi.fn(() => { throw new Error('navigation_hydrated_execution'); });
    const readMetadata = vi.fn(async (id: string) => ({ ...sessionRecord(id, false).session, workspaceId: 'workspace_repo' }));
    const runtime = new WebGatewaySessionRuntime({ accountId: 'local-default',
      catalog: { ...catalogFixture(), read: forbidden, readPage: forbidden, readMetadata },
      gateway: gatewayFixture({ attachClient: forbidden, replay: forbidden }),
    });
    try {
      await runtime.activateSession('browser-a', 'conv_1');
      await runtime.activateSession('browser-a', 'conv_2');
      await runtime.activateSession('browser-a', 'conv_1');
      expect(forbidden).not.toHaveBeenCalled();
      expect(readMetadata.mock.calls.map(([id]) => id)).toEqual(['conv_1', 'conv_2', 'conv_1']);
    } finally { await runtime.dispose(); }
  });

  it('uses one scoped billing snapshot for the visible history page', async () => {
    const store = createRuntimeBillingService();
    const turns = Array.from({ length: 10 }, (_, n) => ({
      ...persistedTurnFixture({ id: `turn_${n}` }), taskId: `task_${n}`,
    }));
    const scoped = {
      ...store.billing,
      getQueryBillForTurn: vi.fn(() => null),
      getTurnBillUserView: vi.fn(() => null),
      getTaskUsageSummaryForAccount: vi.fn(() => null),
    } as unknown as BillQueryService;
    const forHistoryPage = vi.fn(() => scoped);
    const single = vi.fn(() => { throw new Error('unbatched_billing_read'); });
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default', catalog: billingCatalogFixture(turns), gateway: gatewayFixture(),
      billing: {
        ...store.billing, forHistoryPage,
        getQueryBillForTurn: single, getTurnBillUserView: single, getTaskUsageSummaryForAccount: single,
      },
    });
    try {
      await runtime.activateSession('browser-a', 'conv_1');
      const record = await runtime.readSession('browser-a', 'conv_1');
      expect(record?.turns).toHaveLength(10);
      expect(forHistoryPage).toHaveBeenCalledTimes(1);
      expect(forHistoryPage).toHaveBeenCalledWith(
        'local-default', turns.map(turn => turn.id), turns.map(turn => turn.taskId),
      );
      expect(scoped.getQueryBillForTurn).toHaveBeenCalledTimes(10);
      expect(single).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
      store.close();
    }
  });

  it('enriches a visible history page through one set query per fact family', async () => {
    const turns = Array.from({ length: 10 }, (_, n) => ({
      ...persistedTurnFixture({ id: `turn_${n}` }), taskId: null,
    }));
    const resolveTaskIdsForTurns = vi.fn((ids: readonly string[]) => new Map(ids.map((id, n) => [id, `task_${n}`])));
    const projectExecutionTimelines = vi.fn(() => new Map());
    const projectTasksArtifacts = vi.fn(() => new Map());
    const single = vi.fn(() => { throw new Error('per_turn_read'); });
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default', catalog: billingCatalogFixture(turns), gateway: gatewayFixture(),
      resolveTaskIdsForTurns, projectExecutionTimelines, projectTasksArtifacts,
      resolveTaskIdForTurn: single, projectExecutionTimeline: single, projectTaskArtifacts: single,
    });
    try {
      await runtime.activateSession('browser-a', 'conv_1');
      const record = await runtime.readSession('browser-a', 'conv_1');
      expect(record?.turns.map(turn => turn.taskId)).toEqual(turns.map((_, n) => `task_${n}`));
      expect(resolveTaskIdsForTurns).toHaveBeenCalledTimes(1);
      expect(projectExecutionTimelines).toHaveBeenCalledTimes(1);
      expect(projectTasksArtifacts).toHaveBeenCalledTimes(1);
      expect(single).not.toHaveBeenCalled();
    } finally { await runtime.dispose(); }
  });

  it('reads one bounded history page across activation and the first visible GET', async () => {
    const catalog = catalogFixture();
    const read = vi.spyOn(catalog, 'read');
    const readPage = vi.fn(async (id: string) => sessionRecord(id, true));
    const readMetadata = vi.fn(async (id: string) => ({
      ...sessionRecord(id, false).session, workspaceId: 'workspace_repo',
    }));
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default', catalog: { ...catalog, readPage, readMetadata, readVersion: async () => 'v1' }, gateway: gatewayFixture(),
    });
    try {
      await runtime.activateSession('browser-a', 'conv_1');
      expect(await runtime.readSession('browser-a', 'conv_1')).not.toBeNull();
      expect(readMetadata).toHaveBeenCalledTimes(1);
      expect(readPage).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
      await runtime.readSession('browser-a', 'conv_1');
      expect(readPage).toHaveBeenCalledTimes(2); // Handoff is consumed, not an unversioned cache.
    } finally { await runtime.dispose(); }
  });

  it('reads an inactive Conversation history page without attaching it', async () => {
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: {
        ...catalogFixture(),
        readPage: async (id: string) => sessionRecord(id, id === 'conv_1'),
      },
      gateway: gatewayFixture(),
    });
    try {
      await runtime.selectWorkspace('browser-a', '/repo');
      await runtime.activateSession('browser-a', 'conv_1');
      expect(await runtime.readSession('browser-a', 'conv_2')).toBeNull();
      expect(await runtime.readBrowsableSession('browser-a', 'conv_2')).toMatchObject({
        session: { id: 'conv_2', active: false },
      });
    } finally { await runtime.dispose(); }
  });

  it('reads current indexed history after metadata-only navigation', async () => {
    let version = 'v1';
    const readPage = vi.fn(async (id: string) => ({
      ...sessionRecord(id, true), session: { ...sessionRecord(id, true).session, title: version },
    }));
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: {
        ...catalogFixture(), readPage, readVersion: async () => version,
        readMetadata: async id => ({ ...sessionRecord(id, true).session, workspaceId: 'workspace_repo' }),
      },
      gateway: gatewayFixture(),
    });
    try {
      await runtime.activateSession('browser-a', 'conv_1');
      version = 'v2';
      expect((await runtime.readSession('browser-a', 'conv_1'))?.session.title).toBe('v2');
      expect(readPage).toHaveBeenCalledTimes(1);
    } finally { await runtime.dispose(); }
  });

  it('consumes the empty create handoff in the creation response', async () => {
    const readPage = vi.fn(async (id: string) => ({
      ...sessionRecord(id, true), session: { ...sessionRecord(id, true).session, title: 'External completion' },
    }));
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default', gateway: gatewayFixture(),
      catalog: {
        ...catalogFixture(), readPage, readVersion: async () => 'v1',
        readMetadata: async id => ({ ...sessionRecord(id, true).session, workspaceId: 'workspace_repo' }),
      },
    });
    try {
      await runtime.selectWorkspace('browser-a', '/repo');
      const created = await runtime.createSession('browser-a');
      expect((await runtime.readSession('browser-a', created.session.session.id))?.session.title)
        .toBe('External completion');
      expect(readPage).toHaveBeenCalledTimes(1);
    } finally { await runtime.dispose(); }
  });

  it('publishes a row removal instead of replacing a paged directory on archive', async () => {
    const catalog = catalogFixture();
    const list = vi.spyOn(catalog, 'list');
    const events: WebSessionRuntimeEvent[] = [];
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default', catalog, gateway: gatewayFixture(),
    });
    runtime.subscribe('browser-a', event => events.push(event));
    try {
      await runtime.selectWorkspace('browser-a', '/repo');
      await runtime.activateSession('browser-a', 'conv_1');
      list.mockClear();
      events.length = 0;
      expect(await runtime.deleteSession('browser-a', 'conv_2')).toBe('deleted');
      expect(list).not.toHaveBeenCalled();
      expect(events).toContainEqual({
        type: 'workspace_conversation_changed', workspaceId: 'workspace_repo', conversationId: 'conv_2', removed: true,
      });
    } finally { await runtime.dispose(); }
  });

  it('does not refresh the full directory when activating an existing Conversation', async () => {
    const catalog = catalogFixture();
    const list = vi.spyOn(catalog, 'list');
    const events: WebSessionRuntimeEvent[] = [];
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default', catalog, gateway: gatewayFixture(),
    });
    runtime.subscribe('browser-a', event => events.push(event));
    try {
      await runtime.selectWorkspace('browser-a', '/repo');
      list.mockClear();
      events.length = 0;
      await runtime.activateSession('browser-a', 'conv_1');
      expect(list).not.toHaveBeenCalled();
      expect(events.some(event => event.type === 'session_catalog')).toBe(false);
    } finally { await runtime.dispose(); }
  });
  it('serves one visible directory page and preserves its cursor without draining later pages', async () => {
    const catalog = catalogFixture();
    const listPage = vi.fn(async () => ({ items: [], nextCursor: 'page_two', projectionVersion: 1 }));
    const list = vi.spyOn(catalog, 'list');
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default', catalog: { ...catalog, listPage }, gateway: gatewayFixture(),
    });
    try {
      await runtime.selectWorkspace('browser-a', '/repo');
      listPage.mockClear();
      list.mockClear();
      expect(await runtime.listSessionPage('browser-a', { cursor: 'page_one', query: 'hello' }))
        .toEqual({ items: [], nextCursor: 'page_two', projectionVersion: 1 });
      expect(listPage).toHaveBeenCalledTimes(1);
      expect(listPage).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'page_one', query: 'hello' }));
      expect(list).not.toHaveBeenCalled();
    } finally { await runtime.dispose(); }
  });
  it('consumes the authoritative selection page without querying the directory again', async () => {
    const catalog = catalogFixture();
    const list = vi.spyOn(catalog, 'list');
    const workspace = { id: 'workspace_repo', displayName: 'repo', canonicalPath: '/repo' };
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default', catalog,
      gateway: gatewayFixture({
        submit: async envelope => ({
          requestId: envelope.requestId, idempotencyKey: envelope.idempotencyKey,
          status: 'accepted', conversationId: null, workspaceId: 'workspace_repo',
          directory: { workspace, page: { items: [], nextCursor: null, projectionVersion: 1 } },
        } as never),
      }),
    });
    try {
      const result = await runtime.selectWorkspace('browser-a', '/repo');
      expect(result).toMatchObject({
        status: 'accepted', workspace, conversations: [], nextCursor: null, projectionVersion: 1,
      });
      expect(list).not.toHaveBeenCalled();
    } finally { await runtime.dispose(); }
  });
  it('lists directory metadata without replaying unattached Conversations', async () => {
    const replay = vi.fn(async () => ({ lastSequence: 0, snapshot: [], deltas: [] }));
    const catalog = catalogFixture();
    catalog.list = async () => Array.from({ length: 100 }, (_, index) => ({
      ...sessionRecord(`conv_${index}`, false).session,
      workspaceId: 'workspace_repo', preview: '',
      activity: { state: 'idle' as const, taskId: null, updatedAt: '2026-09-26T00:00:00.000Z' },
    }));
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default', catalog, gateway: gatewayFixture({ replay }),
    });
    try {
      await runtime.selectWorkspace('browser-a', '/repo');
      expect(replay).not.toHaveBeenCalled();
      const sessions = await runtime.listSessions('browser-a');
      expect(sessions).toHaveLength(100);
      expect(sessions.every(item => item.workspaceId === 'workspace_repo')).toBe(true);
      expect(replay).not.toHaveBeenCalled();
    } finally { await runtime.dispose(); }
  });

  it.each(['trace_delta', 'task_projection', 'turn_started'] as const)(
    'does not announce an empty running Turn from a retained %s fragment',
    async kind => {
      const projected: WebSessionRuntimeEvent[] = [];
      const runtime = new WebGatewaySessionRuntime({
        accountId: 'local-default',
        catalog: catalogFixture(),
        gateway: gatewayFixture({
          replay: async () => ({
            lastSequence: 1,
            snapshot: [],
            deltas: [{
              ...outputEvent('orphan_trace', 1, []),
              kind,
              turnId: 'turn_without_intake',
              requestId: 'req_old',
              payload: { commandKind: 'user_message', status: 'running', events: [] },
            }],
          }),
        }),
      });
      runtime.subscribe('browser-a', event => projected.push(event));
      try {
        await attachBrowser(runtime);
        expect(projected.filter(event => event.type === 'turn_started')).toEqual([]);
        expect(runtime.getReplayEvents('browser-a').filter(event => event.type === 'turn_started')).toEqual([]);
      } finally { await runtime.dispose(); }
    },
  );

  it('surfaces a rejected Stop receipt instead of reporting silent success', async () => {
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway: gatewayFixture({
        submit: async envelope => ({
          requestId: envelope.requestId, idempotencyKey: envelope.idempotencyKey,
          status: envelope.command.kind === 'cancel_turn' ? 'rejected' : 'accepted',
          reason: 'turn_not_running', conversationId: 'conv_1', workspaceId: 'workspace_repo',
        }),
      }),
    });
    try {
      await attachBrowser(runtime);
      await expect(runtime.cancelTurn('browser-a', 'turn_old')).rejects.toThrow('turn_not_running');
    } finally { await runtime.dispose(); }
  });

  it('does not recreate running Turns from retained historical result metadata', async () => {
    const projected: WebSessionRuntimeEvent[] = [];
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway: gatewayFixture({
        replay: async () => ({
          lastSequence: 2,
          snapshot: [],
          deltas: ['result_delivery_available', 'result_completed'].map((kind, index) => ({
            ...outputEvent(`orphan_${index}`, index + 1, []),
            kind: kind as GatewayEventEnvelope['kind'],
            turnId: 'turn_trimmed',
            requestId: 'req_trimmed',
            payload: { resultId: 'old_result', certification: 'certified', completeness: 'complete' },
          })),
        }),
      }),
    });
    runtime.subscribe('browser-a', event => projected.push(event));
    await attachBrowser(runtime);
    expect(projected.filter(event => event.type === 'turn_started')).toEqual([]);
  });

  it('serializes Workspace navigation so a later selection cannot be overtaken', async () => {
    const firstSelection = deferred<{
      requestId: string;
      idempotencyKey: string;
      status: 'accepted';
      workspaceId: string;
      conversationId: null;
    }>();
    const submittedPaths: string[] = [];
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway: gatewayFixture({
        submit: async envelope => {
          if (envelope.command.kind !== 'select_workspace') {
            throw new Error(`unexpected command: ${envelope.command.kind}`);
          }
          submittedPaths.push(envelope.command.path);
          if (envelope.command.path === '/repo-a') return firstSelection.promise;
          return {
            requestId: envelope.requestId,
            idempotencyKey: envelope.idempotencyKey,
            status: 'accepted' as const,
            workspaceId: 'workspace_b',
            conversationId: null,
          };
        },
      }),
    });

    const first = runtime.selectWorkspace('browser-a', '/repo-a');
    await waitFor(() => submittedPaths.length === 1);
    const second = runtime.selectWorkspace('browser-a', '/repo-b');

    expect(submittedPaths).toEqual(['/repo-a']);
    firstSelection.resolve({
      requestId: 'req_a',
      idempotencyKey: 'idem_a',
      status: 'accepted',
      workspaceId: 'workspace_a',
      conversationId: null,
    });

    await Promise.all([first, second]);
    expect(submittedPaths).toEqual(['/repo-a', '/repo-b']);
    expect(runtime.getClientState('browser-a').activeWorkspaceId).toBe('workspace_b');
  });

  it('keeps a message bound to its original Conversation across a foreground switch', async () => {
    const attachmentRead = deferred<{
      metadata: { name: string; mime: string; kind: 'text'; size: number };
      bytes: Buffer;
      path: string;
    }>();
    let submittedConversationId: string | null = null;
    const gateway = gatewayFixture({
      submit: async envelope => {
        if (envelope.scope.kind === 'conversation'
          && envelope.scope.selection.mode === 'attach') {
          submittedConversationId = envelope.scope.selection.conversationId;
        }
        return {
          requestId: envelope.requestId,
          idempotencyKey: envelope.idempotencyKey,
          status: 'accepted' as const,
          conversationId: 'conv_1',
        };
      },
    });
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway,
      attachments: {
        readAttachment: async () => attachmentRead.promise,
      } as unknown as GatewayAttachmentStore,
    });

    await attachBrowser(runtime);
    const submitting = runtime.submit('browser-a', '发给 A', [{
      attachmentId: 'attachment_a',
      kind: 'file',
    }]);
    await runtime.activateSession('browser-a', 'conv_2');
    attachmentRead.resolve({
      metadata: {
        name: 'a.txt',
        mime: 'text/plain',
        mediaClass: 'text',
        size: 1,
        accountId: 'local-default',
        conversationId: 'conv_1',
        workspaceId: 'workspace_repo',
        sha256: 'sha256:a',
        status: 'available',
      },
      bytes: Buffer.from('A'),
      path: '/tmp/a.txt',
    });

    await submitting;
    expect(submittedConversationId).toBe('conv_1');
  });

  it('selects the launch cwd as Workspace without creating a Conversation', async () => {
    const submitted: Array<{ connectionId: string; kind: string }> = [];
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway: gatewayFixture({
        submit: async envelope => {
          submitted.push({ connectionId: envelope.connectionId, kind: envelope.command.kind });
          return {
            requestId: envelope.requestId,
            idempotencyKey: envelope.idempotencyKey,
            status: 'accepted' as const,
            workspaceId: 'workspace_repo',
            conversationId: null,
          };
        },
      }),
    });

    await runtime.selectWorkspace('browser-a', '/repo-a');

    expect(runtime.getClientState('browser-a')).toEqual({
      activeWorkspaceId: 'workspace_repo',
      activeSessionId: null,
    });
    expect(submitted).toEqual([{ connectionId: 'web:browser-a', kind: 'select_workspace' }]);
  });

  it('keeps the Web connection id separate from the Workspace authorization principal', async () => {
    const principals: string[] = [];
    const record = sessionRecord('conv_1', false);
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: {
        ...catalogForRecord(record),
        listWorkspaces: async principalId => {
          principals.push(principalId);
          return [];
        },
        list: async input => {
          principals.push(input.principalId);
          return [];
        },
      },
      gateway: gatewayFixture(),
    });

    await runtime.selectWorkspace('random-session-token', '/repo-a');
    await runtime.listWorkspaces('random-session-token');

    expect(principals).toEqual(['web:local-web-user', 'web:local-web-user']);
  });

  it('direct attach restores the Conversation Workspace and ignores the previously selected Workspace', async () => {
    const gateway = gatewayFixture();
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway,
    });

    await runtime.selectWorkspace('browser-a', '/repo-other');
    await runtime.activateSession('browser-a', 'conv_1');

    expect(runtime.getClientState('browser-a')).toEqual({
      activeWorkspaceId: 'workspace_repo',
      activeSessionId: 'conv_1',
    });
  });

  it('fences remembered attachments to the expected Workspace before activating or exposing history', async () => {
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default', catalog: catalogFixture(), gateway: gatewayFixture(),
    });
    try {
      await runtime.selectWorkspace('browser-a', '/repo-other');
      const before = runtime.getClientState('browser-a');
      expect(await runtime.readSession('browser-a', 'conv_1')).toBeNull();
      expect(await runtime.activateSession('browser-a', 'conv_1', 'workspace_other')).toEqual({
        state: 'activation_blocked', sessionId: 'conv_1', reason: 'session_unavailable',
      });
      expect(runtime.getClientState('browser-a')).toEqual(before);
      expect(await runtime.readSession('browser-a', 'conv_1')).toBeNull();
      expect(await runtime.activateSession('browser-a', 'conv_1', 'workspace_repo')).toEqual({
        state: 'active', sessionId: 'conv_1',
      });
      expect(await runtime.readSession('browser-a', 'conv_1')).not.toBeNull();
    } finally { await runtime.dispose(); }
  });

  it('isolates active Workspace and Conversation between browser clients', async () => {
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway: gatewayFixture({
        submit: async envelope => ({
          requestId: envelope.requestId,
          idempotencyKey: envelope.idempotencyKey,
          status: 'accepted' as const,
          workspaceId: envelope.connectionId.endsWith('browser-a') ? 'workspace_a' : 'workspace_b',
          conversationId: null,
        }),
      }),
    });

    await runtime.selectWorkspace('browser-a', '/repo-a');
    await runtime.selectWorkspace('browser-b', '/repo-b');

    expect(runtime.getClientState('browser-a').activeWorkspaceId).toBe('workspace_a');
    expect(runtime.getClientState('browser-b').activeWorkspaceId).toBe('workspace_b');
  });

  it('subscribes to active Workspace summaries without exposing another Conversation detail', async () => {
    const listeners = new Map<string, (event: GatewayEventEnvelope) => void>();
    const record = sessionRecord('conv_1', false);
    const directoryRecord = {
      ...record.session,
      workspaceId: 'workspace_repo',
      preview: 'Conversation',
      activity: {
        state: 'executing' as const,
        taskId: 'task_1',
        updatedAt: '2026-08-27T09:00:00.000Z',
      },
    };
    const list = vi.fn(async () => [directoryRecord]);
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: {
        ...catalogForRecord(record),
        list,
        search: async () => [directoryRecord],
      },
      gateway: gatewayFixture({
        subscribe: (
          _accountId: string,
          conversationId: string | null,
          listener: (event: GatewayEventEnvelope) => void,
        ) => {
          listeners.set(conversationId ?? '*', listener);
          return () => listeners.delete(conversationId ?? '*');
        },
      }),
    });
    const events: WebSessionRuntimeEvent[] = [];
    runtime.subscribe('browser-a', event => events.push(event));

    await runtime.selectWorkspace('browser-a', '/repo');
    events.length = 0;
    list.mockClear();
    expect(listeners.has('workspace_directory_workspace_repo')).toBe(true);
    listeners.get('workspace_directory_workspace_repo')?.({
      ...outputEvent('workspace_activity_1', 1, []),
      conversationId: 'workspace_directory_workspace_repo',
      kind: 'workspace_activity_changed',
      payload: {
        workspaceId: 'workspace_repo',
        conversationId: 'conv_1',
        activity: directoryRecord.activity,
      },
    });

    await waitFor(() => events.some(event => event.type === 'workspace_conversation_changed'));
    expect(events).toContainEqual({
      type: 'workspace_conversation_changed',
      workspaceId: 'workspace_repo',
      conversationId: 'conv_1',
      changes: { activity: directoryRecord.activity },
    });
    expect(list).not.toHaveBeenCalled();
    expect(events.some(event => event.type === 'trace_delta')).toBe(false);
    expect(events.some(event => event.type === 'final_answer')).toBe(false);
    await expect(runtime.readSession('browser-a', 'conv_1')).resolves.toBeNull();
  });

  it('restores the target Workspace when attaching a Conversation from another Workspace', async () => {
    const restored: Array<{ connectionId: string; workspaceId: string }> = [];
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: {
        ...catalogFixture(),
        workspaceIdForConversation: async sessionId => (
          sessionId === 'conv_1' ? 'workspace_other' : 'workspace_repo'
        ),
      },
      gateway: gatewayFixture({
        restoreWorkspace: (connectionId: string, workspaceId: string) => {
          restored.push({ connectionId, workspaceId });
        },
      }),
    });

    await runtime.selectWorkspace('browser-a', '/repo');
    await expect(runtime.activateSession('browser-a', 'conv_1')).resolves.toEqual({
      state: 'active',
      sessionId: 'conv_1',
    });
    expect(runtime.getClientState('browser-a')).toEqual({
      activeWorkspaceId: 'workspace_other',
      activeSessionId: 'conv_1',
    });
    expect(restored.at(-1)).toEqual({
      connectionId: 'web:browser-a',
      workspaceId: 'workspace_other',
    });
  });

  it('forwards opaque attachment references without injecting file content into Planner input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-runtime-attachments-'));
    try {
      const store = new FileAttachmentStore(join(root, 'attachments'));
      await store.initialize();
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const image = await store.saveAttachment({
        sessionId: 'conv_1',
        name: 'chart.png',
        bytes: pngMagic,
      });
      const doc = await store.saveAttachment({
        sessionId: 'conv_1',
        name: 'notes.md',
        bytes: Buffer.from('# 标题\n第一行内容', 'utf8'),
      });

      let capturedText = '';
      let capturedAttachments: Array<{ attachmentId: string; kind: string }> = [];
      const gateway = {
        attachClient: async () => () => undefined,
        subscribe: () => () => undefined,
        replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
        submit: async (envelope: {
          requestId: string;
          command?: {
            text?: string;
            attachments?: Array<{ attachmentId: string; kind: string }>;
          };
        }) => {
          capturedText = envelope.command?.text ?? '';
          capturedAttachments = envelope.command?.attachments ?? [];
          return {
            requestId: envelope.requestId,
            idempotencyKey: 'idem_1',
            status: 'accepted' as const,
            conversationId: 'conv_1',
          };
        },
      } as unknown as WebGatewayAdapter;
      const runtime = new WebGatewaySessionRuntime({
        accountId: 'local-default',
        catalog: catalogFixture(),
        gateway,
        attachments: store,
        createId: prefix => `${prefix}_1`,
      });

      await attachBrowser(runtime);
      await runtime.submit('browser-a', '分析这些材料', [
        { attachmentId: image.attachmentId, kind: 'file' },
        { attachmentId: doc.attachmentId, kind: 'file' },
      ]);
      await runtime.dispose();

      expect(capturedText).toBe('分析这些材料');
      expect(capturedText).not.toContain('chart.png');
      expect(capturedText).not.toContain('第一行内容');
      expect(capturedAttachments).toEqual([
        { attachmentId: image.attachmentId, kind: 'file' },
        { attachmentId: doc.attachmentId, kind: 'file' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a message whose attachments exceed the per-message budget before admitting it', async () => {
    // Metadata-only stub: the budget rule reads sizes, never bytes, so this
    // test must not materialize hundreds of megabytes of files.
    const oversized = 90 * 1024 * 1024;
    const attachments = {
      readAttachmentMetadata: async (_conversationId: string, attachmentId: string) => ({
        attachmentId,
        accountId: 'local-default',
        conversationId: 'conv_1',
        workspaceId: 'workspace_repo',
        name: `${attachmentId}.bin`,
        mime: 'application/octet-stream',
        mediaClass: 'binary' as const,
        size: oversized,
        sha256: 'sha256:stub',
        status: 'available' as const,
        createdAt: new Date(0).toISOString(),
      }),
    } as unknown as GatewayAttachmentStore;

    let submitCalls = 0;
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway: gatewayFixture({
        submit: async envelope => {
          submitCalls += 1;
          return {
            requestId: envelope.requestId,
            idempotencyKey: envelope.idempotencyKey,
            status: 'accepted' as const,
            conversationId: 'conv_1',
          };
        },
      }),
      attachments,
    });

    await attachBrowser(runtime);
    await expect(runtime.submit(
      'browser-a',
      '分析这六份材料',
      Array.from({ length: 6 }, (_, index) => ({
        attachmentId: `att_${index}`,
        kind: 'file',
      })),
    )).rejects.toMatchObject({ code: 'attachment_total_too_large' });
    await runtime.dispose();

    expect(submitCalls).toBe(0);
  });

  it('rejects an attachment that is missing or no longer available', async () => {
    const attachments = {
      readAttachmentMetadata: async () => null,
    } as unknown as GatewayAttachmentStore;
    let submitCalls = 0;
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway: gatewayFixture({
        submit: async envelope => {
          submitCalls += 1;
          return {
            requestId: envelope.requestId,
            idempotencyKey: envelope.idempotencyKey,
            status: 'accepted' as const,
            conversationId: 'conv_1',
          };
        },
      }),
      attachments,
    });

    await attachBrowser(runtime);
    await expect(runtime.submit('browser-a', '看这个', [
      { attachmentId: 'att_missing', kind: 'file' },
    ])).rejects.toMatchObject({ code: 'attachment_unavailable' });
    await runtime.dispose();

    expect(submitCalls).toBe(0);
  });

  it('rejects an oversized attachment count before resolving metadata', async () => {
    let submitCalls = 0;
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway: gatewayFixture({
        submit: async envelope => {
          submitCalls += 1;
          return {
            requestId: envelope.requestId,
            idempotencyKey: envelope.idempotencyKey,
            status: 'accepted' as const,
            conversationId: 'conv_1',
          };
        },
      }),
    });

    await attachBrowser(runtime);
    await expect(runtime.submit(
      'browser-a',
      '太多了',
      Array.from({ length: 33 }, (_, index) => ({ attachmentId: `att_${index}`, kind: 'file' })),
    )).rejects.toMatchObject({ code: 'attachment_count_exceeded' });
    await runtime.dispose();

    expect(submitCalls).toBe(0);
  });

  it('keeps the persisted Turn Task authoritative over a mismatched historical Timeline', async () => {
    const record = sessionRecord('conv_1', true);
    record.turns = [{
      id: 'turn_b',
      sessionId: 'conv_1',
      userInput: '执行 Task B',
      status: 'completed',
      finalAnswer: 'Task B completed',
      taskId: 'task_b',
      startedAt: '2026-09-10T09:00:00.000Z',
      completedAt: '2026-09-10T09:05:00.000Z',
      traceEvents: [{
        id: 'task_b_progress',
        sequence: 1,
        occurredAt: '2026-09-10T09:01:00.000Z',
        phase: 'execution',
        actor: 'executor',
        kind: 'executor_progress',
        status: 'completed',
        title: 'Task B progress',
        summary: 'current',
        taskId: 'task_b',
        subtaskId: 'subtask_b',
        details: { taskId: 'task_b', subtaskId: 'subtask_b' },
      }],
      executionTimeline: {
        taskId: 'task_a',
        title: 'Task A',
        status: 'done',
        stages: [{
          phase: 'execution',
          status: 'done',
          subtasks: [{
            id: 'subtask_a',
            title: 'Historical Task A',
            status: 'done',
            attempts: [],
          }],
        }],
      },
      artifactRefs: [],
      artifacts: [],
    }];
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogForRecord(record),
      gateway: gatewayFixture(),
    });

    await attachBrowser(runtime);
    const rebuilt = await runtime.readSession('browser-a', 'conv_1');

    expect(rebuilt?.turns[0]).toMatchObject({
      taskId: 'task_b',
      executionTimeline: null,
      traceEvents: [expect.objectContaining({ id: 'task_b_progress' })],
    });
  });

  it('rebuilds an explicit resume turn from durable task timeline and artifacts', async () => {
    const record: WebSessionRecord = {
      version: 1,
      session: {
        id: 'conv_1',
        title: 'Conversation',
        createdAt: '2026-08-19T00:00:00.000Z',
        updatedAt: '2026-08-19T00:05:00.000Z',
        active: true,
        archived: false,
      },
      turns: [
        {
          id: 'turn_resume_old',
          sessionId: 'conv_1',
          userInput: '/task resume task_1',
          status: 'completed',
          finalAnswer: '恢复请求已提交',
          taskId: null,
          startedAt: '2026-08-19T00:00:00.000Z',
          completedAt: '2026-08-19T00:00:01.000Z',
          traceEvents: [],
          executionTimeline: null,
          artifactRefs: [],
          artifacts: [],
        },
        {
          id: 'turn_resume',
          sessionId: 'conv_1',
          userInput: '/task resume task_1',
          status: 'completed',
          finalAnswer: '恢复任务已完成',
          taskId: null,
          startedAt: '2026-08-19T00:01:00.000Z',
          completedAt: '2026-08-19T00:05:00.000Z',
          traceEvents: [],
          executionTimeline: null,
          artifactRefs: [],
          artifacts: [],
        },
      ],
    };
    const timeline: ExecutionTimeline = {
      taskId: 'task_1',
      title: '生成 HTML',
      status: 'done',
      stages: [
        { phase: 'planning', status: 'done' },
        { phase: 'authorization', status: 'done' },
        {
          phase: 'execution',
          status: 'done',
          subtasks: [{
            id: 'sub_1',
            title: '生成 HTML 报告',
            status: 'done',
            executor: 'codex-cli',
            attempts: [{
              attemptId: 'attempt_1',
              result: 'completed',
              progressHistory: [{
                kind: 'status',
                text: '报告已生成',
                occurredAt: '2026-08-19T00:04:00.000Z',
              }],
            }],
          }],
        },
        { phase: 'verification', status: 'done' },
        { phase: 'delivery', status: 'done' },
      ],
    };
    let timelineProjectionCount = 0;
    let artifactProjectionCount = 0;
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogForRecord(record),
      gateway: {
        attachClient: async () => () => undefined,
        subscribe: () => () => undefined,
        replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
      } as unknown as WebGatewayAdapter,
      projectExecutionTimeline: taskId => {
        timelineProjectionCount += 1;
        return taskId === 'task_1' ? timeline : null;
      },
      projectTaskArtifacts: taskId => {
        artifactProjectionCount += 1;
        return taskId === 'task_1'
          ? [{
          artifactId: 'artifact_1',
          taskId: 'task_1',
          publicationId: 'publication_1',
          displayName: 'report.html',
          relativePath: 'reports/report.html',
          mediaType: 'text/html',
          previewKind: 'code',
          previewable: true,
          byteLength: 1_024,
          contentHash: 'sha256:abc',
          publishedAt: '2026-08-19T00:04:30.000Z',
          }]
          : [];
      },
    });

    await attachBrowser(runtime);
    const rebuilt = await runtime.readSession('browser-a', 'conv_1');

    expect(rebuilt?.turns[0]).toMatchObject({
      taskId: 'task_1',
      executionTimeline: null,
      artifacts: [],
    });
    expect(rebuilt?.turns[1]).toMatchObject({
      taskId: 'task_1',
      executionTimeline: timeline,
      artifactRefs: ['reports/report.html'],
      artifacts: [expect.objectContaining({
        artifactId: 'artifact_1',
        relativePath: 'reports/report.html',
      })],
    });
    expect(timelineProjectionCount).toBe(1);
    expect(artifactProjectionCount).toBe(1);
  });

  it('rehydrates artifacts for a historical Turn whose legacy record missed taskId', async () => {
    const artifact = {
      artifactId: 'artifact_legacy_turn',
      taskId: 'task_legacy_turn',
      publicationId: 'publication_legacy_turn',
      displayName: '天气报告.md',
      relativePath: '天气报告.md',
      mediaType: 'text/markdown; charset=utf-8',
      previewKind: 'markdown' as const,
      previewable: true,
      byteLength: 128,
      contentHash: 'sha256:legacy-turn',
      publishedAt: '2026-09-26T06:00:00.000Z',
    };
    const record = sessionRecord('conv_1', true);
    record.turns = [{
      id: 'turn_legacy_task_binding',
      sessionId: 'conv_1',
      userInput: '查询天气并生成报告',
      status: 'completed',
      finalAnswer: '报告已生成：天气报告.md',
      taskId: null,
      startedAt: '2026-09-26T05:00:00.000Z',
      completedAt: '2026-09-26T05:05:00.000Z',
      traceEvents: [],
      executionTimeline: null,
      artifactRefs: [],
      artifacts: [],
    }];
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogForRecord(record),
      gateway: gatewayFixture(),
      resolveTaskIdForTurn: turnId => (
        turnId === 'turn_legacy_task_binding' ? artifact.taskId : null
      ),
      projectTaskArtifacts: taskId => taskId === artifact.taskId ? [artifact] : [],
    });

    await attachBrowser(runtime);
    const rebuilt = await runtime.readSession('browser-a', 'conv_1');

    expect(rebuilt?.turns[0]).toMatchObject({
      taskId: artifact.taskId,
      artifactRefs: [artifact.relativePath],
      artifacts: [artifact],
    });
  });

  it('rehydrates a historical retrying Task as a non-terminal turn', async () => {
    const record = sessionRecord('conv_1', true);
    record.turns = [{
      id: 'turn_retrying',
      sessionId: 'conv_1',
      userInput: '执行任务',
      status: 'blocked',
      finalAnswer: 'Execution blocked: retry scheduled',
      taskId: 'task_retrying',
      startedAt: '2026-09-10T06:00:00.000Z',
      completedAt: '2026-09-10T06:05:00.000Z',
      traceEvents: [],
      executionTimeline: null,
      artifactRefs: [],
      artifacts: [],
    }];
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogForRecord(record),
      gateway: gatewayFixture(),
      projectExecutionTimeline: taskId => taskId === 'task_retrying'
        ? {
            taskId,
            title: '执行任务',
            status: 'waiting_retry',
            stages: [
              { phase: 'planning', status: 'done' },
              { phase: 'authorization', status: 'done' },
              { phase: 'execution', status: 'running' },
              { phase: 'verification', status: 'pending' },
              { phase: 'delivery', status: 'pending' },
            ],
          }
        : null,
    });

    await attachBrowser(runtime);
    const rebuilt = await runtime.readSession('browser-a', 'conv_1');

    expect(rebuilt?.turns[0]).toMatchObject({
      id: 'turn_retrying',
      status: 'running',
      completedAt: null,
      executionTimeline: expect.objectContaining({ status: 'waiting_retry' }),
    });
  });

  it('filters foreign Task events from an existing mixed historical Turn', async () => {
    const record = sessionRecord('conv_1', true);
    record.turns = [{
      id: 'turn_b',
      sessionId: 'conv_1',
      userInput: '执行 Task B',
      status: 'completed',
      finalAnswer: 'Task B completed',
      taskId: 'task_b',
      startedAt: '2026-09-10T09:00:00.000Z',
      completedAt: '2026-09-10T09:05:00.000Z',
      traceEvents: [
        {
          id: 'query_b',
          sequence: 1,
          occurredAt: '2026-09-10T09:00:00.000Z',
          phase: 'intake',
          actor: 'user',
          kind: 'query_received',
          status: 'completed',
          title: 'Query',
          summary: '执行 Task B',
          taskId: null,
          subtaskId: null,
          details: {},
        },
        {
          id: 'task_a_progress',
          sequence: 2,
          occurredAt: '2026-09-10T08:59:00.000Z',
          phase: 'execution',
          actor: 'executor',
          kind: 'executor_progress',
          status: 'completed',
          title: 'Task A progress',
          summary: 'old',
          taskId: 'task_a',
          subtaskId: 'subtask_a',
          details: { taskId: 'task_a', subtaskId: 'subtask_a' },
        },
        {
          id: 'task_b_progress',
          sequence: 3,
          occurredAt: '2026-09-10T09:01:00.000Z',
          phase: 'execution',
          actor: 'executor',
          kind: 'executor_progress',
          status: 'completed',
          title: 'Task B progress',
          summary: 'current',
          taskId: 'task_b',
          subtaskId: 'subtask_b',
          details: { taskId: 'task_b', subtaskId: 'subtask_b' },
        },
      ],
      executionTimeline: {
        taskId: 'task_b',
        title: 'Task B',
        status: 'done',
        stages: [{
          phase: 'execution',
          status: 'done',
          subtasks: [{
            id: 'subtask_b',
            title: 'Subtask B',
            status: 'done',
            attempts: [],
          }],
        }],
      },
      artifactRefs: [],
      artifacts: [],
    }];
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogForRecord(record),
      gateway: gatewayFixture(),
    });

    await attachBrowser(runtime);
    const rebuilt = await runtime.readSession('browser-a', 'conv_1');

    expect(rebuilt?.turns[0]?.traceEvents.map(event => event.id)).toEqual([
      'query_b',
      'task_b_progress',
    ]);
    expect(record.turns[0]?.traceEvents.map(event => event.id)).toEqual([
      'query_b',
      'task_a_progress',
      'task_b_progress',
    ]);
  });
});

function catalogFixture(): WebSessionRuntimeCatalog {
  const record = sessionRecord('conv_1', true);
  return catalogForRecord(record);
}

function sessionRecord(id: string, active: boolean): WebSessionRecord {
  return {
    version: 1,
    session: {
      id,
      title: 'Conversation',
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
      active,
      archived: false,
    },
    turns: [],
  };
}

function catalogForRecord(record: WebSessionRecord): WebSessionRuntimeCatalog {
  return {
    initialize: async () => undefined,
    create: async () => record,
    list: async () => [record.session],
    search: async () => [record.session],
    read: async () => record,
    workspaceIdForConversation: async () => 'workspace_repo',
    listWorkspaces: async () => [],
    archive: async () => true,
    clearWorkspace: async () => 0,
    appendTurn: async () => record,
  };
}

async function attachBrowser(
  runtime: WebGatewaySessionRuntime,
  clientId = 'browser-a',
): Promise<void> {
  await runtime.activateSession(clientId, 'conv_1');
}

function outputEvent(
  eventId: string,
  sequence: number,
  lines: string[],
): GatewayEventEnvelope {
  return {
    protocolVersion: 2,
    eventId,
    sequence,
    accountId: 'local-default',
    conversationId: 'conv_1',
    requestId: null,
    turnId: null,
    kind: 'conversation_snapshot',
    payload: { from: 0, lines },
    occurredAt: '2026-08-19T00:00:00.000Z',
  };
}

function turnStartedEvent(
  eventId: string,
  sequence: number,
  requestId: string,
  turnId: string,
): GatewayEventEnvelope {
  return {
    protocolVersion: 2,
    eventId,
    sequence,
    accountId: 'local-default',
    conversationId: 'conv_1',
    requestId,
    turnId,
    kind: 'turn_started',
    payload: { commandKind: 'user_message' },
    occurredAt: '2026-08-19T00:00:00.000Z',
  };
}

function traceDeltaEvent(
  eventId: string,
  sequence: number,
  turnId: string,
): GatewayEventEnvelope {
  return {
    protocolVersion: 2,
    eventId,
    sequence,
    accountId: 'local-default',
    conversationId: 'conv_1',
    requestId: 'req_test',
    turnId,
    kind: 'trace_delta',
    payload: {
      turnId,
      status: 'running',
      events: [{
        id: 'trace_1',
        sequence: 1,
        kind: 'planner',
        title: 'Planning',
        summary: 'Planner parsed intent',
        details: { phase: 'planner' },
        occurredAt: '2026-08-19T00:00:00.000Z',
      }],
    },
    occurredAt: '2026-08-19T00:00:00.000Z',
  };
}

function workspaceSnapshot(
  conversationId: string,
  workspace: { path: string; selectedAt: string } | null,
  sequence: number,
): GatewayEventEnvelope {
  return {
    ...outputEvent(`workspace_snapshot_${sequence}`, sequence, []),
    conversationId,
    payload: { from: 0, lines: [], workspace },
  };
}

function workspaceChanged(
  conversationId: string,
  path: string,
  sequence: number,
): GatewayEventEnvelope {
  return {
    ...workspaceSnapshot(conversationId, null, sequence),
    eventId: `workspace_changed_${sequence}`,
    kind: 'workspace_changed',
    payload: {
      workspace: {
        path,
        selectedAt: '2026-08-27T09:00:00.000Z',
      },
    },
  };
}

function gatewayFixture(
  overrides: Partial<WebGatewayAdapter> = {},
): WebGatewayAdapter {
  return {
    attachClient: async () => () => undefined,
    subscribe: () => () => undefined,
    replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
    restoreWorkspace: () => undefined,
    closeConnection: () => undefined,
    submit: async envelope => ({
      requestId: envelope.requestId,
      idempotencyKey: envelope.idempotencyKey,
      status: 'accepted',
      conversationId: envelope.scope.kind === 'conversation'
        && envelope.scope.selection.mode === 'attach'
        ? envelope.scope.selection.conversationId
        : 'conv_new',
      workspaceId: 'workspace_repo',
    }),
    ...overrides,
  } as WebGatewayAdapter;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

// ===== 可见账单：Turn 三态账单卡与账单页（账单简化设计 §3/§4） =====

import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqliteQueryContextStore } from '../../src/storage/query-usage-context-repo.js';
import { SqliteMeteringStore } from '../../src/storage/metering-repo.js';
import {
  SqliteBillAdjustmentStore,
  SqliteBillStore,
  SqliteBillingUnitOfWork,
  SqliteCostEntryStore,
  SqlitePriceStore,
} from '../../src/storage/billing-repo.js';
import { SqliteConsumptionOutboxStore } from '../../src/storage/consumption-outbox-repo.js';
import { createQueryBillService } from '../../src/billing/query-bill-service.js';
import { createBillQueryService } from '../../src/billing/bill-query-service.js';
import type { BillQueryService } from '../../src/billing/bill-query-service.js';
import type { QueryUsageContext } from '../../src/metering/ports.js';
import { PLATFORM_PRICE_BOOK } from '../billing/harness.js';

function createRuntimeBillingService(): {
  billing: BillQueryService;
  contexts: SqliteQueryContextStore;
  metering: SqliteMeteringStore;
  bills: SqliteBillStore;
  billService: ReturnType<typeof createQueryBillService>;
  close: () => void;
} {
  const db = new Database(':memory:');
  runMigrations(db);
  const contexts = new SqliteQueryContextStore(db);
  const metering = new SqliteMeteringStore(db);
  const prices = new SqlitePriceStore(db);
  const costEntries = new SqliteCostEntryStore(db);
  const bills = new SqliteBillStore(db);
  const adjustments = new SqliteBillAdjustmentStore(db);
  const outbox = new SqliteConsumptionOutboxStore(db);
  const unitOfWork = new SqliteBillingUnitOfWork(db);
  outbox.ensureSourceInstanceId('instance-runtime-test', '2026-09-22T00:00:00.000Z');
  // 刻意不播种价格书：Query 上下文固定 'unconfigured'，终结尝试进入待核对，
  // 正好覆盖「待确认 + missing_price_book」的用户路径。
  const billService = createQueryBillService({
    queryContexts: contexts,
    metering,
    prices,
    costEntries,
    bills,
    unitOfWork,
    consumption: outbox,
    exportEnabled: () => false,
    resolveExternalAccountRef: () => null,
    createCostEntryId: (observationId, kind) => `cost_${kind}_${observationId}`,
  });
  const billing = createBillQueryService({
    bills,
    adjustments,
    consumption: outbox,
    costs: costEntries,
    queryContexts: contexts,
    metering,
    prices,
    exportEnabled: () => false,
    now: () => '2026-09-22T01:00:00.000Z',
  });
  return {
    billing,
    contexts,
    metering,
    bills,
    billService,
    close: () => db.close(),
  };
}

function seedTurnQuery(
  store: SqliteQueryContextStore,
  input: {
    readonly queryId: string;
    readonly turnId: string;
    readonly accountId?: string;
    readonly conversationId?: string;
  },
): void {
  const context: QueryUsageContext = {
    queryId: input.queryId,
    accountId: input.accountId ?? 'local-default',
    ingress: 'web',
    requestKey: `req-${input.queryId}`,
    requestPayloadDigest: `digest-${input.queryId}`,
    conversationId: input.conversationId ?? 'conv_1',
    requestId: `request-${input.queryId}`,
    turnId: input.turnId,
    executionSegmentId: null,
    priceBookVersion: 'unconfigured',
    feePolicyVersion: 'unconfigured',
    payerPolicyVersion: 'unknown-v1',
    acceptedAt: '2026-09-22T00:00:00.000Z',
  };
  store.insert(context);
}

function persistedTurnFixture(overrides: {
  readonly id: string;
  readonly userInput?: string;
  readonly status?: 'completed' | 'failed';
  readonly queryBill?: unknown;
}): WebSessionRecord['turns'][number] {
  return {
    id: overrides.id,
    sessionId: 'conv_1',
    userInput: overrides.userInput ?? '调研鸡蛋期货上涨原因',
    interactionKind: 'ai_turn',
    status: overrides.status ?? 'completed',
    finalAnswer: '结论……',
    taskId: 'task_billing',
    startedAt: '2026-09-22T00:00:00.000Z',
    completedAt: '2026-09-22T00:05:00.000Z',
    traceEvents: [],
    executionTimeline: null,
    artifactRefs: [],
    artifacts: [],
    ...(overrides.queryBill !== undefined ? { queryBill: overrides.queryBill as null } : {}),
  };
}

function billingCatalogFixture(turns: WebSessionRecord['turns']): WebSessionRuntimeCatalog {
  const record: WebSessionRecord = {
    ...sessionRecord('conv_1', true),
    turns: turns.map(turn => structuredClone(turn)),
  };
  return {
    initialize: async () => undefined,
    create: async () => record,
    list: async () => [record.session],
    search: async () => [record.session],
    read: async () => structuredClone(record),
    readTurn: async (_id, turnId) => record.turns.find(turn => turn.id === turnId) ?? null,
    workspaceIdForConversation: async () => 'workspace_repo',
    listWorkspaces: async () => [],
    archive: async () => true,
    clearWorkspace: async () => 0,
    appendTurn: async () => record,
  };
}

describe('WebGatewaySessionRuntime 可见账单', () => {
  it('历史记录读取时按 Turn 重新投影三态账单，替换持久化的陈旧账单', async () => {
    const store = createRuntimeBillingService();
    try {
      seedTurnQuery(store.contexts, { queryId: 'query_1', turnId: 'turn_1' });
      store.metering.insertObservations([{
        observationId: 'obs_1',
        spanId: null,
        sourceId: 'planner',
        sourceEventKey: 'evt_1',
        sourceScope: 'model_request',
        callId: 'call_1',
        queryId: 'query_1',
        executionSegmentId: null,
        taskId: 'task_billing',
        stage: 'planning',
        reason: 'primary',
        resource: 'model_tokens',
        metric: 'input',
        unit: 'token',
        quantityNumerator: '1000',
        quantityDenominator: '1',
        quality: 'reported',
        countsTowardTotal: true,
        payer: 'platform',
        capturedAt: '2026-09-22T00:01:00.000Z',
        providerBindingVersion: null,
        evidenceRef: null,
        normalizationRuleVersion: 'usage-normalizer-v1',
      }]);
      store.billService.finalizeQueryBill({
        queryId: 'query_1',
        finalizedAt: '2026-09-22T00:02:00.000Z',
      });
      const runtime = new WebGatewaySessionRuntime({
        accountId: 'local-default',
        catalog: billingCatalogFixture([
          // 持久化记录里故意放置没有 userStatus 的陈旧账单投影
          persistedTurnFixture({ id: 'turn_1', queryBill: { billId: 'stale' } }),
        ]),
        gateway: gatewayFixture(),
        billing: store.billing,
        projectExecutionTimeline: taskId => ({
          taskId,
          title: '鸡蛋期货近期上涨原因调研',
          status: 'completed',
          stages: [],
        }),
      });
      runtime.subscribe('browser-a', () => undefined);
      await attachBrowser(runtime);
      const record = await runtime.readSession('browser-a', 'conv_1');
      expect(record).not.toBeNull();
      const turn = record!.turns[0]!;
      expect(turn.turnBilling).not.toBeNull();
      expect(turn.turnBilling!.userStatus).toBe('unconfirmed');
      expect(turn.turnBilling!.diagnosticCode).toBe('missing_price_book');
      expect(turn.queryBill?.userStatus).toBe('unconfirmed');
      expect(turn.queryBill?.billId).not.toBe('stale');
    } finally {
      store.close();
    }
  });

  it('没有任何账单事实的历史 Turn 仍得到待确认视图，不静默空白', async () => {
    const store = createRuntimeBillingService();
    try {
      const runtime = new WebGatewaySessionRuntime({
        accountId: 'local-default',
        catalog: billingCatalogFixture([
          persistedTurnFixture({ id: 'turn_ancient' }),
        ]),
        gateway: gatewayFixture(),
        billing: store.billing,
      });
      runtime.subscribe('browser-a', () => undefined);
      await attachBrowser(runtime);
      const record = await runtime.readSession('browser-a', 'conv_1');
      expect(record!.turns[0]!.turnBilling).toMatchObject({
        turnId: 'turn_ancient',
        userStatus: 'unconfirmed',
        diagnosticCode: 'historical_unavailable',
        amountMicroCoin: null,
      });
    } finally {
      store.close();
    }
  });

  it('账单服务缺失时仍显示明确的账单投影失败原因', async () => {
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: billingCatalogFixture([
        persistedTurnFixture({ id: 'turn_without_billing_service' }),
      ]),
      gateway: gatewayFixture(),
    });
    runtime.subscribe('browser-a', () => undefined);
    await attachBrowser(runtime);
    const record = await runtime.readSession('browser-a', 'conv_1');
    expect(record!.turns[0]!.turnBilling).toMatchObject({
      turnId: 'turn_without_billing_service',
      userStatus: 'unconfirmed',
      diagnosticCode: 'missing_billing_projection',
      amountMicroCoin: null,
    });
  });

  it('系统命令 Turn 不投影账单卡', async () => {
    const store = createRuntimeBillingService();
    try {
      const runtime = new WebGatewaySessionRuntime({
        accountId: 'local-default',
        catalog: billingCatalogFixture([
          persistedTurnFixture({ id: 'turn_cmd', userInput: '/status' }),
        ]),
        gateway: gatewayFixture(),
        billing: store.billing,
      });
      runtime.subscribe('browser-a', () => undefined);
      await attachBrowser(runtime);
      const record = await runtime.readSession('browser-a', 'conv_1');
      expect(record!.turns[0]!.turnBilling).toBeNull();
    } finally {
      store.close();
    }
  });

  it('durable Query overrides a stale system-command classification for a business Turn', async () => {
    const store = createRuntimeBillingService();
    try {
      seedTurnQuery(store.contexts, { queryId: 'query_misclassified', turnId: 'turn_misclassified' });
      store.metering.insertObservations([{
        observationId: 'obs_misclassified',
        spanId: null,
        sourceId: 'planner',
        sourceEventKey: 'evt_misclassified',
        sourceScope: 'model_request',
        callId: 'call_misclassified',
        queryId: 'query_misclassified',
        executionSegmentId: null,
        taskId: 'task_misclassified',
        stage: 'planning',
        reason: 'primary',
        resource: 'model_tokens',
        metric: 'input',
        unit: 'token',
        quantityNumerator: '1000',
        quantityDenominator: '1',
        quality: 'reported',
        countsTowardTotal: true,
        payer: 'platform',
        capturedAt: '2026-09-22T00:01:00.000Z',
        providerBindingVersion: null,
        evidenceRef: null,
        normalizationRuleVersion: 'usage-normalizer-v1',
      }]);
      store.billService.finalizeQueryBill({
        queryId: 'query_misclassified',
        finalizedAt: '2026-09-22T00:02:00.000Z',
      });
      const turn = persistedTurnFixture({
        id: 'turn_misclassified',
        userInput: '中美领导人最近的会议都聊了点啥？',
      });
      turn.interactionKind = 'system_command';
      const runtime = new WebGatewaySessionRuntime({
        accountId: 'local-default',
        catalog: billingCatalogFixture([turn]),
        gateway: gatewayFixture(),
        billing: store.billing,
      });
      runtime.subscribe('browser-a', () => undefined);
      await attachBrowser(runtime);
      const record = await runtime.readSession('browser-a', 'conv_1');
      expect(record!.turns[0]!.turnBilling).toMatchObject({
        queryId: 'query_misclassified',
        userStatus: 'unconfirmed',
      });
    } finally {
      store.close();
    }
  });

  it('listBillingRecords 联合请求摘要与 Task 标题，并支持三态筛选', async () => {
    const store = createRuntimeBillingService();
    try {
      seedTurnQuery(store.contexts, { queryId: 'query_1', turnId: 'turn_1' });
      seedTurnQuery(store.contexts, { queryId: 'query_2', turnId: 'turn_2' });
      // Query→Task 授权链接必须在终结前建立，账单行才会携带 taskId。
      store.contexts.linkTask({
        queryId: 'query_1',
        costTaskId: 'task_billing',
        decisionId: 'decision_1',
        basis: 'authorized_application',
        linkedAt: '2026-09-22T00:00:30.000Z',
      });
      store.contexts.linkTask({
        queryId: 'query_2',
        costTaskId: 'task_billing',
        decisionId: 'decision_2',
        basis: 'authorized_application',
        linkedAt: '2026-09-22T00:00:30.000Z',
      });
      // 价格版本未配置 → 终结尝试进入待核对，用户状态为待确认
      store.billService.finalizeQueryBill({
        queryId: 'query_1',
        finalizedAt: '2026-09-22T00:02:00.000Z',
      });
      store.billService.finalizeQueryBill({
        queryId: 'query_2',
        finalizedAt: '2026-09-22T00:02:00.000Z',
      });
      const runtime = new WebGatewaySessionRuntime({
        accountId: 'local-default',
        catalog: billingCatalogFixture([
          persistedTurnFixture({ id: 'turn_1' }),
          persistedTurnFixture({ id: 'turn_2', userInput: '第二个请求' }),
        ]),
        readBillingTurnFacts: async (_conversationId, turnId) => ({ userInput: turnId === 'turn_1' ? '来自统一读模型的请求' : '第二个请求' }),
        gateway: gatewayFixture(),
        billing: store.billing,
        projectExecutionTimeline: taskId => ({
          taskId,
          title: '鸡蛋期货近期上涨原因调研',
          status: 'completed',
          stages: [],
        }),
      });
      runtime.subscribe('browser-a', () => undefined);
      await attachBrowser(runtime);
      const page = await runtime.listBillingRecords('browser-a', {});
      expect(page.items).toHaveLength(2);
      const first = page.items.find(entry => entry.bill.queryId === 'query_1')!;
      const second = page.items.find(entry => entry.bill.queryId === 'query_2')!;
      expect(first.requestSummary).toBe('来自统一读模型的请求');
      expect(first.taskTitle).toBe('鸡蛋期货近期上涨原因调研');
      expect(first.bill.userStatus).toBe('unconfirmed');
      expect(second.requestSummary).toBe('第二个请求');
      const billed = await runtime.listBillingRecords('browser-a', { filter: 'billed' });
      expect(billed.items).toHaveLength(0);
      const unconfirmed = await runtime.listBillingRecords('browser-a', {
        filter: 'unconfirmed',
      });
      expect(unconfirmed.items).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it('getTaskBillingDetail 列出同 Task 的关联请求；无事实时返回空列表', async () => {
    const store = createRuntimeBillingService();
    try {
      seedTurnQuery(store.contexts, { queryId: 'query_1', turnId: 'turn_1' });
      seedTurnQuery(store.contexts, { queryId: 'query_2', turnId: 'turn_2' });
      store.billService.finalizeQueryBill({
        queryId: 'query_1',
        finalizedAt: '2026-09-22T00:02:00.000Z',
      });
      store.billService.finalizeQueryBill({
        queryId: 'query_2',
        finalizedAt: '2026-09-22T00:02:00.000Z',
      });
      const runtime = new WebGatewaySessionRuntime({
        accountId: 'local-default',
        catalog: billingCatalogFixture([]),
        gateway: gatewayFixture(),
        billing: store.billing,
        authorizeTask: () => true,
      });
      runtime.subscribe('browser-a', () => undefined);
      await attachBrowser(runtime);
      // 账单行的 taskId 来自 Query→Task 授权链接；这里尚未建立链接，应为空列表。
      const detail = await runtime.getTaskBillingDetail('browser-a', 'task_billing');
      expect(detail?.items).toEqual([]);
      expect(detail?.taskId).toBe('task_billing');
    } finally {
      store.close();
    }
  });

  it('不会为未授权账户解析 Task 标题', async () => {
    const store = createRuntimeBillingService();
    try {
      const runtime = new WebGatewaySessionRuntime({
        accountId: 'local-default',
        catalog: billingCatalogFixture([]),
        gateway: gatewayFixture(),
        billing: store.billing,
        authorizeTask: () => false,
        projectExecutionTimeline: () => ({
          taskId: 'foreign-task',
          title: '不应泄露的任务',
          status: 'completed',
          stages: [],
        }),
      });
      runtime.subscribe('browser-a', () => undefined);
      await attachBrowser(runtime);
      await expect(runtime.getTaskBillingDetail('browser-a', 'foreign-task')).resolves.toBeNull();
    } finally {
      store.close();
    }
  });

  it('列出账户内没有 Query 计量记录的历史 Task', async () => {
    const store = createRuntimeBillingService();
    try {
      const runtime = new WebGatewaySessionRuntime({
        accountId: 'local-default',
        catalog: billingCatalogFixture([]),
        gateway: gatewayFixture(),
        billing: store.billing,
        listAccountTasks: () => [{ id: 'task_without_query', title: '历史无计量任务' }],
      });
      await expect(runtime.listBillingTasks()).resolves.toEqual([{
        taskId: 'task_without_query',
        taskTitle: '历史无计量任务',
        queryCount: 0,
      }]);
    } finally {
      store.close();
    }
  });
});
