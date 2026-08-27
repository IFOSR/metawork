import { createConnection, type Socket } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientGateway } from '../../src/gateway/client-gateway.js';
import type {
  GatewayCommand,
  GatewayCommandEnvelope,
} from '../../src/gateway/client-protocol.js';
import { ConversationGatewayRuntime } from '../../src/gateway/conversation-gateway-runtime.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { encodeJsonLine } from '../../src/gateway/jsonl.js';
import type { GatewayServerMessage } from '../../src/gateway/protocol.js';
import { MetaclawGatewayServer } from '../../src/gateway/server.js';
import { WebLaunchContextService } from '../../src/management/web-launch-context.js';
import { writeEndpointManifest } from '../../src/server/server-endpoint-manifest.js';
import type { AccountRuntimeHandle } from '../../src/account/account-runtime-ports.js';
import type { RuntimeRegistry } from '../../src/account/runtime-registry.js';
import { ConversationInputMailbox, type MailboxCommand } from '../../src/session/conversation-input-mailbox.js';
import { ConversationRegistry } from '../../src/session/conversation-registry.js';
import type { ConversationSession } from '../../src/session/conversation-session.js';
import {
  CONVERSATION_FORMAT_VERSION,
  type ConversationRecord,
} from '../../src/session/conversation-store.js';
import { FileConversationStore } from '../../src/session/file-conversation-store.js';
import {
  ConversationWorkspaceService,
  isAuthenticatedWorkspacePrincipalId,
  type WorkspaceCommandResult,
} from '../../src/workspace/conversation-workspace-service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('independent client lifecycle integration', () => {
  it('shares Conversation Workspace across Clients without creating a Server-global Workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-client-workspaces-'));
    roots.push(root);
    const repoA = join(root, 'repo-a');
    const repoB = join(root, 'repo-b');
    await Promise.all([
      mkdir(repoA),
      mkdir(repoB),
    ]);
    const socketPath = join(root, 'gateway.sock');
    const manifestPath = join(root, 'server-endpoint.json');
    const subscriptions = new GatewaySubscriptions();
    const journal = new FileEventJournal(join(root, 'events'));
    const workspaces = new Map<string, string>();
    const launches = new WebLaunchContextService({
      generateToken: () => 'opaque-web-launch-token',
    });

    const publish = async (
      conversationId: string,
      requestId: string | null,
      kind: 'workspace_changed' | 'final_answer',
      payload: unknown,
    ) => {
      const event = await journal.append({
        protocolVersion: 1,
        eventId: `event_${conversationId}_${kind}_${Date.now()}_${Math.random()}`,
        sequence: 0,
        accountId: 'local-default',
        conversationId,
        requestId,
        turnId: requestId ? `turn_${requestId}` : null,
        kind,
        payload,
        occurredAt: new Date().toISOString(),
      });
      subscriptions.publish(event);
    };
    const gateway = {
      handle: async (envelope: GatewayCommandEnvelope) => {
        const conversationId = envelope.conversation.mode === 'attach'
          ? envelope.conversation.conversationId
          : 'unknown';
        if (
          envelope.command.kind === 'slash_command'
          && envelope.command.text.startsWith('/workspace ')
        ) {
          const path = envelope.command.text.slice('/workspace '.length).trim();
          workspaces.set(conversationId, path);
          await publish(conversationId, envelope.requestId, 'workspace_changed', {
            workspace: {
              path,
              selectedAt: '2026-08-27T08:00:00.000Z',
            },
          });
        } else if (envelope.command.kind === 'user_message') {
          if (!workspaces.has(conversationId)) {
            return {
              requestId: envelope.requestId,
              idempotencyKey: envelope.idempotencyKey,
              status: 'rejected' as const,
              reason: 'workspace_required',
              conversationId,
            };
          }
          await publish(conversationId, envelope.requestId, 'final_answer', {
            lines: [`workspace:${workspaces.get(conversationId)}`],
          });
        }
        return {
          requestId: envelope.requestId,
          idempotencyKey: envelope.idempotencyKey,
          status: 'accepted' as const,
          conversationId,
        };
      },
    } as unknown as ClientGateway;
    const server = new MetaclawGatewayServer({
      socketPath,
      gateway,
      journal,
      subscriptions,
      authorizeAttach: async () => true,
      registerWebLaunch: async input => launches.issue(input),
    });
    await server.start();
    await writeEndpointManifest(manifestPath, {
      manifestVersion: 1,
      serverVersion: 'test',
      gatewayProtocolVersion: 1,
      pid: process.pid,
      startedAt: '2026-08-27T08:00:00.000Z',
      state: 'ready',
      unixSocketPath: socketPath,
      webOrigin: 'http://127.0.0.1:8788',
    });

    const tuiA = await connect(socketPath);
    const firstHello = await tuiA.next(message => message.type === 'hello');
    const sharedConversationId = firstHello.type === 'hello' ? firstHello.sessionId : '';
    tuiA.socket.write(input('workspace-a', sharedConversationId, `/workspace ${repoA}`));
    await expect(tuiA.next(message => (
      message.type === 'event' && message.event.kind === 'workspace_changed'
    ))).resolves.toMatchObject({
      event: {
        payload: { workspace: { path: repoA } },
      },
    });

    const tuiB = await connect(socketPath);
    await tuiB.next(message => message.type === 'hello');
    tuiB.socket.write(encodeJsonLine({
      type: 'attach',
      conversationId: sharedConversationId,
    }));
    await expect(tuiB.next(message => (
      message.type === 'event' && message.event.kind === 'workspace_changed'
    ))).resolves.toMatchObject({
      event: {
        payload: { workspace: { path: repoA } },
      },
    });

    const webControl = await connect(socketPath);
    await webControl.next(message => message.type === 'hello');
    webControl.socket.write(encodeJsonLine({
      type: 'register_web_launch',
      workspaceHint: repoB,
    }));
    const registered = await webControl.next(message => message.type === 'web_launch_registered');
    expect(registered).toMatchObject({
      type: 'web_launch_registered',
      token: 'opaque-web-launch-token',
    });
    expect(launches.consume('opaque-web-launch-token')).toMatchObject({
      workspaceHint: repoB,
    });
    const browserUrl = 'http://127.0.0.1:8788/#bootstrap=opaque-web-launch-token';
    expect(browserUrl).not.toContain(repoB);
    expect(browserUrl).not.toContain('workspace=');

    const webClient = await connect(socketPath);
    const webHello = await webClient.next(message => message.type === 'hello');
    const webConversationId = webHello.type === 'hello' ? webHello.sessionId : '';
    webClient.socket.write(input('workspace-web', webConversationId, `/workspace ${repoB}`));
    await webClient.next(message => (
      message.type === 'event' && message.event.kind === 'workspace_changed'
    ));
    expect(workspaces.get(webConversationId)).toBe(repoB);
    expect(workspaces.get(sharedConversationId)).toBe(repoA);

    tuiA.socket.write(input('workspace-switch', sharedConversationId, `/workspace ${repoB}`));
    const switched = (message: GatewayServerMessage) => (
      message.type === 'event'
      && message.event.kind === 'workspace_changed'
      && (message.event.payload as { workspace?: { path?: string } }).workspace?.path === repoB
    );
    await Promise.all([
      tuiA.next(switched),
      tuiB.next(switched),
    ]);

    tuiA.socket.destroy();
    tuiB.socket.destroy();
    webControl.socket.destroy();
    await Promise.all([
      waitForClose(tuiA.socket),
      waitForClose(tuiB.socket),
      waitForClose(webControl.socket),
    ]);

    webClient.socket.write(input('web-after-clients-exit', webConversationId, 'continue'));
    await expect(webClient.next(message => message.type === 'output')).resolves.toMatchObject({
      lines: [`workspace:${repoB}`],
    });
    const manifest = await readFile(manifestPath, 'utf8');
    expect(manifest).not.toContain(repoA);
    expect(manifest).not.toContain(repoB);

    webClient.socket.destroy();
    await waitForClose(webClient.socket);
    const healthClient = await connect(socketPath);
    await expect(healthClient.next(message => message.type === 'hello')).resolves.toMatchObject({
      type: 'hello',
    });
    healthClient.socket.destroy();
    await waitForClose(healthClient.socket);
    await server.stop();
  });

  it('keeps Server and the second Client alive when the first Client exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-independent-clients-'));
    roots.push(root);
    const socketPath = join(root, 'gateway.sock');
    const subscriptions = new GatewaySubscriptions();
    const journal = new FileEventJournal(join(root, 'events'));
    const workspaces = new Map<string, string>();
    const submitted: GatewayCommandEnvelope[] = [];

    const gateway = {
      handle: async (envelope: GatewayCommandEnvelope) => {
        submitted.push(envelope);
        const conversationId = envelope.conversation.mode === 'attach'
          ? envelope.conversation.conversationId
          : 'unknown';
        if (envelope.command.kind === 'slash_command'
          && envelope.command.text.startsWith('/workspace ')) {
          const workspace = envelope.command.text.slice('/workspace '.length).trim();
          workspaces.set(conversationId, workspace);
          publishSnapshot(conversationId, `workspace:${workspace}`);
        } else if (envelope.command.kind === 'user_message') {
          if (!workspaces.has(conversationId)) {
            return {
              requestId: envelope.requestId,
              idempotencyKey: envelope.idempotencyKey,
              status: 'rejected' as const,
              reason: 'workspace_required',
              conversationId,
            };
          }
          publishSnapshot(conversationId, `answer:${envelope.command.text}`);
        }
        return {
          requestId: envelope.requestId,
          idempotencyKey: envelope.idempotencyKey,
          status: 'accepted' as const,
          conversationId,
        };
      },
    } as unknown as ClientGateway;

    function publishSnapshot(conversationId: string, line: string): void {
      subscriptions.publish({
        protocolVersion: 1,
        eventId: `event_${conversationId}_${Date.now()}_${Math.random()}`,
        sequence: 0,
        accountId: 'local-default',
        conversationId,
        requestId: null,
        turnId: null,
        kind: 'conversation_snapshot',
        payload: { lines: [line], from: 0 },
        occurredAt: new Date().toISOString(),
      });
    }

    const server = new MetaclawGatewayServer({
      socketPath,
      gateway,
      journal,
      subscriptions,
      authorizeAttach: async () => true,
    });
    await server.start();

    const clientA = await connect(socketPath);
    const clientB = await connect(socketPath);
    const helloA = await clientA.next(message => message.type === 'hello');
    const helloB = await clientB.next(message => message.type === 'hello');
    const conversationA = helloA.type === 'hello' ? helloA.sessionId : '';
    const conversationB = helloB.type === 'hello' ? helloB.sessionId : '';

    expect(conversationA).not.toBe(conversationB);

    clientA.socket.write(input('A', conversationA, '/workspace /tmp/workspace-a'));
    clientB.socket.write(input('B', conversationB, '/workspace /tmp/workspace-b'));
    await clientA.next(message => message.type === 'output');
    await clientB.next(message => message.type === 'output');

    clientA.socket.write(input('A-task', conversationA, 'run task A'));
    clientB.socket.write(input('B-task', conversationB, 'run task B'));
    await clientA.next(message => message.type === 'output');
    await clientB.next(message => message.type === 'output');
    expect(workspaces).toEqual(new Map([
      [conversationA, '/tmp/workspace-a'],
      [conversationB, '/tmp/workspace-b'],
    ]));

    clientA.socket.destroy();
    await waitForClose(clientA.socket);

    clientB.socket.write(input('B-after-a-exit', conversationB, 'run task B again'));
    await clientB.next(message => message.type === 'output');
    expect(submitted.at(-1)?.conversation).toEqual({
      mode: 'attach',
      conversationId: conversationB,
    });

    clientB.socket.destroy();
    await waitForClose(clientB.socket);

    const clientC = await connect(socketPath);
    await expect(clientC.next(message => message.type === 'hello')).resolves.toMatchObject({
      type: 'hello',
    });
    clientC.socket.destroy();
    await waitForClose(clientC.socket);
    await server.stop();
  });

  it('enforces Conversation-scoped defaults through the real Gateway completion path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-real-client-workspaces-'));
    roots.push(root);
    const repoA = join(root, 'repo-a');
    const repoB = join(root, 'repo-b');
    await Promise.all([mkdir(repoA), mkdir(repoB)]);
    const canonicalRepoA = await realpath(repoA);
    const canonicalRepoB = await realpath(repoB);
    const socketPath = join(root, 'gateway.sock');
    const manifestPath = join(root, 'server-endpoint.json');
    const store = new FileConversationStore(join(root, 'conversations'));
    await store.initialize();
    const journal = new FileEventJournal(join(root, 'events'));
    const subscriptions = new GatewaySubscriptions();
    const conversations = new ConversationRegistry();
    const accountHandle = {
      accountId: 'local-default',
      getConversationPort: () => null as never,
      initialize: async () => undefined,
      attachClient: () => undefined,
      detachClient: () => undefined,
      beginWork: () => undefined,
      endWork: () => undefined,
      closeWhenIdle: async () => 'closed' as const,
    } satisfies AccountRuntimeHandle;
    const registry = {
      getOrActivate: async () => accountHandle,
      getIfLoaded: () => accountHandle,
    } as unknown as RuntimeRegistry;
    const runtime = new ConversationGatewayRuntime({
      accountId: 'local-default',
      registry,
      conversations,
      conversationFactory: async conversationId => {
        await ensureConversation(store, conversationId);
        return new WorkspaceConversationHarness(
          conversationId,
          new ConversationWorkspaceService({
            store,
            conversationId,
            principalId: 'unknown',
            authorize: async (_path, principalId) => (
              isAuthenticatedWorkspacePrincipalId(principalId)
            ),
            isBusy: () => false,
            now: () => '2026-08-27T10:00:00.000Z',
          }),
        ) as unknown as ConversationSession;
      },
      journal,
      subscriptions,
      createId: prefix => `${prefix}_${Math.random().toString(36).slice(2)}`,
    });
    const gateway = new ClientGateway({
      authenticator: {
        authenticate: async ({ transport }) => transport === 'local'
          ? { kind: 'local', id: 'local-installation' }
          : null,
      },
      accountResolver: {
        resolve: async principal => principal.kind === 'local'
          ? { status: 'authorized', accountId: 'local-default' }
          : { status: 'denied', reason: 'unsupported principal' },
      },
      conversationResolver: {
        resolve: async (_accountId, selection) => selection.mode === 'attach'
          ? { status: 'resolved', conversationId: selection.conversationId }
          : { status: 'denied', reason: 'test requires an attached Conversation' },
      },
      activateAccount: accountId => runtime.activateAccount(accountId).then(() => undefined),
      submitToConversation: (
        conversationId,
        requestId,
        idempotencyKey,
        command,
        principalId,
      ) => runtime.submit(
        conversationId,
        requestId,
        idempotencyKey,
        command,
        principalId,
      ),
    });
    const server = new MetaclawGatewayServer({
      socketPath,
      gateway,
      journal,
      subscriptions,
      authorizeAttach: async () => true,
      attachClient: (_accountId, conversationId) => runtime.attachClient(conversationId),
    });
    await server.start();
    await writeEndpointManifest(manifestPath, {
      manifestVersion: 1,
      serverVersion: 'test',
      gatewayProtocolVersion: 1,
      pid: process.pid,
      startedAt: '2026-08-27T10:00:00.000Z',
      state: 'ready',
      unixSocketPath: socketPath,
      webOrigin: 'http://127.0.0.1:8788',
    });

    const clientA = await connect(socketPath);
    const helloA = await nextWithin(clientA, message => message.type === 'hello', 'client A hello');
    const sharedConversationId = helloA.type === 'hello' ? helloA.sessionId : '';
    clientA.socket.write(command(
      'default-a',
      sharedConversationId,
      workspaceDefault(repoA),
    ));
    await expect(nextWithin(clientA, receiptFor('default-a'), 'default A receipt')).resolves.toMatchObject({
      receipt: { status: 'accepted', conversationId: sharedConversationId },
    });

    const clientB = await connect(socketPath);
    await nextWithin(clientB, message => message.type === 'hello', 'client B hello');
    clientB.socket.write(encodeJsonLine({
      type: 'attach',
      conversationId: sharedConversationId,
    }));
    await nextWithin(clientB, message => (
      message.type === 'event'
      && message.event.conversationId === sharedConversationId
      && workspacePath(message) === canonicalRepoA
    ), 'client B Workspace replay');
    clientB.socket.write(command(
      'default-b',
      sharedConversationId,
      workspaceDefault(repoB),
    ));
    await expect(nextWithin(clientB, receiptFor('default-b'), 'default B receipt')).resolves.toMatchObject({
      receipt: { status: 'accepted', conversationId: sharedConversationId },
    });
    expect((await store.readConversation(sharedConversationId))?.conversation.workspace?.path)
      .toBe(canonicalRepoA);
    const afterDefaults = await journal.replay('local-default', sharedConversationId);
    expect([...afterDefaults.snapshot, ...afterDefaults.deltas]
      .filter(event => event.kind === 'workspace_changed')).toHaveLength(1);

    clientA.socket.write(command(
      'explicit-switch',
      sharedConversationId,
      { kind: 'slash_command', text: `/workspace ${repoB}` },
    ));
    const switched = (message: GatewayServerMessage) => (
      message.type === 'event'
      && message.event.kind === 'workspace_changed'
      && workspacePath(message) === canonicalRepoB
    );
    await Promise.all([
      nextWithin(clientA, switched, 'client A explicit switch broadcast'),
      nextWithin(clientB, switched, 'client B explicit switch broadcast'),
    ]);
    expect((await store.readConversation(sharedConversationId))?.conversation.workspace?.path)
      .toBe(canonicalRepoB);

    const separateClient = await connect(socketPath);
    const separateHello = await nextWithin(
      separateClient,
      message => message.type === 'hello',
      'separate client hello',
    );
    const separateConversationId = separateHello.type === 'hello'
      ? separateHello.sessionId
      : '';
    separateClient.socket.write(command(
      'separate-default',
      separateConversationId,
      workspaceDefault(repoA),
    ));
    await expect(nextWithin(
      separateClient,
      receiptFor('separate-default'),
      'separate default receipt',
    )).resolves.toMatchObject({
      receipt: { status: 'accepted', conversationId: separateConversationId },
    });
    expect((await store.readConversation(separateConversationId))?.conversation.workspace?.path)
      .toBe(canonicalRepoA);
    expect((await store.readConversation(sharedConversationId))?.conversation.workspace?.path)
      .toBe(canonicalRepoB);

    const manifest = await readFile(manifestPath, 'utf8');
    expect(manifest).not.toContain(repoA);
    expect(manifest).not.toContain(repoB);
    expect(manifest).not.toContain(canonicalRepoA);
    expect(manifest).not.toContain(canonicalRepoB);

    clientA.socket.destroy();
    clientB.socket.destroy();
    separateClient.socket.destroy();
    await Promise.all([
      waitForClose(clientA.socket),
      waitForClose(clientB.socket),
      waitForClose(separateClient.socket),
    ]);
    const healthClient = await connect(socketPath);
    await expect(nextWithin(
      healthClient,
      message => message.type === 'hello',
      'health client hello',
    )).resolves.toMatchObject({
      type: 'hello',
    });
    healthClient.socket.destroy();
    await waitForClose(healthClient.socket);
    await server.stop();
  });

  function input(requestId: string, conversationId: string, text: string): string {
    return encodeJsonLine({
      type: 'input',
      requestId,
      idempotencyKey: `idem_${requestId}`,
      conversationId,
      text,
    });
  }
});

