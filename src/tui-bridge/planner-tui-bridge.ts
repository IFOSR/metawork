import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { CommandCompletion } from '../commands/catalog.js';
import type {
  PlannerTuiCommandSubmissionResult,
  PlannerTuiPlanSubmissionResult,
  PlannerTuiSnapshot,
  SessionSnapshot,
} from '../session/metaclaw-session.js';
import {
  ANYFUSION_PLANNER_HOST_MAX_LINE_BYTES,
  ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
  isPlannerHostRequest,
  type PlannerHostMessage,
  type PlannerHostRequest,
} from './planner-host-protocol.js';

export interface PlannerTuiBridgeSession {
  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void;
  getPlannerTuiSnapshot(): PlannerTuiSnapshot;
  completeCommand(text: string, cursor?: number): CommandCompletion;
  submitPlannerTuiCommand(command: string): Promise<PlannerTuiCommandSubmissionResult>;
  submitPlannerTuiPlan(userInput: string, rawPlan: unknown): Promise<PlannerTuiPlanSubmissionResult>;
}

export interface PlannerTuiBridgeDeps {
  socketPath: string;
  session: PlannerTuiBridgeSession;
  logger?: Pick<Console, 'warn'>;
}

type BridgeMessage = PlannerHostMessage<PlannerTuiSnapshot>;

/**
 * Trusted local Application-Shell bridge for the native Planner TUI.
 *
 * It has no database, Kernel, scheduler, or executor dependency. A
 * `proposal_submit` message is only a proposal handoff: MetaclawSession
 * revalidates the v6 plan and remains responsible for the existing
 * DurableKernelWorkflow submission.
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
      if (Buffer.byteLength(buffer) > ANYFUSION_PLANNER_HOST_MAX_LINE_BYTES) {
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
    let request: PlannerHostRequest;
    try {
      const value: unknown = JSON.parse(line);
      if (!isPlannerHostRequest(value)) {
        throw new Error('request must use AnyFusionPlannerHostProtocol v1 and a supported type');
      }
      request = value;
    } catch (error) {
      this.write(socket, this.errorResponse(null, 'invalid_request', (error as Error).message));
      return;
    }

    switch (request.type) {
      case 'hello':
        this.write(socket, {
          protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
          type: 'hello',
          requestId: request.requestId,
          accepted: true,
          capabilities: ['snapshot_get', 'snapshot_subscribe', 'command_complete', 'command_submit', 'proposal_submit', 'ping', 'shutdown'],
        });
        return;
      case 'ping':
        this.write(socket, {
          protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
          type: 'pong',
          requestId: request.requestId,
        });
        return;
      case 'snapshot_get':
        this.write(socket, this.snapshotMessage(request.requestId));
        return;
      case 'snapshot_subscribe': {
        const alreadySubscribed = Boolean(this.unsubscribeSession);
        this.subscribers.add(socket);
        this.write(socket, {
          protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
          type: 'subscribed',
          requestId: request.requestId,
        });
        if (alreadySubscribed) this.write(socket, this.snapshotMessage(null));
        else this.ensureSessionSubscription();
        return;
      }
      case 'command_complete':
        this.write(socket, {
          protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
          type: 'command_completion',
          requestId: request.requestId,
          completion: this.deps.session.completeCommand(request.text, request.cursor),
        });
        return;
      case 'command_submit':
        this.enqueueCommand(socket, request);
        return;
      case 'proposal_submit':
        if (request.sessionId.length === 0 || request.turnId.length === 0 || request.userInput.length === 0) {
          this.write(socket, this.errorResponse(request.requestId, 'invalid_request', 'proposal_submit correlation and user input are required'));
          return;
        }
        this.enqueueProposal(socket, request);
        return;
      case 'shutdown':
        this.write(socket, {
          protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
          type: 'shutdown',
          requestId: request.requestId,
          accepted: true,
        });
        socket.end();
        return;
    }
  }

  private enqueueCommand(socket: Socket, request: Extract<PlannerHostRequest, { type: 'command_submit' }>): void {
    this.submissionQueue = this.submissionQueue
      .catch(() => undefined)
      .then(async () => {
        const result = await this.deps.session.submitPlannerTuiCommand(request.command);
        this.write(socket, {
          protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
          type: 'command_result',
          requestId: request.requestId,
          accepted: true,
          exitRequested: result.exitRequested,
          output: result.output,
        });
      })
      .catch(error => {
        this.deps.logger?.warn(`Planner TUI command failed: ${(error as Error).message}`);
        this.write(socket, {
          protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
          type: 'command_result',
          requestId: request.requestId,
          accepted: false,
          error: { code: 'command_submission_failed', message: (error as Error).message },
        });
      });
  }

  private enqueueProposal(socket: Socket, request: Extract<PlannerHostRequest, { type: 'proposal_submit' }>): void {
    this.submissionQueue = this.submissionQueue
      .catch(() => undefined)
      .then(async () => {
        const result = await this.deps.session.submitPlannerTuiPlan(request.userInput, request.plan);
        if (!result.accepted) {
          this.write(socket, {
            protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
            type: 'proposal_result',
            requestId: request.requestId,
            turnId: request.turnId,
            accepted: false,
            error: {
              code: 'plan_rejected',
              message: 'Planner proposal failed v6 validation',
              ...(result.errors.length > 0 ? { details: result.errors } : {}),
            },
          });
          return;
        }
        this.write(socket, {
          protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
          type: 'proposal_result',
          requestId: request.requestId,
          turnId: request.turnId,
          accepted: true,
          planId: result.planId,
        });
      })
      .catch(error => {
        this.deps.logger?.warn(`Planner TUI bridge proposal failed: ${(error as Error).message}`);
        this.write(socket, {
          protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
          type: 'proposal_result',
          requestId: request.requestId,
          turnId: request.turnId,
          accepted: false,
          error: { code: 'proposal_submission_failed', message: (error as Error).message },
        });
      });
  }

  private ensureSessionSubscription(): void {
    if (this.unsubscribeSession) return;
    this.unsubscribeSession = this.deps.session.subscribe(() => {
      const message = this.snapshotMessage(null);
      for (const socket of this.subscribers) this.write(socket, message);
    });
  }

  private snapshotMessage(requestId: string | null): BridgeMessage {
    return {
      protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
      type: 'snapshot',
      requestId,
      snapshot: this.deps.session.getPlannerTuiSnapshot(),
    };
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

  private errorResponse(
    requestId: string | null,
    code: string,
    message: string,
    details?: string[],
  ): BridgeMessage {
    return {
      protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
      type: 'error',
      requestId,
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
