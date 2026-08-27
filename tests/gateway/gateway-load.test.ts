import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  gatewayEventPayloadBytes,
  MAX_GATEWAY_EVENT_PAYLOAD_BYTES,
  type GatewayEventEnvelope,
} from '../../src/gateway/client-events.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { WorkspaceGatewayRuntime } from '../../src/gateway/workspace-gateway-runtime.js';
import { ConversationInputMailbox } from '../../src/session/conversation-input-mailbox.js';
import { WorkspaceDirectoryService } from '../../src/workspace/workspace-directory-service.js';

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe('gateway load bounds', () => {
  it('bounds the conversation mailbox and rejects overflow', () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const mailbox = new ConversationInputMailbox({
      execute: async () => { await gate; },
      maxQueueSize: 2,
    });

    mailbox.submit({ requestId: 'req_1', idempotencyKey: 'idem_1' });
    mailbox.submit({ requestId: 'req_2', idempotencyKey: 'idem_2' });
    const rejected = mailbox.submit({ requestId: 'req_3', idempotencyKey: 'idem_3' });

    expect(rejected.status).toBe('rejected');
    expect(rejected.reason).toBe('busy');
    release!();
  });

  it('retains a bounded event journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'load-journal-'));
    roots.push(root);
    const journal = new FileEventJournal(join(root, 'journal'));

    // 追加超过保留上限的事件。
    for (let index = 0; index < 250; index += 1) {
      await journal.append({
        protocolVersion: 1,
        eventId: `evt_${index}`,
        sequence: 0,
        accountId: 'local-default',
        conversationId: 'conv_1',
        requestId: null,
        turnId: null,
        kind: 'trace_delta',
        payload: {},
        occurredAt: '2026-08-18T00:00:00.000Z',
      });
    }

    const replay = await journal.replay('local-default', 'conv_1');
    // 保留上限为 200。
    expect(replay.deltas.length).toBeLessThanOrEqual(200);
  });

  it('returns a bounded Workspace snapshot for stale cursors after compaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-load-journal-'));
    roots.push(root);
    const journal = new FileEventJournal(join(root, 'journal'));
    await journal.append(workspaceEvent(0, 'workspace_directory_snapshot', {
      workspaceId: 'workspace_repo',
      workspace: {
        id: 'workspace_repo',
        accountId: 'local-default',
        displayName: 'repo',
        canonicalPath: '/private/repo',
        availability: 'available',
        archived: false,
      },
      page: {
        items: [],
        nextCursor: null,
      },
    }));
    for (let index = 1; index <= 248; index += 1) {
      await journal.append(workspaceEvent(index, 'workspace_activity_changed', {
        workspaceId: 'workspace_repo',
        conversationId: `conv_noise_${index}`,
        activity: {
          state: 'planning',
          taskId: `task_noise_${index}`,
          updatedAt: `2026-08-27T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        },
      }));
    }
    await journal.append(workspaceEvent(249, 'workspace_activity_changed', {
      workspaceId: 'workspace_repo',
      conversationId: 'conv_executing',
      activity: {
        state: 'executing',
        taskId: 'task_running',
        updatedAt: '2026-08-27T01:00:00.000Z',
      },
    }));
    await journal.append(workspaceEvent(250, 'workspace_activity_changed', {
      workspaceId: 'workspace_repo',
      conversationId: 'conv_blocked',
      activity: {
        state: 'blocked',
        taskId: 'task_blocked',
        updatedAt: '2026-08-27T01:01:00.000Z',
      },
    }));

    const replay = await journal.replay('local-default', 'conv_workspace_repo', 0);
    expect(replay.snapshot.some(event => event.kind === 'workspace_directory_snapshot'))
      .toBe(true);
    expect(replay.snapshot).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'workspace_activity_changed',
        payload: expect.objectContaining({
          conversationId: 'conv_executing',
          activity: expect.objectContaining({ state: 'executing' }),
        }),
      }),
      expect.objectContaining({
        kind: 'workspace_activity_changed',
        payload: expect.objectContaining({
          conversationId: 'conv_blocked',
          activity: expect.objectContaining({ state: 'blocked' }),
        }),
      }),
    ]));
    expect(replay.snapshot.every(event => (
      gatewayEventPayloadBytes(event.payload) <= MAX_GATEWAY_EVENT_PAYLOAD_BYTES
    ))).toBe(true);
    expect(replay.snapshot.filter(event => event.kind === 'workspace_activity_changed'))
      .toHaveLength(100);
  });

  it('bounds a 1000-Conversation Workspace page and publication payload', async () => {
    const workspace = {
      id: 'workspace_repo',
      accountId: 'local-default',
      displayName: 'repo',
      canonicalPath: '/private/repo',
      availability: 'available' as const,
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
      createdByPrincipal: 'local:local-installation',
      archived: false,
    };
    const conversations = Array.from({ length: 1000 }, (_, index) => ({
      id: `conv_${index}`,
      plannerSessionId: `conv_${index}`,
      accountId: 'local-default',
      title: `Task ${index} ${'long title '.repeat(300)}`,
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: `2026-08-27T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
      archived: false,
      workspaceBinding: {
        workspaceId: workspace.id,
        boundAt: '2026-08-27T00:00:00.000Z',
        boundByPrincipal: 'local:local-installation',
      },
    }));
    const directory = new WorkspaceDirectoryService({
      accountId: 'local-default',
      workspaceCatalog: {
        initialize: async () => undefined,
        readCatalog: async () => ({ version: 1 as const, workspaces: [workspace] }),
        writeCatalog: async () => undefined,
        findById: async id => id === workspace.id ? workspace : null,
        findByCanonicalPath: async () => workspace,
      },
      conversationStore: {
        initialize: async () => undefined,
        readCatalog: async () => ({ version: 3 as const, conversations }),
        writeCatalog: async () => undefined,
        readConversation: async () => null,
        writeConversation: async () => undefined,
      },
      authorize: () => true,
    });
    const published: unknown[] = [];
    const runtime = new WorkspaceGatewayRuntime(directory, {
      publish: async (_kind, _workspaceId, payload) => {
        published.push(payload);
      },
    });

    await runtime.activateWorkspace(
      'conn_load',
      workspace.id,
      'local:local-installation',
    );

    const payload = published[0] as {
      page: { items: unknown[]; nextCursor: string | null };
    };
    expect(payload.page.items).toHaveLength(50);
    expect(payload.page.nextCursor).not.toBeNull();
    expect(gatewayEventPayloadBytes(payload)).toBeLessThanOrEqual(
      MAX_GATEWAY_EVENT_PAYLOAD_BYTES,
    );
  });
});

function workspaceEvent(
  index: number,
  kind: GatewayEventEnvelope['kind'],
  payload: unknown,
): GatewayEventEnvelope {
  return {
    protocolVersion: 2,
    eventId: `workspace_evt_${index}`,
    sequence: 0,
    accountId: 'local-default',
    conversationId: 'conv_workspace_repo',
    requestId: null,
    turnId: null,
    kind,
    payload,
    occurredAt: '2026-08-27T00:00:00.000Z',
  };
}