class WorkspaceConversationHarness {
  readonly output: string[] = [];
  private readonly mailbox = new ConversationInputMailbox({ execute: async () => undefined });
  private attachedClients = 0;

  constructor(
    readonly conversationId: string,
    private readonly workspace: ConversationWorkspaceService,
  ) {}

  bindMailboxExecutor(execute: (command: MailboxCommand) => Promise<void>): void {
    this.mailbox.bindExecutor(execute);
  }

  submitCommand(command: MailboxCommand) {
    return this.mailbox.submit(command);
  }

  async executeGatewayCommand(
    command: GatewayCommand,
    options: { principalId?: string } = {},
  ): Promise<WorkspaceCommandResult | void> {
    if (command.kind === 'slash_command' && /^\/workspace(?:\s|$)/u.test(command.text)) {
      const result = command.workspaceMutation === 'initialize_if_unset'
        ? await this.workspace.initializeDefault(
            command.text.slice('/workspace'.length).trim(),
            options.principalId,
          )
        : await this.workspace.execute(command.text, options.principalId);
      if (result.status === 'rejected') throw workspaceFailure(result.code, result.message);
      this.output.push(`Workspace 已设置为: ${result.workspace.path}`);
      return result;
    }
    if (command.kind === 'user_message') {
      const workspace = await this.workspace.getWorkspace();
      if (!workspace) throw workspaceFailure('workspace_required', 'Workspace 未设置');
      this.output.push(`workspace:${workspace.path}`);
    }
  }

