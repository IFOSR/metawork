import { existsSync, unlinkSync } from 'fs';
import { createServer, type Server, type Socket } from 'net';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import type { Config } from '../core/types.js';
import type { TaskEngine } from '../task/task-engine.js';
import type { MemoryEngine } from '../memory/memory-engine.js';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { ContextRecaller } from '../memory/context-recaller.js';
import type { NotificationService } from '../notifications/types.js';
import { MetaclawSession, type PlannerHostRegistrar } from '../session/metaclaw-session.js';
import type { PlannerProcessController } from '../planning/planner-process-supervisor.js';
import type { StagedLegacyConfiguration } from '../configuration/staged-legacy-configuration.js';
import { createJsonLineParser, encodeJsonLine } from './jsonl.js';
import { SessionStreamAdapter } from '../session/session-transport-adapter.js';
import type { GatewayClientMessage, GatewayServerMessage } from './protocol.js';

interface GatewayServerDeps {
  socketPath: string;
  taskEngine: TaskEngine;
  memoryEngine: MemoryEngine;
  orchestration: OrchestrationEngine;
  db: Database.Database;
  config: Config;
  contextRecaller: ContextRecaller;
  notifier: NotificationService;
  workspaceRoot: string;
  plannerHost?: PlannerHostRegistrar;
  plannerSupervisor?: PlannerProcessController;
  stagedConfiguration?: StagedLegacyConfiguration;
}

export class MetaclawGatewayServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly sessions = new Set<MetaclawSession>();
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
    await Promise.all([...this.sessions].map(session => session.dispose()));
    this.sessions.clear();
    await closePromise;
    if (existsSync(this.deps.socketPath)) {
      unlinkSync(this.deps.socketPath);
    }
  }

  private async handleConnection(socket: Socket): Promise<void> {
    const sessionId = `sess_gateway_${nanoid(10)}`;
    const session = new MetaclawSession({
      taskEngine: this.deps.taskEngine,
      memoryEngine: this.deps.memoryEngine,
      orchestration: this.deps.orchestration,
      db: this.deps.db,
      config: this.deps.config,
      sessionId,
      contextRecaller: this.deps.contextRecaller,
      notifier: this.deps.notifier,
      plannerHost: this.deps.plannerHost,
      plannerSupervisor: this.deps.plannerSupervisor,
      stagedConfiguration: this.deps.stagedConfiguration,
    });
    this.sessions.add(session);

    const send = (message: GatewayServerMessage) => {
      if (!socket.destroyed) {
        socket.write(encodeJsonLine(message));
      }
    };

    const adapter = new SessionStreamAdapter(session, {
      onOutput: lines => send({ type: 'output', lines }),
      onExitRequested: () => socket.end(encodeJsonLine({ type: 'exit' } satisfies GatewayServerMessage)),
    });
    adapter.attach();

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      adapter.detach();
      void session.dispose().finally(() => this.sessions.delete(session));
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    send({ type: 'hello', sessionId });
    session.initialize({ showDashboard: false });
    session.appendSystemMessage(`→ Gateway session ${sessionId} 已连接`);

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
