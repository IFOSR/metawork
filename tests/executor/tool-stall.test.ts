import { describe, expect, it, vi } from 'vitest';
import {
  TOOL_STALL_FUSE_COUNT,
  TOOL_STALL_WINDOW_MS,
  ToolStallFuse,
  ToolStallGuard,
  advanceToolProgress,
  describeToolStall,
  formatStallDuration,
  isToolCallStalled,
  parsePsCpuSeconds,
  parseToolStallFact,
  toolStallFailureMessage,
  toolStallUnrecoverableMessage,
  type ProcessCpuRow,
  type ToolStallFact,
} from '../../src/executor/tool-stall-core.js';

const HARNESS_PID = 900;

/** Harness process plus a detached tool-call group (`bash -> python -> chrome`). */
function processTable(input: {
  harnessCpu?: number;
  groupCpu?: number;
  groups?: Array<{ pgid: number; cpu: number }>;
}): ProcessCpuRow[] {
  const rows: ProcessCpuRow[] = [
    { pid: HARNESS_PID, ppid: 1, pgid: HARNESS_PID, cpuSeconds: input.harnessCpu ?? 10 },
  ];
  if (input.groups) {
    for (const group of input.groups) {
      rows.push(
        { pid: group.pgid, ppid: HARNESS_PID, pgid: group.pgid, cpuSeconds: group.cpu },
        { pid: group.pgid + 1, ppid: group.pgid, pgid: group.pgid, cpuSeconds: 0 },
      );
    }
    return rows;
  }
  const pgid = 400;
  rows.push(
    { pid: pgid, ppid: HARNESS_PID, pgid, cpuSeconds: input.groupCpu ?? 1 },
    { pid: pgid + 1, ppid: pgid, pgid, cpuSeconds: 0 },
    { pid: pgid + 2, ppid: pgid + 1, pgid, cpuSeconds: 0 },
  );
  return rows;
}

function guardHarness(overrides: {
  rows: ProcessCpuRow[];
  now: () => number;
  workspaceStamp?: () => string;
}) {
  const facts: ToolStallFact[] = [];
  const signals: Array<{ pgid: number; signal: string }> = [];
  const guard = new ToolStallGuard({
    selfPid: HARNESS_PID,
    now: overrides.now,
    windowMs: TOOL_STALL_WINDOW_MS,
    sampleMs: 60_000,
    readProcessTable: async () => overrides.rows,
    signalGroup: (pgid, signal) => { signals.push({ pgid, signal }); },
    readWorkspaceStamp: overrides.workspaceStamp ?? (() => 'stable'),
    writeFact: fact => { facts.push(fact); },
  });
  return { guard, facts, signals };
}

