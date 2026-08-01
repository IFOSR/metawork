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
      {
        id: 'task_current',
        title: 'Current task',
        goal: 'Current goal',
        status: 'running',
        blockingReason: null,
        subtasks: [
          {
            id: 'subtask_current',
            title: 'Current subtask',
            status: 'running',
            preferredAgentClassList: ['codex-cli'],
          },
        ],
      },
      {
        id: 'task_ready',
        title: 'Ready task',
        goal: 'Ready goal',
        status: 'ready',
        blockingReason: null,
        subtasks: [],
      },
    ],
    executorStatuses: [],
  };
}

class FakePlannerTuiSession implements PlannerTuiBridgeSession {
  current = snapshot();
  readonly listeners = new Set<(value: SessionSnapshot) => void>();
  readonly submissions: Array<{ userInput: string; plan: unknown }> = [];
  readonly commands: string[] = [];
  readonly completions: Array<{ text: string; cursor: number }> = [];
  result: PlannerTuiPlanSubmissionResult = { accepted: true, errors: [], planId: 'plan_from_tui' };

  subscribe(listener: (value: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.toSessionSnapshot());
    return () => this.listeners.delete(listener);
  }

  getPlannerTuiSnapshot(): PlannerTuiSnapshot {
    return this.current;
  }

  completeCommand(text: string, cursor = text.length) {
    this.completions.push({ text, cursor });
    return {
      state: 'incomplete' as const,
      suggestions: [{
        value: 'list',
        label: 'list',
        description: '列出任务',
        replacement: { start: 6, end: cursor, text: 'list' },
      }],
      hint: '/task <list|show>',
      error: null,
    };
  }

  async submitPlannerTuiPlan(userInput: string, plan: unknown): Promise<PlannerTuiPlanSubmissionResult> {
    this.submissions.push({ userInput, plan });
    return this.result;
  }

  async submitPlannerTuiCommand(command: string): Promise<{ exitRequested: boolean; output: string[] }> {
    this.commands.push(command);
    return { exitRequested: command === '/exit', output: [`> ${command}`, 'MetaClaw command result'] };
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

  itIfUnix('streams a read-only session/task projection and forwards Planner host proposals only through the session port', async () => {
    const session = new FakePlannerTuiSession();
    const socketPath = join(tmpdir(), `metaclaw-planner-tui-${process.pid}-${Date.now()}.sock`);
    const bridge = new PlannerTuiBridge({ socketPath, session });
    bridges.push(bridge);
    await bridge.start();

    const socket = await connect(socketPath);
    sockets.push(socket);
    const received = collectJsonLines(socket);
    socket.write(`${JSON.stringify({ protocolVersion: 1, type: 'snapshot_subscribe', requestId: 'sub-1' })}
`);
    const initial = await received.waitFor(2);
    expect(initial).toEqual(expect.arrayContaining([
      expect.objectContaining({ protocolVersion: 1, type: 'subscribed', requestId: 'sub-1' }),
      expect.objectContaining({
        type: 'snapshot',
        snapshot: expect.objectContaining({
          taskPool: expect.arrayContaining([
            expect.objectContaining({
              id: 'task_current',
              subtasks: [expect.objectContaining({ id: 'subtask_current', status: 'running' })],
            }),
          ]),
        }),
      }),
    ]));

    session.emit(snapshot(['Kernel delivered a reply']));
    const changed = await received.waitFor(3);
    expect(changed.at(-1)).toEqual(expect.objectContaining({
      type: 'snapshot',
      snapshot: expect.objectContaining({ session: expect.objectContaining({ recentOutput: ['Kernel delivered a reply'] }) }),
    }));

    socket.write(`${JSON.stringify({
      protocolVersion: 1,
      type: 'proposal_submit',
      requestId: 'stop-1',
      turnId: 'turn-1',
      sessionId: 'session-test',
      userInput: 'Create a task',
      plan: { schemaVersion: 6 },
    })}
`);
    const complete = await received.waitFor(4);
    expect(complete.at(-1)).toEqual(expect.objectContaining({
      protocolVersion: 1, type: 'proposal_result', requestId: 'stop-1', turnId: 'turn-1',
      accepted: true, planId: 'plan_from_tui',
    }));
    expect(session.submissions).toEqual([{ userInput: 'Create a task', plan: { schemaVersion: 6 } }]);

    socket.write(`${JSON.stringify({
      protocolVersion: 1, type: 'command_complete', requestId: 'complete-1', text: '/task ', cursor: 6,
    })}
`);
    const completion = await received.waitFor(5);
    expect(completion.at(-1)).toEqual({
      protocolVersion: 1,
      type: 'command_completion',
      requestId: 'complete-1',
      completion: {
        state: 'incomplete',
        suggestions: [{
          value: 'list',
          label: 'list',
          description: '列出任务',
          replacement: { start: 6, end: 6, text: 'list' },
        }],
        hint: '/task <list|show>',
        error: null,
      },
    });
    expect(session.completions).toEqual([{ text: '/task ', cursor: 6 }]);

    socket.write(`${JSON.stringify({
      protocolVersion: 1, type: 'command_submit', requestId: 'command-1', command: '/help',
    })}
`);
    const commandComplete = await received.waitFor(6);
    expect(commandComplete.at(-1)).toEqual({
      protocolVersion: 1,
      type: 'command_result',
      requestId: 'command-1',
      accepted: true,
      exitRequested: false,
      output: ['> /help', 'MetaClaw command result'],
    });
    expect(session.commands).toEqual(['/help']);
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
      protocolVersion: 1, type: 'proposal_submit', requestId: 'stop-invalid', turnId: 'turn-invalid',
      sessionId: 'session-test', userInput: 'Bad plan', plan: {},
    })}
`);

    const messages = await received.waitFor(1);
    expect(messages[0]).toEqual(expect.objectContaining({
      protocolVersion: 1, type: 'proposal_result', requestId: 'stop-invalid',
      turnId: 'turn-invalid', accepted: false, error: expect.objectContaining({ code: 'plan_rejected', details: ['schemaVersion: expected 6'] }),
    }));
    expect(session.submissions).toEqual([{ userInput: 'Bad plan', plan: {} }]);
  });
});
