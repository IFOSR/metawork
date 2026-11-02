import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import toolStallGuard, { type ToolStallGuardOverrides } from '../../src/executor/pi-tool-stall/index.js';
import { parseToolStallFact, type ProcessCpuRow } from '../../src/executor/tool-stall-core.js';

const HARNESS_GROUP = 42_000;

/** Records the handlers an extension registers, like Pi's own extension host. */
function fakePi() {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  return {
    on: (event: string, handler: (...args: any[]) => any) => {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
      return () => undefined;
    },
    registerTool: vi.fn(),
    async emit(event: string, payload: unknown) {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) result = await handler(payload, {});
      return result;
    },
    handlerCount: (event: string) => (handlers.get(event) ?? []).length,
  };
}

/** The Harness process with one detached tool-call group whose CPU never moves. */
const idleTable: ProcessCpuRow[] = [
  { pid: process.pid, ppid: 1, pgid: HARNESS_GROUP, cpuSeconds: 12 },
  { pid: 43_001, ppid: process.pid, pgid: 43_001, cpuSeconds: 3 },
  { pid: 43_002, ppid: 43_001, pgid: 43_001, cpuSeconds: 0 },
];

const directories: string[] = [];

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'tool-stall-guard-'));
  directories.push(home);
  return home;
}

afterEach(async () => {
  delete process.env.METACLAW_TOOL_STALL_WINDOW_MS;
  delete process.env.METACLAW_TOOL_STALL_SAMPLE_MS;
  delete process.env.METACLAW_TOOL_STALL_FACTS;
  delete process.env.METACLAW_TOOL_STALL_GUARD;
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function factsAt(home: string) {
  const content = await readFile(join(home, '.metaclaw-tool-stall.jsonl'), 'utf8').catch(() => '');
  return content.split('\n').map(parseToolStallFact).filter(fact => fact !== null);
}

describe('Pi tool stall guard wiring', () => {
  it('interrupts a silent tool call and turns its result into an explicit tool error', async () => {
    const home = await temporaryHome();
    process.env.METACLAW_TOOL_STALL_FACTS = join(home, '.metaclaw-tool-stall.jsonl');
    process.env.METACLAW_TOOL_STALL_WINDOW_MS = '40';
    process.env.METACLAW_TOOL_STALL_SAMPLE_MS = '10';
    const signals: Array<{ pgid: number; signal: string }> = [];
    const overrides: ToolStallGuardOverrides = {
      readProcessTable: async () => idleTable,
      signalGroup: (pgid, signal) => { signals.push({ pgid, signal }); },
      readWorkspaceStamp: () => 'stable',
    };
    const pi = fakePi();
    toolStallGuard(pi, overrides);

    await pi.emit('tool_execution_start', {
      toolCallId: 'call_1', toolName: 'bash',
      args: { command: 'python3 links.py https://cloud.tencent.com/document/product/1759' },
    });
    await vi.waitFor(async () => expect(await factsAt(home)).toHaveLength(1), { timeout: 4_000 });

    const [fact] = await factsAt(home);
    expect(fact).toMatchObject({
      event: 'interrupted', toolName: 'bash', processGroup: 43_001,
    });
    expect(fact!.command).toContain('cloud.tencent.com');
    expect(signals).toEqual([{ pgid: 43_001, signal: 'SIGTERM' }]);

    const replaced = await pi.emit('tool_result', {
      toolCallId: 'call_1', toolName: 'bash', input: { command: 'python3 links.py https://cloud.tencent.com/document/product/1759' },
      content: [], isError: false,
    });
    expect(replaced).toMatchObject({ isError: true });
    expect(replaced.content[0].text).toContain('stalled and was interrupted');
    expect(replaced.content[0].text).toContain('Do not repeat this exact call');

    // A second result for the same call is not rewritten twice.
    expect(await pi.emit('tool_result', { toolCallId: 'call_1', toolName: 'bash', content: [] })).toBeUndefined();
    await pi.emit('tool_execution_end', { toolCallId: 'call_1', toolName: 'bash' });
  });

  it('leaves an executing tool alone while it keeps producing output', async () => {
    const home = await temporaryHome();
    process.env.METACLAW_TOOL_STALL_FACTS = join(home, '.metaclaw-tool-stall.jsonl');
    process.env.METACLAW_TOOL_STALL_WINDOW_MS = '40';
    process.env.METACLAW_TOOL_STALL_SAMPLE_MS = '10';
    const signals: Array<{ pgid: number; signal: string }> = [];
    const pi = fakePi();
    toolStallGuard(pi, {
      readProcessTable: async () => idleTable,
      signalGroup: (pgid, signal) => { signals.push({ pgid, signal }); },
      readWorkspaceStamp: () => 'stable',
    });

    await pi.emit('tool_execution_start', { toolCallId: 'call_1', toolName: 'bash', args: { command: 'slow build' } });
    for (let step = 1; step <= 12; step += 1) {
      await new Promise(resolve => setTimeout(resolve, 15));
      await pi.emit('tool_execution_update', { toolCallId: 'call_1', toolName: 'bash', partialResult: `line ${step}` });
    }
    await pi.emit('tool_execution_end', { toolCallId: 'call_1', toolName: 'bash' });

    expect(signals).toEqual([]);
    expect(await factsAt(home)).toEqual([]);
  });

  it('reports instead of killing when the call owns no provable process group', async () => {
    const home = await temporaryHome();
    process.env.METACLAW_TOOL_STALL_FACTS = join(home, '.metaclaw-tool-stall.jsonl');
    process.env.METACLAW_TOOL_STALL_WINDOW_MS = '40';
    process.env.METACLAW_TOOL_STALL_SAMPLE_MS = '10';
    const signals: Array<{ pgid: number; signal: string }> = [];
    const pi = fakePi();
    toolStallGuard(pi, {
      // Two unassignable groups make attribution ambiguous on purpose.
      readProcessTable: async () => [
        { pid: process.pid, ppid: 1, pgid: HARNESS_GROUP, cpuSeconds: 12 },
        { pid: 43_001, ppid: process.pid, pgid: 43_001, cpuSeconds: 0 },
        { pid: 44_001, ppid: process.pid, pgid: 44_001, cpuSeconds: 0 },
      ],
      signalGroup: (pgid, signal) => { signals.push({ pgid, signal }); },
      readWorkspaceStamp: () => 'stable',
    });

    await pi.emit('tool_execution_start', { toolCallId: 'call_1', toolName: 'bash', args: { command: 'sleep 900' } });
    await vi.waitFor(async () => expect(await factsAt(home)).toHaveLength(1), { timeout: 4_000 });

    const [fact] = await factsAt(home);
    expect(fact).toMatchObject({ event: 'stalled', toolName: 'bash' });
    expect(fact!.skipReason).toBeTruthy();
    expect(signals).toEqual([]);
    await pi.emit('tool_execution_end', { toolCallId: 'call_1', toolName: 'bash' });
  });

  it('stays out of the way when the guard is disabled', async () => {
    const home = await temporaryHome();
    process.env.METACLAW_TOOL_STALL_GUARD = '0';
    const pi = fakePi();
    toolStallGuard(pi, { readProcessTable: async () => idleTable });
    expect(pi.handlerCount('tool_execution_start')).toBe(0);
    expect(await factsAt(home)).toEqual([]);
  });
});
