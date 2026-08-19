import { existsSync, unlinkSync } from 'fs';
import { createServer, type Server, type Socket } from 'net';
import { nanoid } from 'nanoid';
import { createJsonLineParser, encodeJsonLine } from './jsonl.js';
import { SessionStreamAdapter } from '../session/session-transport-adapter.js';
import { ConversationRegistry } from '../session/conversation-registry.js';
import type { ConversationSession } from '../session/conversation-session.js';
import type { GatewayClientMessage, GatewayServerMessage } from './protocol.js';

interface GatewayServerDeps {
  socketPath: string;
  /** 账户级 Conversation 注册表：一个 Conversation 可被多个连接附着。 */
  conversationRegistry: ConversationRegistry;
  /** Conversation 工厂：由组合根注入（ADR-0031：传输层不得构造具体 Session）。 */
  conversationFactory: (conversationId: string) => ConversationSession;
}

export class MetaclawGatewayServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private stopping = false;

  constructor(private readonly deps: GatewayServerDeps) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.stopping = false;
    if (existsSync(this.deps.socketPath)) {
      unlinkSync(this.deps.socketPath);
    }

    this.server = createServer(socket => {
      if (this.stopping) {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.once('close', () => {
        this.sockets.delete(socket);
      });
      void this.handleConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.deps.socketPath, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    this.stopping = true;
    const closePromise = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    // Conversation 生命周期由 AccountRuntime 管理；传输层只关闭 socket。
    await closePromise;
    if (existsSync(this.deps.socketPath)) {
      unlinkSync(this.deps.socketPath);
    }
  }

  private async handleConnection(socket: Socket): Promise<void> {
    // ADR-0031：每个连接附着到一个持久 Conversation，断开只 detach，
    // 不销毁 Conversation。
    const conversationId = `conv_gateway_${nanoid(10)}`;
    const conversation = await this.deps.conversationRegistry.getOrOpen(
      conversationId,
      async () => this.deps.conversationFactory(conversationId),
    );
    conversation.attachClient();

    const send = (message: GatewayServerMessage) => {
      if (!socket.destroyed) {
        socket.write(encodeJsonLine(message));
      }
    };

    const adapter = new SessionStreamAdapter(conversation, {
      onOutput: lines => send({ type: 'output', lines }),
      onExitRequested: () => socket.end(encodeJsonLine({ type: 'exit' } satisfies GatewayServerMessage)),
    });
    adapter.attach();

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      adapter.detach();
      conversation.detachClient();
      void this.deps.conversationRegistry.closeIdle(conversationId);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    send({ type: 'hello', sessionId: conversationId });
    conversation.initialize?.({ showDashboard: false });
    conversation.appendSystemMessage?.(`→ Gateway session ${conversationId} 已连接`);

    const parse = createJsonLineParser<GatewayClientMessage>((message) => {
      if (message.type === 'close') {
        socket.end(encodeJsonLine({ type: 'exit' } satisfies GatewayServerMessage));
        return;
      }
      if (message.type !== 'input') {
        return;
      }
      void adapter.submit(message.text).catch(error => {
        send({ type: 'error', message: (error as Error).message });
      });
    });

    socket.on('data', parse);
  }
}
