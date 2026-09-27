import Database from 'better-sqlite3';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { runMigrations } from '../../src/storage/migrations.js';
import { FileConversationStore } from '../../src/session/file-conversation-store.js';
import { FileConversationPresentationStore } from '../../src/storage/file-conversation-presentation-store.js';
import { FileWorkspaceCatalogStore } from '../../src/storage/file-workspace-catalog-store.js';
import { SqliteWorkspaceDirectoryProjectionRepo } from '../../src/storage/workspace-directory-projection-repo.js';
import { WorkspaceDirectoryProjector } from '../../src/workspace/workspace-directory-projector.js';
import { WorkspaceDirectoryService } from '../../src/workspace/workspace-directory-service.js';
import { WorkspaceGatewayRuntime } from '../../src/gateway/workspace-gateway-runtime.js';
import { ClientGateway } from '../../src/gateway/client-gateway.js';
import { SqliteCommandAdmissionStore } from '../../src/storage/command-admission-repo.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { SegmentedEventJournal } from '../../src/gateway/segmented-event-journal.js';
import { SqliteEventJournalSegmentIndex } from '../../src/storage/event-journal-segment-index-repo.js';
import { SqliteConversationHistoryRepo } from '../../src/storage/conversation-history-repo.js';
import { SqliteConversationMetadataIndex } from '../../src/storage/conversation-metadata-index-repo.js';
import { AgentInstallationReadinessService } from '../../src/management/agent-installation-readiness-service.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { WebSessionCatalog } from '../../src/management/web-session-catalog.js';
import { WebGatewaySessionRuntime } from '../../src/management/web-gateway-session-runtime.js';
import type { WebGatewayAdapter } from '../../src/management/web-gateway-adapter.js';
import { ManagementServer } from '../../src/management/server.js';
import { WebAuthService } from '../../src/management/web-auth.js';
import { WebLaunchContextService } from '../../src/management/web-launch-context.js';
import { WorkspaceDirectoryBrowser } from '../../src/management/workspace-directory-browser.js';
import { resolveLoginCredentials } from '../../src/management/login-credentials.js';
import type { ConversationMetadata } from '../../src/session/conversation-store.js';
import type { GatewayCommandEnvelope } from '../../src/gateway/client-protocol.js';
import type { ConversationTurn } from '../../src/management/web-session-types.js';
import type { ConversationActivityProjection } from '../../src/workspace/conversation-activity-projector.js';
import { workspaceEventStreamId } from '../../src/gateway/workspace-event-stream.js';

/** Real navigation/persistence/HTTP/WS stack; execution is deliberately unavailable.
 * Never reads configuration, credentials or data from the user's installation.
 */
