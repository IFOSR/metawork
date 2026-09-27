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
import { ConversationGatewayRuntime } from '../../src/gateway/conversation-gateway-runtime.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { SegmentedEventJournal } from '../../src/gateway/segmented-event-journal.js';
import { SqliteEventJournalSegmentIndex } from '../../src/storage/event-journal-segment-index-repo.js';
import { SqliteConversationHistoryRepo } from '../../src/storage/conversation-history-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { ConversationRegistry } from '../../src/session/conversation-registry.js';
import type { ConversationTurn } from '../../src/session/conversation-store.js';
import type { RuntimeRegistry } from '../../src/account/runtime-registry.js';
import type { ClientGateway } from '../../src/gateway/client-gateway.js';
import type { GatewayCommandEnvelope } from '../../src/gateway/client-protocol.js';

it('navigates long Unicode history through the real Unix Gateway and TUI controller without audit replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'metawork-tui-history-'));
  const db = new Database(join(root, 'history.db'));
  runMigrations(db);
  const history = new SqliteConversationHistoryRepo<ConversationTurn>(db, 'local-default', 'conversation');
  const turns = Array.from({ length: 13 }, (_, n): ConversationTurn => ({
    id: `turn_${n}`, conversationId: 'conv_history', userInput: `Question ${n}`,
    finalAnswer: `Conclusion ${n}\n${'中文报告'.repeat(12_000)}`, status: 'completed',
  }));
  history.importOnce('conv_history', turns);
  const journal = new SegmentedEventJournal(join(root, 'journal'), new SqliteEventJournalSegmentIndex(db),
    new FileEventJournal(join(root, 'journal')));
  const replay = vi.spyOn(journal, 'replay');
  const subscriptions = new GatewaySubscriptions();
  const runtime = new ConversationGatewayRuntime({
    accountId: 'local-default', journal, subscriptions, conversations: new ConversationRegistry(),
    registry: {} as RuntimeRegistry,
    conversationFactory: () => { throw new Error('navigation_must_not_open_planner'); },
    readHistory: async (id, cursor, limit) => {
      const page = history.page(id, { cursor: cursor === 'newest' ? undefined : cursor, limit, maxBytes: 256 * 1024 });
      return { turns: [...page.turns].reverse(), previousCursor: cursor ? 'newest' : null, nextCursor: page.nextCursor };
    },
  });
  const server = new MetaclawGatewayServer({
    socketPath: join(root, 'gateway.sock'), journal, subscriptions,
    authorizeAttach: async (_account, id) => id === 'conv_history',
    gateway: {
      handle: async (envelope: GatewayCommandEnvelope) => {
        if (envelope.command.kind !== 'attach_conversation' && envelope.command.kind !== 'get_conversation_history') {
          // Read-only enrichment belongs to query handlers, never the Conversation runtime.
          return { requestId: envelope.requestId, idempotencyKey: envelope.idempotencyKey,
            status: 'rejected', conversationId: null, reason: 'fixture_query_unavailable' };
        }
        const result = await runtime.submit('conv_history', envelope.requestId, envelope.idempotencyKey,
          envelope.command, 'local:test', { connectionId: envelope.connectionId, surface: 'local' });
        return { requestId: envelope.requestId, idempotencyKey: envelope.idempotencyKey,
          status: result.status, conversationId: 'conv_history', reason: result.reason };
      },
    } as ClientGateway,
  });
  const transport = new GatewaySocketTransport(join(root, 'gateway.sock'));
  const controller = new MetaWorkTuiController({ gateway: new GatewayClient(transport) });
  try {
    await server.start();
    await controller.start();
    await controller.attachConversation('conv_history', false);
    expect(controller.getView().client.conversations.conv_history?.turnOrder).toEqual(['turn_12']);
    expect(controller.getView().client.conversations.conv_history?.turns.turn_12?.answer === turns[12]!.finalAnswer).toBe(true);
    for (let n = 0; n < 12; n += 1) await controller.loadOlderHistory();
    const projection = controller.getView().client.conversations.conv_history!;
    expect(projection.historyExhausted).toBe(true);
    expect(projection.turnOrder).toEqual(turns.map(turn => turn.id));
    expect(projection.turns.turn_0?.answer === turns[0]!.finalAnswer).toBe(true);
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