  getOutput(): string[] {
    return [...this.output];
  }

  getResultDeliveries(): [] {
    return [];
  }

  getWorkspace() {
    return this.workspace.getWorkspace();
  }

  subscribe(): () => void {
    return () => undefined;
  }

  subscribeInteractionTrace(): () => void {
    return () => undefined;
  }

  attachClient(): void {
    this.attachedClients += 1;
  }

  detachClient(): void {
    this.attachedClients = Math.max(0, this.attachedClients - 1);
  }
}

async function ensureConversation(
  store: FileConversationStore,
  conversationId: string,
): Promise<void> {
  if (await store.readConversation(conversationId)) return;
  const record: ConversationRecord = {
    version: CONVERSATION_FORMAT_VERSION,
    conversation: {
      id: conversationId,
      plannerSessionId: conversationId,
      accountId: 'local-default',
      title: 'Integration conversation',
      createdAt: '2026-08-27T10:00:00.000Z',
      updatedAt: '2026-08-27T10:00:00.000Z',
      archived: false,
      workspace: null,
    },
    turns: [],
  };
  await store.writeConversation(record);
  const catalog = await store.readCatalog();
  await store.writeCatalog({
    ...catalog,
    conversations: [
      ...catalog.conversations.filter(item => item.id !== conversationId),
      record.conversation,
    ],
  });
}

