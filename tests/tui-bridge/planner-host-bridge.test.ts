import { once } from 'node:events';
import { lstat, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlannerProposalResult, PlannerProposalSubmission } from '../../src/planning/planner-proposal.js';
import type {
  PlannerTuiExecutorResult,
  PlannerTuiPermissionRequest,
  PlannerTuiSnapshot,
  SessionSnapshot,
} from '../../src/session/metaclaw-session.js';
import { PlannerHostBridge, type PlannerHostBridgeSession } from '../../src/tui-bridge/planner-host-bridge.js';

class FakeSession implements PlannerHostBridgeSession {
  readonly executorResults: PlannerTuiExecutorResult[] = [];
  readonly permissionRequests: PlannerTuiPermissionRequest[] = [];
  private readonly listeners = new Set<(snapshot: SessionSnapshot) => void>();
  readonly submitPlannerProposal = vi.fn(async (submission: PlannerProposalSubmission): Promise<PlannerProposalResult> => ({
    status: 'accepted',
    turnId: submission.turnId,
    submissionId: submission.submissionId,
    planId: 'plan-1',
    outcome: 'direct_reply_delivered',
    displayText: 'authoritative reply',
    taskId: null,
    kernel: { decisionId: 'decision-1', action: 'deliver_direct_reply', reason: 'reply' },
  }));
  readonly resolvePlannerTuiPermission = vi.fn(async (_requestId: string, resolution: 'approve' | 'deny') => ({
    status: 'resolved' as const, resolution, message: 'recorded',
  }));

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.sessionSnapshot());
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.listeners) listener(this.sessionSnapshot());
  }

  getPlannerTuiExecutorResults(): PlannerTuiExecutorResult[] {
    return this.executorResults.map(result => ({
      ...result,
      artifacts: [...result.artifacts],
      warnings: [...result.warnings],
    }));
  }

  getPlannerTuiPermissionRequests(): PlannerTuiPermissionRequest[] {
    return this.permissionRequests.map(request => ({ ...request }));
  }

  private sessionSnapshot(): SessionSnapshot {
    return {
      output: [], currentTaskId: null, currentTask: null,
      runtimeState: {
        runningTaskId: null, runningExecutorName: null, readyTaskIds: [], blockedTaskIds: [],
        parkedTaskIds: [], lastEvent: 'idle',
      },
      plannerState: { status: 'idle' }, latestGuidance: null,
    };
  }

  getPlannerTuiSnapshot(): PlannerTuiSnapshot {
    return {
      schemaVersion: 1,
      session: {
        id: 'session-1', focusedTask: null,
        runtimeState: {
          runningTaskId: null, runningExecutorName: null, readyTaskIds: [], blockedTaskIds: [],
          parkedTaskIds: [], lastEvent: 'idle',
        },
        plannerState: { status: 'idle' }, recentOutput: [],
      },
      taskPool: [], executorStatuses: [],
    };
  }

  completeCommand(text: string, cursor = text.length) {
    return {
      state: 'incomplete' as const,
      suggestions: [{
        value: 'list', label: 'list', description: 'List tasks',
        replacement: { start: 6, end: cursor, text: 'list' },
      }],
      hint: '/task <list|show>', error: null,
    };
  }

  async submitPlannerTuiCommand(command: string) {
    return { exitRequested: false, output: [`> ${command}`] };
  }
}

const bridges: PlannerHostBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop()));
});

