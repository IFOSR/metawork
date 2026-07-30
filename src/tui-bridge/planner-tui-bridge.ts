import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type {
  PlannerTuiPlanSubmissionResult,
  PlannerTuiSnapshot,
  SessionSnapshot,
} from '../session/metaclaw-session.js';

const MAX_JSONL_LINE_BYTES = 1_048_576;

export interface PlannerTuiBridgeSession {
  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void;
  getPlannerTuiSnapshot(): PlannerTuiSnapshot;
  submitPlannerTuiPlan(userInput: string, rawPlan: unknown): Promise<PlannerTuiPlanSubmissionResult>;
}

export interface PlannerTuiBridgeDeps {
  socketPath: string;
  session: PlannerTuiBridgeSession;
  logger?: Pick<Console, 'warn'>;
}

type BridgeRequest = {
  type: 'subscribe' | 'snapshot' | 'planner_stop' | 'ping';
  requestId?: string;
  userInput?: unknown;
  plan?: unknown;
};

type BridgeMessage =
  | { type: 'snapshot'; snapshot: PlannerTuiSnapshot }
  | { type: 'response'; requestId: string | null; ok: true; result: unknown }
  | {
      type: 'response';
      requestId: string | null;
      ok: false;
      error: { code: string; message: string; details?: string[] };
    };

/**
 * Trusted local Application-Shell bridge for the native Planner TUI.
 *
 * It has no database, Kernel, scheduler, or executor dependency. `planner_stop`
 * is only a proposal handoff: MetaclawSession revalidates the v6 plan and remains
 * responsible for the existing DurableKernelWorkflow submission.
 */
export class PlannerTuiBridge {
  private server: Server | null = null;
  private readonly clients = new Set<Socket>();
  private readonly subscribers = new Set<Socket>();
  private unsubscribeSession: (() => void) | null = null;
  private submissionQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PlannerTuiBridgeDeps) {}

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(dirname(this.deps.socketPath), { recursive: true });
    await this.removeStaleSocket();

    const server = createServer(socket => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.deps.socketPath);
    });
    this.server = server;
    await chmod(this.deps.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    this.subscribers.clear();
    this.stopSessionSubscription();

    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
    await this.removeStaleSocket();
  }

  private handleConnection(socket: Socket): void {
    this.clients.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';

    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_JSONL_LINE_BYTES) {
        this.write(socket, this.errorResponse(null, 'line_too_large', 'JSONL request exceeds 1 MiB'));
        buffer = '';
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.handleLine(socket, line);
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('error', error => {
      this.deps.logger?.warn(`Planner TUI bridge client error: ${error.message}`);
    });
    socket.on('close', () => this.removeClient(socket));
  }

  private handleLine(socket: Socket, line: string): void {
    let request: BridgeRequest;
    try {
      const value: unknown = JSON.parse(line);
      if (!isBridgeRequest(value)) throw new Error('request.type must be a supported string');
      request = value;
    } catch (error) {
      this.write(socket, this.errorResponse(null, 'invalid_request', (error as Error).message));
      return;
    }

    switch (request.type) {
      case 'ping':
        this.write(socket, this.successResponse(request.requestId, { pong: true }));
        return;
      case 'snapshot':
        this.write(socket, this.successResponse(request.requestId, this.deps.session.getPlannerTuiSnapshot()));
        return;
      case 'subscribe': {
        const alreadySubscribed = Boolean(this.unsubscribeSession);
        this.subscribers.add(socket);
        this.write(socket, this.successResponse(request.requestId, { subscribed: true }));
        if (alreadySubscribed) {
          this.write(socket, { type: 'snapshot', snapshot: this.deps.session.getPlannerTuiSnapshot() });
        } else {
          this.ensureSessionSubscription();
        }
        return;
      }
      case 'planner_stop':
        if (typeof request.userInput !== 'string') {
          this.write(socket, this.errorResponse(request.requestId, 'invalid_request', 'planner_stop.userInput must be a string'));
          return;
        }
        this.enqueuePlannerStop(socket, request.requestId, request.userInput, request.plan);
        return;
    }
  }

  private enqueuePlannerStop(
    socket: Socket,
    requestId: string | undefined,
    userInput: string,
    plan: unknown,
  ): void {
    this.submissionQueue = this.submissionQueue
      .catch(() => undefined)
      .then(async () => {
        const result = await this.deps.session.submitPlannerTuiPlan(userInput, plan);
        if (!result.accepted) {
          this.write(socket, this.errorResponse(
            requestId,
            'plan_rejected',
            'Planner proposal failed v6 validation',
            result.errors,
          ));
          return;
        }
        this.write(socket, this.successResponse(requestId, {
          accepted: true,
          planId: result.planId,
        }));
      })
      .catch(error => {
        this.deps.logger?.warn(`Planner TUI bridge proposal failed: ${(error as Error).message}`);
        this.write(socket, this.errorResponse(
          requestId,
          'proposal_submission_failed',
          (error as Error).message,
        ));
      });
  }

  private ensureSessionSubscription(): void {
    if (this.unsubscribeSession) return;
    this.unsubscribeSession = this.deps.session.subscribe(() => {
      const message: BridgeMessage = {
        type: 'snapshot',
        snapshot: this.deps.session.getPlannerTuiSnapshot(),
      };
      for (const socket of this.subscribers) this.write(socket, message);
    });
  }

  private removeClient(socket: Socket): void {
    this.clients.delete(socket);
    this.subscribers.delete(socket);
    if (this.subscribers.size === 0) this.stopSessionSubscription();
  }

  private stopSessionSubscription(): void {
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
  }

  private successResponse(requestId: string | undefined, result: unknown): BridgeMessage {
    return { type: 'response', requestId: requestId ?? null, ok: true, result };
  }

  private errorResponse(
    requestId: string | undefined | null,
    code: string,
    message: string,
    details?: string[],
  ): BridgeMessage {
    return {
      type: 'response',
      requestId: requestId ?? null,
      ok: false,
      error: { code, message, ...(details?.length ? { details } : {}) },
    };
  }

  private write(socket: Socket, message: BridgeMessage): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  }

  private async removeStaleSocket(): Promise<void> {
    try {
      const stat = await lstat(this.deps.socketPath);
      if (!stat.isSocket()) {
        throw new Error(`refusing to replace non-socket bridge path: ${this.deps.socketPath}`);
      }
      await unlink(this.deps.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'subscribe' || type === 'snapshot' || type === 'planner_stop' || type === 'ping';
}