describe('tool stall facts', () => {
  it('parses a side-channel line and drops malformed entries', () => {
    const fact: ToolStallFact = {
      event: 'interrupted', toolCallId: 'call_1', toolName: 'bash',
      command: 'python3 links.py https://example.com', stalledMs: 300_000,
      processGroup: 400, at: '2026-11-02T02:00:00.000Z',
    };
    expect(parseToolStallFact(JSON.stringify(fact))).toEqual(fact);
    expect(parseToolStallFact('')).toBeNull();
    expect(parseToolStallFact('{')).toBeNull();
    expect(parseToolStallFact(JSON.stringify({ event: 'other', toolCallId: 'x', at: 'y' }))).toBeNull();
    expect(parseToolStallFact(JSON.stringify({ event: 'stalled', at: 'y' }))).toBeNull();
  });

  it('keeps an unattributable stall honest about the missing process group', () => {
    const fact = parseToolStallFact(JSON.stringify({
      event: 'stalled', toolCallId: 'call_2', toolName: 'bash', command: 'sleep 900',
      stalledMs: 300_000, skipReason: '未找到属于该工具调用的进程组', at: '2026-11-02T02:00:00.000Z',
    }));
    expect(describeToolStall(fact!)).toContain('无法确认该调用的进程归属');
    expect(toolStallUnrecoverableMessage(fact!)).toContain('未能自动中断');
  });

  it('names the tool, command and silence in the user-visible fact', () => {
    const fact: ToolStallFact = {
      event: 'interrupted', toolCallId: 'call_3', toolName: 'bash',
      command: 'python3 links.py https://cloud.tencent.com/document/product/1759',
      stalledMs: 300_000, processGroup: 400, at: '2026-11-02T02:00:00.000Z',
    };
    const text = describeToolStall(fact);
    expect(text).toContain('已中断停滞的工具调用');
    expect(text).toContain('cloud.tencent.com');
    expect(text).toContain('5 分钟');
    expect(text).toContain('进程组 400');
  });

  it('reports repeated stalls as a failure the user re-runs', () => {
    const message = toolStallFailureMessage({
      interruptions: TOOL_STALL_FUSE_COUNT,
      last: {
        event: 'interrupted', toolCallId: 'call_4', toolName: 'bash',
        command: 'python3 links.py https://example.com', stalledMs: 300_000,
        processGroup: 400, at: '2026-11-02T02:00:00.000Z',
      },
    });
    expect(message).toContain('执行失败');
    expect(message).toContain('3 次');
    expect(message).toContain('请重新执行任务');
  });

  it('formats durations and parses both ps CPU time layouts', () => {
    expect(formatStallDuration(300_000)).toBe('5 分钟');
    expect(parsePsCpuSeconds('0:57.72')).toBeCloseTo(57.72, 2);
    expect(parsePsCpuSeconds('260:06.96')).toBeCloseTo(260 * 60 + 6.96, 2);
    expect(parsePsCpuSeconds('1:02:03')).toBe(3723);
    expect(parsePsCpuSeconds('2-01:02:03')).toBe(2 * 86_400 + 3723);
    expect(parsePsCpuSeconds('')).toBe(0);
  });
});

describe('three-signal progress judgement', () => {
  const base = { outputBytes: 0, cpuSeconds: 0, workspaceStamp: 'stable', lastProgressAt: 0 };

  it('treats growth in any single signal as progress', () => {
    const now = 1_000;
    expect(advanceToolProgress(base, { ...base, outputBytes: 10 }, now).lastProgressAt).toBe(now);
    expect(advanceToolProgress(base, { ...base, cpuSeconds: 1.5 }, now).lastProgressAt).toBe(now);
    expect(advanceToolProgress(base, { ...base, workspaceStamp: 'changed' }, now).lastProgressAt).toBe(now);
  });

  it('keeps the last progress time when all three signals stand still', () => {
    const stale = { ...base, lastProgressAt: 5_000 };
    expect(advanceToolProgress(stale, { ...base }, 900_000).lastProgressAt).toBe(5_000);
    expect(isToolCallStalled({ now: 900_000, lastProgressAt: 5_000, windowMs: 300_000 })).toBe(true);
    expect(isToolCallStalled({ now: 200_000, lastProgressAt: 5_000, windowMs: 300_000 })).toBe(false);
  });

  it('ignores ps rounding noise so an idle subtree stays idle', () => {
    const stale = { ...base, cpuSeconds: 12, lastProgressAt: 5_000 };
    expect(advanceToolProgress(stale, { ...base, cpuSeconds: 12.01 }, 900_000).lastProgressAt).toBe(5_000);
  });
});

describe('ToolStallFuse', () => {
  it('self-heals until the limit and then trips', () => {
    const fuse = new ToolStallFuse();
    expect(fuse.record()).toEqual({ count: 1, tripped: false });
    expect(fuse.record()).toEqual({ count: 2, tripped: false });
    expect(fuse.record()).toEqual({ count: 3, tripped: true });
    expect(fuse.interruptions).toBe(3);
  });
});

