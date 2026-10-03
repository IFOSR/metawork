import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { permissionFixture } from '../helpers/permission-runtime.js';
import { deferred, sessionWith } from '../helpers/conversation-control.js';
import { MemoryClientNavigation } from '../helpers/client-navigation.js';
import { ClientGateway } from '../../src/gateway/client-gateway.js';
import { ConversationGatewayRuntime } from '../../src/gateway/conversation-gateway-runtime.js';
import { ConversationRegistry } from '../../src/session/conversation-registry.js';
import { ConversationBindingRepository } from '../../src/session/conversation-binding-repository.js';
import { BindingConversationResolver } from '../../src/gateway/conversation-resolver.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { FeishuGatewayAdapter } from '../../src/gateway/feishu-gateway-adapter.js';
import { FeishuConversationRouting } from '../../src/gateway/feishu-conversation-routing.js';
import { WebGatewayAdapter } from '../../src/management/web-gateway-adapter.js';
import { SqliteCommandAdmissionStore } from '../../src/storage/command-admission-repo.js';
import { createAccountEventJournal } from '../../src/server/account-event-journal.js';
import { ConversationObservationService, type ConversationObservationFrame } from '../../src/gateway/conversation-observation.js';
import type { GatewayCommand, GatewayCommandEnvelope } from '../../src/gateway/client-protocol.js';
import { createGatewayReadOnlyQueryHandler } from '../../src/gateway/read-only-query-handler.js';
import type { RuntimeRegistry } from '../../src/account/runtime-registry.js';

const surfaces = ['local', 'web', 'feishu'] as const;
const pairs = surfaces.flatMap(origin => surfaces.map(actor => ({ origin, actor })));

