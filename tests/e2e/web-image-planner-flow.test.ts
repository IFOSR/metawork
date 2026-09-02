import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AccountRuntimeHandle } from '../../src/account/account-runtime-ports.js';
import { ConversationGatewayRuntime } from '../../src/gateway/conversation-gateway-runtime.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { WebGatewayAdapter } from '../../src/management/web-gateway-adapter.js';
import { WebGatewaySessionRuntime } from '../../src/management/web-gateway-session-runtime.js';
import { AnyFusionPlanningAgent } from '../../src/planning/anyfusion-planning-agent.js';
import { PlannerProcessSupervisor } from '../../src/planning/planner-process-supervisor.js';
import { ConversationInputMailbox } from '../../src/session/conversation-input-mailbox.js';
import { ConversationRegistry } from '../../src/session/conversation-registry.js';
import { ConversationSession } from '../../src/session/conversation-session.js';
import type { ConversationRuntimePort } from '../../src/session/conversation-runtime-port.js';
import { FileAttachmentStore } from '../../src/storage/file-attachment-store.js';
import type { WebSessionRuntimeCatalog } from '../../src/management/web-session-runtime-types.js';
import type { WebSessionRecord } from '../../src/management/web-session-types.js';

interface FakePlannerProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

describe('Web image to Planner end-to-end path', () => {
  it('submits a large uploaded image through Web, Gateway, Session, and Planner RPC', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-e2e-image-'));
    const attachmentStore = new FileAttachmentStore(join(root, 'attachments'));
    await attachmentStore.initialize();

    const imageBytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.alloc(10 * 1024 * 1024 + 1, 0x5a),
    ]);
    const image = await attachmentStore.saveAttachment({
      sessionId: 'conv_e2e_image',
      name: 'large-screenshot.jpg',
      bytes: imageBytes,
    });

    let promptImageData = '';
    const plannerProcess = largeImagePlannerProcess(data => {
      promptImageData = data;
    });
    const plannerSupervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      plannerHome: join(root, 'planner-home'),
      sessionDir: join(root, 'planner-sessions'),
      expectedModel: { provider: 'deepseek', modelId: 'deepseek-v4-pro' },
      spawn: (() => plannerProcess as never) as never,
    });
    const realPlanningAgent = new AnyFusionPlanningAgent({ runner: plannerSupervisor });
    const planningCalls: string[] = [];
    const planningAgent = {
      plan: realPlanningAgent.plan.bind(realPlanningAgent),
      submit: async (...args: Parameters<AnyFusionPlanningAgent['submit']>) => {
        planningCalls.push('submit');
        return realPlanningAgent.submit(...args);
      },
    };

    const conversations = new ConversationRegistry();
    const fileJournal = new FileEventJournal(join(root, 'gateway-events'));
    const journalKinds: string[] = [];
    const journal = {
      append: async (event: Parameters<FileEventJournal['append']>[0]) => {
        journalKinds.push(event.kind);
        return fileJournal.append(event);
      },
      replay: (...args: Parameters<FileEventJournal['replay']>) => fileJournal.replay(...args),
    };
    const subscriptions = new GatewaySubscriptions();
    const gatewayCalls: string[] = [];
    let completion: Promise<unknown> | null = null;
    const accountRuntime = {
      accountId: 'local-default',
      getConversationPort: () => ({}),
      initialize: async () => undefined,
      attachClient: () => undefined,
      detachClient: () => undefined,
      beginWork: () => undefined,
      endWork: () => undefined,
      closeWhenIdle: async () => 'closed' as const,
    } satisfies AccountRuntimeHandle;
    const runtimeRegistry = {
      getOrActivate: async () => accountRuntime,
      getIfLoaded: () => accountRuntime,
    };
    const runtimePort = {
      accountId: 'local-default',
      planning: planningAgent,
      permissions: null,
      queries: {
        findOldestPendingPermission: () => null,
      },
      commands: {},
      execution: null,
    } as unknown as ConversationRuntimePort;
    const gatewayRuntime = new ConversationGatewayRuntime({
      accountId: 'local-default',
      registry: runtimeRegistry as never,
      conversations,
      conversationFactory: conversationId => new ConversationSession({
        conversationId,
        plannerSessionId: `planner_${conversationId}`,
        runtimePort,
        mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
        planningContextBuilder: {
          build: (input: { userInput: string; images?: unknown }) => ({
            userInput: input.userInput,
            images: input.images,
            request: { sessionId: `planner_${conversationId}`, source: 'gateway' },
            pendingAuthorizationRequest: null,
            configuration: {
              revisionId: 'revision-test',
              contentHash: 'hash',
              models: [],
              routingCatalog: {
                configurationRevision: 'revision-test',
                agentClasses: [],
              },
            },
            timeoutMs: 10_000,
          }),
        } as never,
      }),
      journal,
      subscriptions,
      attachments: attachmentStore,
      createId: prefix => `${prefix}_e2e`,
    });
    const webAdapter = new WebGatewayAdapter({
      gateway: {
        handle: async envelope => {
          gatewayCalls.push('handle');
          const conversationId = envelope.scope.kind === 'conversation'
            && envelope.scope.selection.mode === 'attach'
            ? envelope.scope.selection.conversationId
            : 'conv_e2e_image';
          const receipt = await gatewayRuntime.submit(
            conversationId,
            envelope.requestId,
            envelope.idempotencyKey,
            envelope.command,
          );
          completion = receipt.completion;
          return receipt as never;
        },
      } as never,
      journal,
      subscriptions,
      attachClient: (_accountId, conversationId) => gatewayRuntime.attachClient(conversationId),
    });
    const webRuntime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway: webAdapter,
      attachments: attachmentStore,
      createId: prefix => `${prefix}_e2e`,
    });

    try {
      await webRuntime.initializeClient('browser-a', {
        workspaceHint: '/repo',
        conversationId: 'conv_e2e_image',
      });
      await webRuntime.submit('browser-a', '请分析这张截图', [{
        attachmentId: image.attachmentId,
        kind: 'image',
      }]);
      expect(completion).not.toBeNull();
      await expect(completion).resolves.toEqual({ status: 'completed' });
      expect(gatewayCalls).toEqual(['handle']);
      expect(planningCalls).toEqual(['submit']);
      expect(Buffer.from(promptImageData, 'base64')).toEqual(imageBytes);
      expect(journalKinds).toContain('final_answer');
      expect(journalKinds).not.toContain('terminal_error');
    } finally {
      await webRuntime.dispose();
      gatewayRuntime.closeAdmission();
      await gatewayRuntime.drain();
      await conversations.closeAll();
      await plannerSupervisor.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function largeImagePlannerProcess(onPromptImage: (data: string) => void): FakePlannerProcess {
  const child = new EventEmitter() as FakePlannerProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    queueMicrotask(() => {
      child.emit('exit', null, 'SIGTERM');
      child.emit('close', null, 'SIGTERM');
    });
    return true;
  });

  let inputBuffer = '';
  child.stdin.on('data', chunk => {
    inputBuffer += chunk.toString();
    let newline = inputBuffer.indexOf('\n');
    while (newline >= 0) {
      const command = JSON.parse(inputBuffer.slice(0, newline)) as {
        id: string;
        type: string;
        images?: Array<{ data: string }>;
      };
      inputBuffer = inputBuffer.slice(newline + 1);
      if (command.type === 'get_state') {
        child.stdout.write(`${JSON.stringify({
          type: 'response',
          command: 'get_state',
          success: true,
          id: command.id,
          data: { model: { provider: 'deepseek', id: 'deepseek-v4-pro' } },
        })}\n`);
      } else if (command.type === 'prompt') {
        const data = command.images?.[0]?.data ?? '';
        onPromptImage(data);
        child.stdout.write(`${JSON.stringify({
          type: 'message_start',
          message: {
            role: 'user',
            content: [{ type: 'image', data: '', mimeType: 'image/jpeg' }],
          },
        })}\n`);
        child.stdout.write(`${JSON.stringify({
          type: 'response',
          command: 'prompt',
          success: true,
          id: command.id,
        })}\n`);
        child.stdout.write(`${JSON.stringify({
          type: 'tool_execution_start',
          toolCallId: 'tool-e2e-image',
          toolName: 'submit_planning_proposal',
          args: { plan: { id: 'plan-e2e-image', schemaVersion: 8 } },
        })}\n`);
        child.stdout.write(`${JSON.stringify({
          type: 'tool_execution_end',
          toolCallId: 'tool-e2e-image',
          toolName: 'submit_planning_proposal',
          result: {
            details: {
              status: 'accepted',
              turnId: 'turn-e2e-image',
              submissionId: 'submission-e2e-image',
              planId: 'plan-e2e-image',
              outcome: 'proposal_validated',
              displayText: 'validated',
              taskId: null,
              kernel: null,
            },
          },
          isError: false,
        })}\n`);
        child.stdout.write(`${JSON.stringify({ type: 'agent_end', messages: [] })}\n`);
      }
      newline = inputBuffer.indexOf('\n');
    }
  });
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
  return child;
}

function catalogFixture(): WebSessionRuntimeCatalog {
  const record: WebSessionRecord = {
    version: 1,
    session: {
      id: 'conv_e2e_image',
      title: 'Image E2E',
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
      active: true,
      archived: false,
      workspaceId: 'workspace_repo',
      workspace: null,
    },
    turns: [],
  };
  return {
    initialize: async () => undefined,
    create: async () => record,
    list: async () => [{
      ...record.session,
      workspaceId: 'workspace_repo',
      workspace: null,
    }],
    search: async () => [{
      ...record.session,
      workspaceId: 'workspace_repo',
      workspace: null,
    }],
    read: async () => record,
    workspaceIdForConversation: async () => 'workspace_repo',
    listWorkspaces: async () => [{
      id: 'workspace_repo',
      accountId: 'local-default',
      displayName: 'repo',
      canonicalPath: '/repo',
      availability: 'available',
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
      createdByPrincipal: 'web:browser-a',
      archived: false,
    }],
    archive: async () => true,
    clearWorkspace: async () => 0,
    setActive: async () => record,
    appendTurn: async () => record,
  };
}