describe('PlannerHostBridge shared Proposal Host', () => {
  it('refuses to replace a reachable live Planner Host socket', async () => {
    const socketPath = join(tmpdir(), `planner-host-${process.pid}-${Date.now()}-live.sock`);
    const first = new PlannerHostBridge({ socketPath });
    const second = new PlannerHostBridge({ socketPath });
    await first.start();

    try {
      await expect(second.start()).rejects.toThrow(/already active/i);
      const socket = await connect(socketPath);
      write(socket, { protocolVersion: 2, type: 'ping', requestId: 'ping-live' });
      expect(await read(socket)).toMatchObject({
        type: 'error',
        requestId: 'ping-live',
        error: { code: 'hello_required' },
      });
      socket.destroy();
    } finally {
      await second.stop();
      await first.stop();
    }
  });

  it('reclaims a stale Planner Host socket', async () => {
    const socketPath = join(tmpdir(), `planner-host-${process.pid}-${Date.now()}-stale.sock`);
    await createStaleSocket(socketPath);
    const staleIdentity = await socketIdentity(socketPath);
    const bridge = new PlannerHostBridge({ socketPath });

    try {
      await bridge.start();
      expect(await socketIdentity(socketPath)).not.toEqual(staleIdentity);
      const socket = await connect(socketPath);
      socket.destroy();
    } finally {
      await bridge.stop();
    }
  });

  it('does not unlink a replacement socket when the original bridge stops', async () => {
    const socketPath = join(tmpdir(), `planner-host-${process.pid}-${Date.now()}-replacement.sock`);
    const bridge = new PlannerHostBridge({ socketPath });
    await bridge.start();
    const originalIdentity = await socketIdentity(socketPath);
    await unlink(socketPath);
    const replacement = createServer(socket => socket.end('replacement'));
    await listen(replacement, socketPath);
    const replacementIdentity = await socketIdentity(socketPath);
    expect(replacementIdentity).not.toEqual(originalIdentity);

    try {
      await bridge.stop();
      expect(await socketIdentity(socketPath)).toEqual(replacementIdentity);
      const socket = await connect(socketPath);
      const [data] = await once(socket, 'data');
      expect(String(data)).toBe('replacement');
      socket.destroy();
    } finally {
      await close(replacement);
      await unlink(socketPath).catch(() => undefined);
    }
  });

  it('binds hello to a registered session and returns the structured authoritative result', async () => {
    const socketPath = join(tmpdir(), `planner-host-${process.pid}-${Date.now()}.sock`);
    const session = new FakeSession();
    const bridge = new PlannerHostBridge({ socketPath });
    bridges.push(bridge);
    bridge.registerSession('session-1', session);
    await bridge.start();
    const socket = await connect(socketPath);

    write(socket, { protocolVersion: 2, type: 'hello', requestId: 'hello-1', runtimeVersion: 'test', sessionId: 'session-1', mode: 'rpc' });
    expect(await read(socket)).toMatchObject({ type: 'hello', accepted: true });
    write(socket, {
      protocolVersion: 2, type: 'proposal_submit', requestId: 'proposal-1',
      turnId: 'turn-1', sessionId: 'session-1', userInput: 'hello',
      submissionId: 'submission-1', purpose: 'kernel', plan: { schemaVersion: 7 },
    });

    expect(await read(socket)).toMatchObject({
      type: 'proposal_result',
      result: { status: 'accepted', submissionId: 'submission-1', displayText: 'authoritative reply' },
    });
    expect(session.submitPlannerProposal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1', turnId: 'turn-1', runtimeMode: 'rpc',
    }), 'kernel');
    socket.destroy();
  });

  it('requires hello and rejects proposal session drift', async () => {
    const socketPath = join(tmpdir(), `planner-host-${process.pid}-${Date.now()}-drift.sock`);
    const bridge = new PlannerHostBridge({ socketPath });
    bridges.push(bridge);
    bridge.registerSession('session-1', new FakeSession());
    await bridge.start();
    const socket = await connect(socketPath);
    write(socket, { protocolVersion: 2, type: 'ping', requestId: 'ping-1' });
    expect(await read(socket)).toMatchObject({ type: 'error', error: { code: 'hello_required' } });
    write(socket, { protocolVersion: 2, type: 'hello', requestId: 'hello-1', runtimeVersion: 'test', sessionId: 'session-1', mode: 'interactive' });
    await read(socket);
    write(socket, {
      protocolVersion: 2, type: 'proposal_submit', requestId: 'proposal-1',
      turnId: 'turn-1', sessionId: 'session-2', userInput: 'hello',
      submissionId: 'submission-1', purpose: 'kernel', plan: {},
    });
    expect(await read(socket)).toMatchObject({ type: 'error', error: { code: 'session_mismatch' } });
    socket.destroy();
  });

  it('fails closed when hello names an unregistered session', async () => {
    const socketPath = join(tmpdir(), `planner-host-${process.pid}-${Date.now()}-unknown.sock`);
    const registered = new FakeSession();
    const bridge = new PlannerHostBridge({ socketPath });
    bridges.push(bridge);
    bridge.registerSession('session-1', registered);
    await bridge.start();
    const socket = await connect(socketPath);

    write(socket, {
      protocolVersion: 2, type: 'hello', requestId: 'hello-unknown', runtimeVersion: 'test',
      sessionId: 'session-2', mode: 'rpc',
    });

    expect(await read(socket)).toMatchObject({
      type: 'error', requestId: 'hello-unknown', error: { code: 'unknown_session' },
    });
    expect(registered.submitPlannerProposal).not.toHaveBeenCalled();
    socket.destroy();
  });

  it('returns transport_uncertain when the authoritative session submission throws', async () => {
    const socketPath = join(tmpdir(), `planner-host-${process.pid}-${Date.now()}-uncertain.sock`);
    const session = new FakeSession();
    session.submitPlannerProposal.mockRejectedValueOnce(new Error('kernel connection lost'));
    const bridge = new PlannerHostBridge({ socketPath });
    bridges.push(bridge);
    bridge.registerSession('session-1', session);
    await bridge.start();
    const socket = await connect(socketPath);

    write(socket, { protocolVersion: 2, type: 'hello', requestId: 'hello-1', runtimeVersion: 'test', sessionId: 'session-1', mode: 'rpc' });
    await read(socket);
    write(socket, {
      protocolVersion: 2, type: 'proposal_submit', requestId: 'proposal-1',
      turnId: 'turn-1', sessionId: 'session-1', userInput: 'hello',
      submissionId: 'submission-1', purpose: 'kernel', plan: { schemaVersion: 7 },
    });

    expect(await read(socket)).toMatchObject({
      type: 'proposal_result',
      result: {
        status: 'transport_uncertain', turnId: 'turn-1', submissionId: 'submission-1',
        retryableByReplay: true, message: 'kernel connection lost',
      },
    });
    socket.destroy();
  });

  it('advertises, replays, and incrementally emits each Executor result once per socket', async () => {
    const socketPath = join(tmpdir(), `planner-host-${process.pid}-${Date.now()}-results.sock`);
    const session = new FakeSession();
    session.executorResults.push(executorResult('publication-1'));
    const bridge = new PlannerHostBridge({ socketPath });
    bridges.push(bridge);
    bridge.registerSession('session-1', session);
    await bridge.start();
    const socket = await connect(socketPath);

    write(socket, { protocolVersion: 2, type: 'hello', requestId: 'hello-1', runtimeVersion: 'test', sessionId: 'session-1', mode: 'interactive' });
    expect(await read(socket)).toMatchObject({
      type: 'hello', capabilities: expect.arrayContaining(['executor_result']),
    });
    write(socket, { protocolVersion: 2, type: 'snapshot_subscribe', requestId: 'subscribe-1' });
    const initial = await readMany(socket, 3);
    expect(initial.map(message => message.type)).toEqual(['snapshot', 'executor_result', 'subscribed']);
    expect(initial[1]).toMatchObject({
      result: { publicationId: 'publication-1', artifacts: ['/workspace/result.md'] },
    });

    session.executorResults.push(executorResult('publication-2'));
    session.emit();
    const incremental = await readMany(socket, 2);
    expect(incremental.map(message => message.type)).toEqual(['snapshot', 'executor_result']);
    expect(incremental[1]).toMatchObject({ result: { publicationId: 'publication-2' } });

    session.emit();
    expect((await readMany(socket, 1))[0]).toMatchObject({ type: 'snapshot' });
    socket.destroy();
  });

  it('truncates only an oversized report while preserving result identity and artifacts', async () => {
    const socketPath = join(tmpdir(), `planner-host-${process.pid}-${Date.now()}-large-result.sock`);
    const session = new FakeSession();
    session.executorResults.push({ ...executorResult('publication-large'), report: 'x'.repeat(1_100_000) });
    const bridge = new PlannerHostBridge({ socketPath });
    bridges.push(bridge);
    bridge.registerSession('session-1', session);
    await bridge.start();
    const socket = await connect(socketPath);

    write(socket, { protocolVersion: 2, type: 'hello', requestId: 'hello-1', runtimeVersion: 'test', sessionId: 'session-1', mode: 'interactive' });
    await read(socket);
    write(socket, { protocolVersion: 2, type: 'snapshot_subscribe', requestId: 'subscribe-1' });
    const messages = await readMany(socket, 3);
    const resultMessage = messages.find(message => message.type === 'executor_result')!;
    expect(Buffer.byteLength(`${JSON.stringify(resultMessage)}\n`)).toBeLessThanOrEqual(1_048_576);
    expect(resultMessage).toMatchObject({
      result: {
        publicationId: 'publication-large',
        artifacts: ['/workspace/result.md'],
        reportTruncated: true,
      },
    });
    expect((resultMessage.result as { report: string }).report).toContain('Executor report truncated');
    socket.destroy();
  });

  it('projects, closes, and resolves interactive permission requests', async () => {
    const socketPath = join(tmpdir(), `planner-host-${process.pid}-${Date.now()}-permissions.sock`);
    const session = new FakeSession();
    session.permissionRequests.push(permissionRequest('permission-1'));
    const bridge = new PlannerHostBridge({ socketPath });
    bridges.push(bridge);
    bridge.registerSession('session-1', session);
    await bridge.start();
    const socket = await connect(socketPath);
    write(socket, { protocolVersion: 2, type: 'hello', requestId: 'hello-1', runtimeVersion: 'test', sessionId: 'session-1', mode: 'interactive' });
    expect(await read(socket)).toMatchObject({ capabilities: expect.arrayContaining(['permission_request']) });
    write(socket, { protocolVersion: 2, type: 'snapshot_subscribe', requestId: 'subscribe-1' });
    const initial = await readMany(socket, 3);
    expect(initial.map(message => message.type)).toEqual(['snapshot', 'permission_request', 'subscribed']);
    write(socket, { protocolVersion: 2, type: 'permission_resolve', requestId: 'resolve-1', permissionRequestId: 'permission-1', resolution: 'approve' });
    expect(await read(socket)).toMatchObject({ type: 'permission_result', result: { status: 'resolved', resolution: 'approve' } });
    expect(session.resolvePlannerTuiPermission).toHaveBeenCalledWith('permission-1', 'approve');
    session.permissionRequests.splice(0);
    session.emit();
    const closed = await readMany(socket, 2);
    expect(closed.map(message => message.type)).toEqual(['snapshot', 'permission_request_closed']);
    socket.destroy();
  });

  it('does not project or accept permission requests on rpc sockets', async () => {
    const socketPath = join(tmpdir(), `planner-host-${process.pid}-${Date.now()}-rpc-permissions.sock`);
    const session = new FakeSession();
    session.permissionRequests.push(permissionRequest('permission-1'));
    const bridge = new PlannerHostBridge({ socketPath });
    bridges.push(bridge);
    bridge.registerSession('session-1', session);
    await bridge.start();
    const socket = await connect(socketPath);
    write(socket, { protocolVersion: 2, type: 'hello', requestId: 'hello-1', runtimeVersion: 'test', sessionId: 'session-1', mode: 'rpc' });
    await read(socket);
    write(socket, { protocolVersion: 2, type: 'permission_resolve', requestId: 'resolve-1', permissionRequestId: 'permission-1', resolution: 'deny' });
    expect(await read(socket)).toMatchObject({ type: 'error', error: { code: 'interactive_required' } });
    expect(session.resolvePlannerTuiPermission).not.toHaveBeenCalled();
    socket.destroy();
  });
});