describe('ToolStallGuard', () => {
  it('never interrupts a call that keeps producing output', async () => {
    let now = 0;
    const { guard, facts, signals } = guardHarness({ rows: processTable({}), now: () => now });
    guard.begin({ toolCallId: 'call_1', toolName: 'bash', command: 'slow build' });
    for (let step = 0; step < 8; step += 1) {
      now += 60_000;
      guard.observeOutput({ toolCallId: 'call_1', outputBytes: (step + 1) * 100 });
      await guard.sample();
    }
    expect(signals).toEqual([]);
    expect(facts).toEqual([]);
  });

  it('never interrupts a silent call that keeps consuming CPU', async () => {
    let now = 0;
    let cpu = 1;
    const { guard, facts, signals } = guardHarness({
      rows: [], now: () => now,
    });
    const guardWithCpu = new ToolStallGuard({
      selfPid: HARNESS_PID,
      now: () => now,
      windowMs: TOOL_STALL_WINDOW_MS,
      sampleMs: 60_000,
      readProcessTable: async () => processTable({ groupCpu: cpu }),
      signalGroup: (pgid, signal) => { signals.push({ pgid, signal }); },
      readWorkspaceStamp: () => 'stable',
      writeFact: fact => { facts.push(fact); },
    });
    guardWithCpu.begin({ toolCallId: 'call_1', toolName: 'bash', command: 'compile' });
    for (let step = 0; step < 8; step += 1) {
      now += 60_000;
      cpu += 30;
      await guardWithCpu.sample();
    }
    expect(signals).toEqual([]);
    expect(facts).toEqual([]);
    guard.dispose();
    guardWithCpu.dispose();
  });

  it('interrupts an idle call once the window elapses and records the group', async () => {
    let now = 0;
    const { guard, facts, signals } = guardHarness({ rows: processTable({}), now: () => now });
    guard.begin({ toolCallId: 'call_1', toolName: 'bash', command: 'python3 links.py https://example.com' });

    now = 60_000;
    await guard.sample();
    expect(signals).toEqual([]);

    // The first sample still saw fresh CPU, so the window restarts there.
    now = 60_000 + TOOL_STALL_WINDOW_MS + 1;
    await guard.sample();
    expect(signals).toEqual([{ pgid: 400, signal: 'SIGTERM' }]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      event: 'interrupted', toolCallId: 'call_1', toolName: 'bash',
      command: 'python3 links.py https://example.com', processGroup: 400,
    });
    expect(facts[0]!.stalledMs).toBeGreaterThanOrEqual(TOOL_STALL_WINDOW_MS);
    await guard.sample();
    expect(signals).toHaveLength(1);
    expect(guard.consumeInterrupted('call_1')).toBe(true);
    expect(guard.consumeInterrupted('call_1')).toBe(false);
    guard.dispose();
  });

  it('reports instead of killing when the process group cannot be proven', async () => {
    let now = 0;
    const facts: ToolStallFact[] = [];
    const signals: Array<{ pgid: number; signal: string }> = [];
    const guard = new ToolStallGuard({
      selfPid: HARNESS_PID,
      now: () => now,
      windowMs: TOOL_STALL_WINDOW_MS,
      sampleMs: 60_000,
      // Two unassignable groups with a single pending call is ambiguous.
      readProcessTable: async () => processTable({ groups: [{ pgid: 400, cpu: 0 }, { pgid: 500, cpu: 0 }] }),
      signalGroup: (pgid, signal) => { signals.push({ pgid, signal }); },
      readWorkspaceStamp: () => 'stable',
      writeFact: fact => { facts.push(fact); },
    });
    guard.begin({ toolCallId: 'call_1', toolName: 'bash', command: 'sleep 900' });
    now = TOOL_STALL_WINDOW_MS + 1;
    await guard.sample();
    await guard.sample();
    expect(signals).toEqual([]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ event: 'stalled', toolCallId: 'call_1' });
    expect(facts[0]!.skipReason).toBeTruthy();
    expect(guard.consumeInterrupted('call_1')).toBe(false);
    guard.dispose();
  });

  it('stops tracking a finished call so a later tool is judged on its own', async () => {
    let now = 0;
    const { guard, signals } = guardHarness({ rows: processTable({}), now: () => now });
    guard.begin({ toolCallId: 'call_1', toolName: 'read', command: '' });
    guard.end('call_1');
    now = TOOL_STALL_WINDOW_MS * 4;
    await guard.sample();
    expect(signals).toEqual([]);
    guard.dispose();
  });
});