export async function createNavigationPerformanceFixture(webDistDir = resolve('web/dist')) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'metawork-navigation-')));
  const accountId = 'local-default';
  const db = new Database(join(root, 'fixture.db'));
  runMigrations(db);
  const projection = new SqliteWorkspaceDirectoryProjectionRepo(db, accountId);
  let projector: WorkspaceDirectoryProjector | null = null;
  const presentations = new FileConversationPresentationStore(join(root, 'presentations'),
    new SqliteConversationHistoryRepo(db, accountId, 'presentation'));
  const conversations = new FileConversationStore(join(root, 'conversations'), {
    onMetadataCommitted: metadata => projector?.observeMetadata(metadata),
    history: new SqliteConversationHistoryRepo(db, accountId, 'conversation'),
    metadataIndex: new SqliteConversationMetadataIndex(db, accountId),
    readLegacyHistory: async conversationId => (await presentations.read(conversationId))?.turns.map(turn => ({
      id: turn.id, conversationId, userInput: turn.userInput, finalAnswer: turn.finalAnswer, status: turn.status,
    })) ?? [],
  });
  const workspaces = new FileWorkspaceCatalogStore(join(root, 'workspaces'));
  await Promise.all([conversations.initialize(), presentations.initialize(), workspaces.initialize()]);
  const directory = new WorkspaceDirectoryService({
    accountId, conversationStore: conversations, workspaceCatalog: workspaces, projection,
    authorize: path => path.startsWith(`${root}/`),
  });
  const subscriptions = new GatewaySubscriptions();
  const legacyJournal = new FileEventJournal(join(root, 'journal'));
  const journal = new SegmentedEventJournal(join(root, 'journal'), new SqliteEventJournalSegmentIndex(db), legacyJournal);
  const timestamp = '2026-09-26T00:00:00.000Z';
  const metadata: ConversationMetadata[] = [];
  const selected = [];
  for (const [workspaceIndex, count] of [1, 40, 100].entries()) {
    const path = join(root, `workspace-${workspaceIndex + 1}`);
    await mkdir(path);
    const selection = await directory.selectByPath(path, 'fixture');
    selected.push(selection.workspace);
    for (let index = 0; index < count; index += 1) {
      const id = `conv_${workspaceIndex}_${String(index).padStart(3, '0')}`;
      const item: ConversationMetadata = {
        id, plannerSessionId: id, accountId, title: `History ${workspaceIndex + 1}/${index + 1}`,
        createdAt: timestamp, updatedAt: timestamp, archived: false,
        workspaceBinding: { workspaceId: selection.workspace.id, boundAt: timestamp, boundByPrincipal: 'fixture' },
      };
      metadata.push(item);
      await conversations.writeConversation({ version: 3, conversation: item, turns: [] });
      if (index === 0) {
        const turns: ConversationTurn[] = [{
          id: `turn_${id}`, sessionId: id, userInput: `Question in Workspace ${workspaceIndex + 1}`,
          status: 'completed', finalAnswer: `Conclusion for Workspace ${workspaceIndex + 1}`,
          taskId: null, startedAt: timestamp, completedAt: timestamp,
          traceEvents: [], executionTimeline: null, artifactRefs: [], artifacts: [],
        }];
        await presentations.write({ version: 1, conversationId: id, turns });
      }
      if (workspaceIndex === 2 && index === 1) {
        const turns: ConversationTurn[] = Array.from({ length: 45 }, (_, n) => ({
          id: `large_turn_${n}`, sessionId: id, userInput: `Historical question ${n}`,
          status: 'completed', finalAnswer: `Historical conclusion ${n}\n${'detail '.repeat(2_100)}`,
          taskId: null, startedAt: new Date(Date.parse(timestamp) + n * 1000).toISOString(),
          completedAt: new Date(Date.parse(timestamp) + n * 1000 + 500).toISOString(),
          traceEvents: Array.from({ length: 120 }, (_, j) => ({
            id: `trace_${n}_${j}`, sequence: j + 1, occurredAt: timestamp, phase: 'execution',
            actor: 'executor', kind: 'progress', status: 'completed', title: 'Progress',
            summary: 'safe progress '.repeat(70), details: {},
          })),
          executionTimeline: null, artifactRefs: [], artifacts: [],
        }));
        await conversations.writeConversation({ version: 3, conversation: item, turns: turns.map(turn => ({
          id: turn.id, conversationId: id, userInput: turn.userInput,
          finalAnswer: turn.finalAnswer, status: turn.status,
        })) });
        // A real multi-megabyte legacy aggregate, not pre-warmed in-memory rows.
        await new FileConversationPresentationStore(join(root, 'presentations')).write({ version: 1, conversationId: id, turns });
        await legacyJournal.appendBatch(turns.map((turn, sequence) => ({
          protocolVersion: 2, accountId, conversationId: id, eventId: `legacy_${sequence}`, sequence: 0,
          requestId: `request_${sequence}`, turnId: turn.id, kind: 'final_answer',
          payload: { lines: [turn.finalAnswer!] }, occurredAt: timestamp,
        })));
      }
    }
  }
  const template = metadata[0]!;
  for (let index = 0; index < 3017; index += 1) {
    metadata.push({ ...template, id: `conv_legacy_${index}`, plannerSessionId: `conv_legacy_${index}`, workspaceBinding: null });
  }
  await conversations.writeCatalog({ version: 3, conversations: metadata });
  const insert = db.prepare(`
    INSERT INTO tasks (id, title, account_id, conversation_id, created_at, updated_at)
    VALUES (?, 'Unrelated Task', ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (let index = 0; index < 3000; index += 1) {
      insert.run(`task_unrelated_${index}`, accountId, `conv_legacy_${index}`, timestamp, timestamp);
    }
  })();
  projector = new WorkspaceDirectoryProjector({
    accountId, projection, readMetadata: async () => (await conversations.readCatalog()).conversations,
    getActivities: inputs => new Map(inputs.map(item => [
      item.conversationId, { state: 'idle', taskId: null, updatedAt: item.updatedAt },
    ])),
  });
  await projector.rebuild();
  const workspaceRuntime = new WorkspaceGatewayRuntime(directory, {
    publish: async (kind, workspaceId, payload) => {
      subscriptions.publish(await journal.append({
        protocolVersion: 2, eventId: randomUUID(), sequence: 0, accountId,
        conversationId: workspaceEventStreamId(workspaceId), requestId: null, turnId: null,
        kind, payload: { workspaceId, ...payload as object }, occurredAt: new Date().toISOString(),
      }));
    },
  });
  const catalog = new WebSessionCatalog({
    directory, conversationStore: conversations, presentationStore: presentations,
  });
  const admissionStore = new SqliteCommandAdmissionStore(db, accountId);
  await admissionStore.initialize({
    exportRetained: async () => Array.from({ length: 3000 }, (_, index) => ({
      accountId, idempotencyKey: `historical_command_${index}`, fingerprint: `fingerprint_${index}`,
      requestId: `request_${index}`, connectionId: 'historical_connection', principalId: 'fixture',
      scope: { kind: 'workspace' as const }, command: { kind: 'select_workspace' as const, path: root },
      conversationId: null, state: 'terminal' as const, uncertaintyReason: null,
      receipt: {
        status: 'accepted' as const, requestId: `request_${index}`,
        idempotencyKey: `historical_command_${index}`, conversationId: null,
      },
      createdAt: timestamp, updatedAt: timestamp,
    })),
  });
  const gateway = new ClientGateway({
    authenticator: { authenticate: async () => ({ kind: 'local', id: 'fixture' }) },
    accountResolver: { resolve: async () => ({ status: 'authorized', accountId }) },
    conversationResolver: { resolve: async () => { throw new Error('fixture_execution_disabled'); } },
    activateAccount: async () => undefined,
    submitToConversation: async () => { throw new Error('fixture_execution_disabled'); },
    commandAdmissionStore: admissionStore,
    handleWorkspaceCommand: (command, context) => workspaceRuntime.handle(command, context),
  });
  await gateway.recover();
  const adapter = {
    submit: async (envelope: GatewayCommandEnvelope) => {
      if (!['select_workspace', 'list_workspace_conversations', 'create_conversation', 'archive_conversation']
        .includes(envelope.command.kind)) throw new Error('fixture_execution_disabled');
      return gateway.handle(envelope, 'local');
    },
    replay: journal.replay.bind(journal),
    snapshot: journal.snapshot.bind(journal),
    subscribe: (id: string, conversationId: string | null, listener: Parameters<GatewaySubscriptions['subscribe']>[0]['listener'], liveConnectionId?: string) => (
      subscriptions.subscribe({ accountId: id, conversationId, listener, liveConnectionId })
    ),
    restoreWorkspace: workspaceRuntime.restoreConnectionWorkspace.bind(workspaceRuntime),
    closeConnection: workspaceRuntime.closeConnection.bind(workspaceRuntime),
    attachClient: async (_accountId: string, conversationId: string) => {
      const binding = await directory.resolveConversationWorkspace(conversationId, 'fixture');
      if (!binding) throw new Error('fixture_conversation_unavailable');
      const workspace = selected.find(item => item.id === binding)!;
      await journal.append({
        protocolVersion: 2, eventId: randomUUID(), sequence: 0, accountId, conversationId,
        kind: 'conversation_snapshot', requestId: null, turnId: null,
        payload: { from: 0, lines: [], workspace: { path: workspace.canonicalPath, selectedAt: timestamp } },
        occurredAt: timestamp,
      });
      return () => undefined;
    },
  } as unknown as WebGatewayAdapter;
  const runtime = new WebGatewaySessionRuntime({ accountId, catalog, gateway: adapter });
  const auth = new WebAuthService();
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const server = new ManagementServer({
    port, webDistDir, token: auth.manualAccessToken, webAuth: auth,
    runningRevisionId: 'fixture-only', sessionRuntime: runtime,
    launchContexts: new WebLaunchContextService(), workspaceDirectoryBrowser: new WorkspaceDirectoryBrowser(),
    loginCredentials: resolveLoginCredentials({ ANYFUSION_WEB_USERNAME: 'admin', ANYFUSION_WEB_PASSWORD: 'test-password' }),
    agentReadiness: new AgentInstallationReadinessService({
      probe: async () => ({ kind: 'exit', code: 0, stdout: 'fixture navigation only', stderr: '' }),
    }),
    executionQuery: { listTasks: () => [], projectTimeline: () => null },
    configQuery: {
      getActive: async () => ({ revisionId: 'fixture-only', contentHash: 'fixture', config: {} }),
      listRevisions: async () => [], getSnapshot: async () => null,
      activate: async () => { throw new Error('fixture_configuration_disabled'); },
      rollback: async () => { throw new Error('fixture_configuration_disabled'); },
      writeSecret: async () => { throw new Error('fixture_configuration_disabled'); },
    },
  });
  await server.start();
  return {
    root, db, projection, projector, conversations, journal, server, runtime, admissionStore, workspaces: selected,
    async changeActivity(conversationId: string, activity: ConversationActivityProjection) {
      projector!.observeActivity(conversationId, activity);
      const row = projection.find(conversationId);
      if (row) await workspaceRuntime.publishActivity(row.workspaceId, { conversationId, activity });
    },
    async close() {
      await server.stop();
      await runtime.dispose();
      gateway.closeAdmission();
      await gateway.drain();
      await journal.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