function workspaceDefault(path: string): GatewayCommand {
  return {
    kind: 'slash_command',
    text: `/workspace ${path}`,
    workspaceMutation: 'initialize_if_unset',
  };
}

function command(
  requestId: string,
  conversationId: string,
  gatewayCommand: GatewayCommand,
): string {
  return encodeJsonLine({
    type: 'command',
    envelope: {
      protocolVersion: 1,
      requestId,
      idempotencyKey: `idem_${requestId}`,
      connectionId: `connection_${requestId}`,
      conversation: { mode: 'attach', conversationId },
      command: gatewayCommand,
      clientCapabilities: ['trace_v1'],
    },
  });
}

function receiptFor(requestId: string) {
  return (message: GatewayServerMessage) => (
    message.type === 'receipt' && message.receipt.requestId === requestId
  );
}

function workspacePath(message: GatewayServerMessage): string | null {
  if (message.type !== 'event') return null;
  const payload = message.event.payload as { workspace?: { path?: unknown } };
  return typeof payload.workspace?.path === 'string' ? payload.workspace.path : null;
}

function workspaceFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function connect(socketPath: string): Promise<{
  socket: Socket;
  seen: GatewayServerMessage[];
  next(predicate: (message: GatewayServerMessage) => boolean): Promise<GatewayServerMessage>;
}> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const queued: GatewayServerMessage[] = [];
  const seen: GatewayServerMessage[] = [];
  const waiters: Array<{
    predicate: (message: GatewayServerMessage) => boolean;
    resolve: (message: GatewayServerMessage) => void;
  }> = [];
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as GatewayServerMessage;
      seen.push(message);
      const waiterIndex = waiters.findIndex(waiter => waiter.predicate(message));
      if (waiterIndex >= 0) {
        waiters.splice(waiterIndex, 1)[0]!.resolve(message);
      } else {
        queued.push(message);
      }
    }
  });
  return {
    socket,
    seen,
    next(predicate) {
      const queuedIndex = queued.findIndex(predicate);
      if (queuedIndex >= 0) return Promise.resolve(queued.splice(queuedIndex, 1)[0]!);
      return new Promise(resolve => waiters.push({ predicate, resolve }));
    },
  };
}

async function nextWithin(
  client: Awaited<ReturnType<typeof connect>>,
  predicate: (message: GatewayServerMessage) => boolean,
  stage: string,
  timeoutMs = 2_000,
): Promise<GatewayServerMessage> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      client.next(predicate),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Gateway test timed out: ${stage}; seen=${JSON.stringify(client.seen.slice(-12))}`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>(resolve => socket.once('close', () => resolve()));
}