// Real Gateway, Feishu/Web adapters, Conversation mailbox/Session, segmented
// journal, SQLite read model, permission owner and Kernel. Planner and backend
// calls are controlled seams; this test never sends an external message.
describe('same-account origin × acting surface control matrix', () => {
  it.each(pairs)('$origin → $actor: browse, continue, exact stop and durable approval', async ({ origin, actor }) => {
    const root = await mkdtemp(join(tmpdir(), 'mw-client-matrix-'));
    const p = permissionFixture();
    const service = p.createService();
    const longRun = deferred<void>();
    let planningCalls = 0;
    const { session, trace, cancelTask, cancelPlannerTurn } = sessionWith({ planning: { submit: async () => {
      if (++planningCalls === 3) await longRun.promise;
      return { status: 'accepted' };
    } } as never,
      cancelPlannerTurn: async () => { longRun.resolve(); },
      permissions: service, queries: {
        findTask: id => ({ id, status: 'blocked', accountId: 'local-default', conversationId: 'conv_cancel' }) as never,
        findActiveWorkGraphRevision: () => ({ generationId: 'generation' }) as never,
      } });
    // Seed a previously applied escalation owned by this Conversation.
    p.db.prepare(`INSERT INTO kernel_decisions(id,schema_version,event_id,event_type,correlation_id,session_id,
      task_id,subtask_id,attempt_id,event_json,snapshot_json,decision_json,action,reason,configuration_revision,created_at)
      VALUES ('escalation',5,'escalation_event','permission_requested','request','planner_cancel','task','subtask','attempt',
      '{"schemaVersion":5,"type":"permission_requested"}','{"schemaVersion":5}','{"schemaVersion":5}','escalate_capability','approval required','revision',?)`).run(new Date().toISOString());
    p.db.prepare(`INSERT INTO kernel_decision_applications(id,decision_id,event_id,idempotency_key,status,created_at,updated_at)
      VALUES ('escalation_application','escalation','escalation_event','escalation','applied',?,?)`)
      .run(new Date().toISOString(), new Date().toISOString());
    const events = new GatewaySubscriptions();
    const journal = createAccountEventJournal({ db: p.db, root: join(root, 'journal'), accountId: 'local-default', onError: error => { throw error; } });
    const runtime = new ConversationGatewayRuntime({ accountId: 'local-default', subscriptions: events,
      journal: journal.journal, conversations: new ConversationRegistry(), conversationFactory: () => session,
      registry: { getOrActivate: async () => ({ accountId: 'local-default' }), getIfLoaded: () => null } as unknown as RuntimeRegistry });
    const bindings = new ConversationBindingRepository(join(root, 'bindings.json')); await bindings.initialize();
    const admission = new SqliteCommandAdmissionStore(p.db, 'local-default'); await admission.initialize({ exportRetained: async () => [] });
    const gateway = new ClientGateway({
      authenticator: { authenticate: async input => ({ kind: input.transport === 'feishu' ? 'feishu' : input.transport === 'web' ? 'web' : 'local', id: input.transport === 'feishu' ? 'tenant:owner' : 'owner' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: new BindingConversationResolver({ bindings, createId: () => 'conv_cancel', verifyOwnership: async (_account, id) => id === 'conv_cancel' }),
      commandAdmissionStore: admission, activateAccount: async () => {},
      handleWorkspaceCommand: async () => ({ status: 'accepted', workspaceId: 'workspace' }),
      handleReadOnlyQuery: (...args) => readOnly(...args),
      submitToConversation: (...args) => runtime.submit(...args),
    });
    const observation = new ConversationObservationService({ model: journal.readModel, subscriptions: events,
      authorize: async (account, id) => account === 'local-default' && id === 'conv_cancel',
      sourceSequence: () => journal.readModel.head('local-default', 'conv_cancel')?.journalSequence ?? 0,
      onError: error => { throw error; } });
    const readOnly = createGatewayReadOnlyQueryHandler({ subscriptions: events, journal: journal.journal,
      authorizeConversation: async (account, id) => account === 'local-default' && id === 'conv_cancel',
      completeCommand: () => ({ state: 'inactive', suggestions: [], hint: null, error: null }),
      getTaskView: async () => { throw new Error('unexpected Task detail request'); },
      conversationResource: async (account, command) => observation.page(account, command.conversationId, command.cursor),
    });
    const web = new WebGatewayAdapter({ gateway, journal: journal.journal, subscriptions: events });
    const feishu = new FeishuGatewayAdapter({ gateway, routing: new FeishuConversationRouting({
      accountId: 'local-default', gateway, bindings, navigation: new MemoryClientNavigation(), subscriptions: events,
      observation, restoreWorkspace: async () => {}, resolveConversationWorkspace: async (_a, id) => id === 'conv_cancel' ? 'workspace' : null,
    }) });
    let counter = 0;
    const sender = { tenantKey: 'tenant', userId: 'owner' }; const channel = { chatId: 'chat', chatType: 'dm' as const };
    const submit = async (surface: typeof origin, command: GatewayCommand, key?: string) => {
      const id = key ?? `request_${++counter}`;
      if (surface === 'feishu') {
        const text = command.kind === 'user_message' ? command.text
          : command.kind === 'cancel_task' ? `/stop-task ${command.taskId} ${command.expectedExecutionGeneration} conv_cancel`
          : command.kind === 'cancel_turn' ? `/stop-turn ${command.turnId} conv_cancel`
          : command.kind === 'permission_resolution_v2' ? `/${command.resolution} ${command.requestId} ${command.requestRevision} ${command.expectedExecutionGeneration} conv_cancel` : '';
        return feishu.handleMessage(sender, channel, text, id, id);
      }
      const envelope: GatewayCommandEnvelope = { protocolVersion: 2, requestId: id, idempotencyKey: id, connectionId: `${surface}_matrix`,
        scope: { kind: 'conversation', selection: { mode: 'attach', conversationId: 'conv_cancel' } }, command, clientCapabilities: [] };
      return surface === 'web' ? web.submit(envelope) : gateway.handle(envelope, 'local');
    };
    let handle: Awaited<ReturnType<typeof observation.open>> | undefined;
    try {
      expect(await feishu.handleMessage(sender, channel, '/workspace /repo', 'workspace', 'workspace')).toMatchObject({ status: 'accepted' });
      expect(await feishu.handleMessage(sender, channel, '/conversation conv_cancel', 'navigate', 'navigate')).toMatchObject({ status: 'accepted' });
      expect(await submit(origin, { kind: 'user_message', text: 'first request', attachments: [] })).toMatchObject({ status: 'accepted' });
      await runtime.drain();
      const first = await observation.page('local-default', 'conv_cancel');
      expect(first.turns.some(turn => turn.userInput === 'first request')).toBe(true);
      expect(await feishu.handleMessage(sender, channel, '/history', 'history', 'history')).toMatchObject({
        status: 'accepted', resourcePage: { turns: expect.arrayContaining([expect.objectContaining({ userInput: 'first request' })]) },
      });
      const frames: ConversationObservationFrame[] = [];
      handle = await observation.open({ accountId: 'local-default', conversationId: 'conv_cancel', observationId: actor,
        send: frame => { frames.push(frame); return true; } });
      const next = { kind: 'user_message' as const, text: 'continue from another surface', attachments: [] };
      expect(await submit(actor, next, 'continuation')).toMatchObject({ status: 'accepted' });
      await runtime.drain();
      expect(await submit(actor, next, 'continuation')).toMatchObject({ status: 'duplicate' });
      await handle.refresh();
      expect((await observation.page('local-default', 'conv_cancel')).turns.filter(turn => turn.userInput === next.text)).toHaveLength(1);
      expect(frames.some(frame => frame.kind === 'patch')).toBe(true);
      await submit(actor, { kind: 'cancel_turn', turnId: 'older-finished-turn' }); await runtime.drain();
      expect(cancelTask).not.toHaveBeenCalled();
      await submit(actor, { kind: 'cancel_task', taskId: 'older-background-task', expectedExecutionGeneration: 'stale' }); await runtime.drain();
      expect(cancelTask).not.toHaveBeenCalled();
      await submit(actor, { kind: 'cancel_task', taskId: 'older-background-task', expectedExecutionGeneration: 'generation' }); await runtime.drain();
      expect(cancelTask).toHaveBeenCalledTimes(1);
      expect(cancelTask).toHaveBeenCalledWith('older-background-task', '用户请求停止此任务');
      await submit(actor, { kind: 'permission_resolution_v2', requestId: 'request', requestRevision: 'fingerprint', expectedExecutionGeneration: 'generation', resolution: 'approve' });
      await runtime.drain(); await service.recoverPending(true);
      expect(p.store.findPermissionResolution('request')?.resolution).toBe('approve');
      expect(p.db.prepare('SELECT count(*) AS n FROM user_authorizations').get()).toEqual({ n: 1 });
      expect(await submit(origin, { kind: 'user_message', text: 'long running Planner', attachments: [] })).toMatchObject({ status: 'accepted' });
      await vi.waitFor(() => expect(trace.getSnapshot()?.events.some(event => event.kind === 'planner_started')).toBe(true));
      await vi.waitFor(() => expect(planningCalls).toBe(3));
      const runningTurn = trace.getSnapshot()!.turnId;
      expect(await submit(actor, { kind: 'cancel_turn', turnId: runningTurn })).toMatchObject({ status: 'accepted' });
      await runtime.drain();
      expect(cancelPlannerTurn).toHaveBeenCalledOnce();
      expect(cancelTask).toHaveBeenLastCalledWith('task_x', '用户取消了当前轮');
      expect(trace.getSnapshot()?.status).toBe('cancelled');
      await submit(origin, { kind: 'permission_resolution_v2', requestId: 'request', requestRevision: 'fingerprint', expectedExecutionGeneration: 'generation', resolution: 'deny' });
      await runtime.drain();
      expect(p.store.findPermissionResolution('request')?.resolution).toBe('approve');
      expect(p.db.prepare('SELECT count(*) AS n FROM user_authorizations').get()).toEqual({ n: 1 });
    } finally { longRun.resolve(); handle?.close(); await runtime.drain(); await journal.stop(); await session.dispose(); p.db.close(); await rm(root, { recursive: true, force: true }); }
  });
});
