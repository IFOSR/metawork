import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PlannerTuiPlanSubmissionResult,
  PlannerTuiSnapshot,
  SessionSnapshot,
} from '../../src/session/metaclaw-session.js';
import {
  PlannerTuiBridge,
  type PlannerTuiBridgeSession,
} from '../../src/tui-bridge/planner-tui-bridge.js';

function snapshot(output: string[] = []): PlannerTuiSnapshot {
  return {
    schemaVersion: 1,
    session: {
      id: 'sess_bridge',
      focusedTask: { id: 'task_current', title: 'Current task', status: 'running' },
      runtimeState: {
        runningTaskId: 'task_current',
        runningExecutorName: 'codex-cli',
        readyTaskIds: ['task_ready'],
        blockedTaskIds: [],
        parkedTaskIds: [],
        lastEvent: 'running',
      },
      plannerState: { status: 'idle' },
      recentOutput: output,
    },
    taskPool: [
      { id: 'task_current', title: 'Current task', goal: 'Current goal', status: 'running' },
      { id: 'task_ready', title: 'Ready task', goal: 'Ready goal', status: 'ready' },
    ],
    executorStatuses: [],
  };
}

class FakePlannerTuiSession implements PlannerTuiBridgeSession {
  current = snapshot();
  readonly listeners = new Set<(value: SessionSnapshot) => void>();
  readonly submissions: Array<{ userInput: string; plan: unknown }> = [];
  result: PlannerTuiPlanSubmissionResult = { accepted: true, errors: [], planId: 'plan_from_tui' };

  subscribe(listener: (value: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.toSessionSnapshot());
    return () => this.listeners.delete(listener);
  }

  getPlannerTuiSnapshot(): PlannerTuiSnapshot {
    return this.current;
  }

  async submitPlannerTuiPlan(userInput: string, plan: unknown): Promise<PlannerTuiPlanSubmissionResult> {
    this.submissions.push({ userInput, plan });
    return this.result;
  }

  emit(next: PlannerTuiSnapshot): void {
    this.current = next;
    for (const listener of this.listeners) listener(this.toSessionSnapshot());
  }

  private toSessionSnapshot(): SessionSnapshot {
    return {
      output: this.current.session.recentOutput,
      currentTaskId: this.current.session.focusedTask?.id ?? null,
      currentTask: this.current.session.focusedTask,
      runtimeState: this.current.session.runtimeState,
      plannerState: this.current.session.plannerState,
      latestGuidance: null,
    };
  }
}

async function connect(socketPath: string): Promise<Socket> {
  const socket = createConnection(socketPath);
  await once(socket, 'connect');
  socket.setEncoding('utf8');
  return socket;
}

function collectJsonLines(socket: Socket): { lines: unknown[]; waitFor: (count: number) => Promise<unknown[]> } {
  const lines: unknown[] = [];
  let buffer = '';
  const waiters: Array<{ count: number; resolve: (value: unknown[]) => void }> = [];
  socket.on('data', chunk => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      lines.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
    for (const waiter of waiters.splice(0)) {
      if (lines.length >= waiter.count) waiter.resolve([...lines]);
      else waiters.push(waiter);
    }
  });
  return {
    lines,
    waitFor: count => lines.length >= count
      ? Promise.resolve([...lines])
      : new Promise(resolve => waiters.push({ count, resolve })),
  };
}

const itIfUnix = process.platform === 'win32' ? it.skip : it;

describe('PlannerTuiBridge', () => {
  const bridges: PlannerTuiBridge[] = [];
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await Promise.all(bridges.splice(0).map(bridge => bridge.stop()));
  });

  itIfUnix('streams a read-only session/task projection and forwards Stop-hook proposals only through the session port', async () => {
    const session = new FakePlannerTuiSession();
    const socketPath = join(tmpdir(), `metaclaw-planner-tui-${process.pid}-${Date.now()}.sock`);
    const bridge = new PlannerTuiBridge({ socketPath, session });
    bridges.push(bridge);
    await bridge.start();

    const socket = await connect(socketPath);
    sockets.push(socket);
    const received = collectJsonLines(socket);
    socket.write(`${JSON.stringify({ type: 'subscribe', requestId: 'sub-1' })}
`);
    const initial = await received.waitFor(2);
    expect(initial).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'response', requestId: 'sub-1', ok: true }),
      expect.objectContaining({ type: 'snapshot', snapshot: expect.objectContaining({ taskPool: expect.any(Array) }) }),
    ]));

    session.emit(snapshot(['Kernel delivered a reply']));
    const changed = await received.waitFor(3);
    expect(changed.at(-1)).toEqual(expect.objectContaining({
      type: 'snapshot',
      snapshot: expect.objectContaining({ session: expect.objectContaining({ recentOutput: ['Kernel delivered a reply'] }) }),
    }));

    socket.write(`${JSON.stringify({
      type: 'planner_stop',
      requestId: 'stop-1',
      userInput: 'Create a task',
      plan: { schemaVersion: 6 },
    })}
`);
    const complete = await received.waitFor(4);
    expect(complete.at(-1)).toEqual(expect.objectContaining({
      type: 'response', requestId: 'stop-1', ok: true,
      result: { accepted: true, planId: 'plan_from_tui' },
    }));
    expect(session.submissions).toEqual([{ userInput: 'Create a task', plan: { schemaVersion: 6 } }]);
  });

  itIfUnix('returns validation failures from the Session without retrying or granting a write surface', async () => {
    const session = new FakePlannerTuiSession();
    session.result = { accepted: false, errors: ['schemaVersion: expected 6'], planId: null };
    const socketPath = join(tmpdir(), `metaclaw-planner-tui-${process.pid}-${Date.now()}-invalid.sock`);
    const bridge = new PlannerTuiBridge({ socketPath, session });
    bridges.push(bridge);
    await bridge.start();

    const socket = await connect(socketPath);
    sockets.push(socket);
    const received = collectJsonLines(socket);
    socket.write(`${JSON.stringify({
      type: 'planner_stop', requestId: 'stop-invalid', userInput: 'Bad plan', plan: {},
    })}
`);

    const messages = await received.waitFor(1);
    expect(messages[0]).toEqual(expect.objectContaining({
      type: 'response', requestId: 'stop-invalid', ok: false,
      error: expect.objectContaining({ code: 'plan_rejected', details: ['schemaVersion: expected 6'] }),
    }));
    expect(session.submissions).toEqual([{ userInput: 'Bad plan', plan: {} }]);
  });
});