function permissionRequest(permissionRequestId: string): PlannerTuiPermissionRequest {
  return {
    schemaVersion: 1, permissionRequestId, taskId: 'task-1', taskTitle: 'Task',
    generationId: 'generation-1', subtaskId: 'subtask-1', subtaskTitle: 'Subtask',
    attemptId: 'attempt-1', executorName: 'codex-cli', permissionProfileId: 'restricted-coding',
    capability: 'network', resource: 'https://example.com', operation: 'GET', reason: 'Fetch docs',
    suggestedScope: 'once', escalationReason: 'User approval required',
    createdAt: '2026-08-04T00:00:00.000Z', expiresAt: '2026-08-05T00:00:00.000Z',
  };
}

function executorResult(publicationId: string): PlannerTuiExecutorResult {
  return {
    schemaVersion: 1,
    publicationId,
    taskId: 'task-1',
    taskTitle: 'Ship result',
    subtaskId: 'subtask-1',
    subtaskTitle: 'Implement projection',
    attemptId: 'attempt-1',
    executorName: 'codex-cli',
    report: 'Implemented and verified.',
    artifacts: ['/workspace/result.md'],
    warnings: [],
    integrationCommit: 'abc123',
    completedAt: '2026-08-04T00:00:00.000Z',
    reportTruncated: false,
  };
}

async function connect(socketPath: string): Promise<Socket> {
  const socket = createConnection(socketPath);
  socket.setEncoding('utf8');
  await once(socket, 'connect');
  return socket;
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function socketIdentity(socketPath: string): Promise<{ dev: bigint; ino: bigint }> {
  const stat = await lstat(socketPath, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

async function createStaleSocket(socketPath: string): Promise<void> {
  const script = [
    "const { createServer } = require('node:net');",
    'const server = createServer();',
    `server.listen(${JSON.stringify(socketPath)}, () => process.stdout.write('ready\\n'));`,
  ].join('');
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(child.stdout!, 'data');
  child.kill('SIGKILL');
  await once(child, 'exit');
}

function write(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

async function read(socket: Socket): Promise<Record<string, unknown>> {
  const [chunk] = await once(socket, 'data');
  return JSON.parse(String(chunk).trim()) as Record<string, unknown>;
}

async function readMany(socket: Socket, count: number): Promise<Array<Record<string, unknown>>> {
  let buffer = '';
  while (buffer.split('\n').filter(Boolean).length < count) {
    const [chunk] = await once(socket, 'data');
    buffer += String(chunk);
  }
  return buffer.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}
