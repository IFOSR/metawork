import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { GatewayClient } from '../../planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-client.js';
import { GatewaySocketTransport } from '../../planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-socket-transport.js';
import { MetaWorkTuiController } from '../../planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/controller.js';
import { MetaclawGatewayServer } from '../../src/gateway/server.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { SegmentedEventJournal } from '../../src/gateway/segmented-event-journal.js';
import { SqliteEventJournalSegmentIndex } from '../../src/storage/event-journal-segment-index-repo.js';
import { SqliteConversationHistoryRepo } from '../../src/storage/conversation-history-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import type { ConversationTurn } from '../../src/session/conversation-store.js';
import { ConversationReadProjector } from '../../src/session/conversation-read-projector.js';
import { SqliteConversationReadModel } from '../../src/storage/conversation-read-model-repo.js';
import { ConversationObservationService } from '../../src/gateway/conversation-observation.js';
import { createGatewayReadOnlyQueryHandler } from '../../src/gateway/read-only-query-handler.js';
import type { ClientGateway } from '../../src/gateway/client-gateway.js';
import type { GatewayCommandEnvelope } from '../../src/gateway/client-protocol.js';

it('navigates long Unicode history through the real Unix Gateway and TUI controller without audit replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'metawork-tui-history-'));
  const db = new Database(join(root, 'history.db'));
  runMigrations(db);
  const history = new SqliteConversationHistoryRepo<ConversationTurn>(db, 'local-default', 'conversation');
  const turns = Array.from({ length: 53 }, (_, n): ConversationTurn => ({
    id: `turn_${n}`, conversationId: 'conv_history', userInput: `Question ${n}`,
    finalAnswer: `Conclusion ${n}\n${'中文报告'.repeat(12_000)}`, status: 'completed',
  }));
  history.importOnce('conv_history', turns);
  const journal = new SegmentedEventJournal(join(root, 'journal'), new SqliteEventJournalSegmentIndex(db),
    new FileEventJournal(join(root, 'journal')));
  const replay = vi.spyOn(journal, 'replay');
  const subscriptions = new GatewaySubscriptions();
  const model = new SqliteConversationReadModel(db);
  const projector = new ConversationReadProjector(model);
  turns.forEach((turn, index) => projector.applyHistory('local-default', 'conv_history', turn, index + 1));
  const observation = new ConversationObservationService({ model, subscriptions,
    identity: { serverId: 'acceptance-server', accountId: 'local-default' },
    authorize: async (account, id) => account === 'local-default' && id === 'conv_history',
    sourceSequence: () => 0, onError: error => { throw error; },
    metadata: async () => ({ id: 'conv_history', title: 'History', workspaceId: 'workspace',
      workspace: { id: 'workspace', path: root, displayName: 'Fixture', availability: 'available' } }),
  });
  const query = createGatewayReadOnlyQueryHandler({ subscriptions, journal,
    authorizeConversation: async (_account, id) => id === 'conv_history',
    completeCommand: () => ({ state: 'inactive', suggestions: [], hint: null, error: null }),
    getTaskView: async () => { throw new Error('unexpected Task query'); },
    conversationResource: async (account, command) => command.resource === 'metadata'
      ? observation.metadata(account, command.conversationId) : command.resource === 'content'
      ? observation.content(account, command.conversationId, command.hash!, command.offset ?? 0, 16 * 1024)
      : observation.page(account, command.conversationId, command.cursor, 24 * 1024, command.beforeTurnId),
  });
  const server = new MetaclawGatewayServer({
    socketPath: join(root, 'gateway.sock'), journal, subscriptions, observation,
    authorizeAttach: async (_account, id) => id === 'conv_history',
    gateway: {
      handle: async (envelope: GatewayCommandEnvelope) => {
        if (envelope.command.kind !== 'get_conversation_resource') throw new Error('navigation_must_not_open_planner');
        const result = await query(envelope.command, { accountId: 'local-default', principalId: 'local:test',
          connectionId: envelope.connectionId, requestId: envelope.requestId, scope: envelope.scope });
        return { requestId: envelope.requestId, idempotencyKey: envelope.idempotencyKey, ...result };
      },
    } as ClientGateway,
  });
  const transport = new GatewaySocketTransport(join(root, 'gateway.sock'));
  const controllerGateway = new GatewayClient(transport);
  const controller = new MetaWorkTuiController({ gateway: controllerGateway });
  try {
    await server.start();
    await controller.start();
    await controller.attachConversation('conv_history', false);
    await expect.poll(() => controller.getView().client.conversations.conv_history?.turnOrder.length).toBe(20);
    expect(controller.getView().client.conversations.conv_history?.turns.turn_52?.answer).toContain('Conclusion 52');
    expect(controller.getView().client.conversations.conv_history?.turns.turn_52?.answer.length).toBeLessThan(4096);
    const visited = new Set(controller.getView().client.conversations.conv_history!.turnOrder);
    for (let n = 0; n < 20 && !controller.getView().client.conversations.conv_history?.historyExhausted; n += 1) {
      await controller.loadOlderHistory();
      const window = controller.getView().client.conversations.conv_history!.turnOrder;
      expect(window.length).toBeLessThanOrEqual(20);
      window.forEach(id => visited.add(id));
    }
    const projection = controller.getView().client.conversations.conv_history!;
    expect(projection.historyExhausted).toBe(true);
    expect([...visited].sort()).toEqual(turns.map(turn => turn.id).sort());
    const ref = model.findTurn('local-default', 'conv_history', 'turn_0')!.answerRef!;
    const chunks: string[] = [];
    let offset = 0;
    while (offset < ref.byteLength) {
      const part = await controllerGateway.queryConversationResource({ kind: 'get_conversation_resource',
        conversationId: 'conv_history', resource: 'content', hash: ref.hash, offset }) as { text: string; nextOffset: number };
      expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(32 * 1024);
      chunks.push(part.text); offset = part.nextOffset;
    }
    expect(chunks.join('')).toBe(turns[0]!.finalAnswer);
    // Exercise the delayed Task/billing refresh even on a fast machine.
    await controller.openTaskPanel();
    expect(replay).not.toHaveBeenCalled();
    expect((await journal.snapshot('local-default', 'conv_history')).snapshot).toEqual([]);
  } finally {
    controller.stop();
    transport.close();
    await server.stop();
    await journal.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
