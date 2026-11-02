/**
 * Pure tool-call stall facts shared by the MetaWork host and the Pi stall guard.
 *
 * A single tool call is judged stalled only when all three progress signals
 * stop together: the call produces no output, its process subtree consumes no
 * CPU, and the workspace receives no new writes. Elapsed time alone is never a
 * verdict, and there is deliberately no wall-clock limit for commands that keep
 * making progress.
 */

/** Silence window before a tool call counts as stalled. Not a task time limit. */
export const TOOL_STALL_WINDOW_MS = 300_000;
/** Sampling period for the three progress signals. */
export const TOOL_STALL_SAMPLE_MS = 15_000;
/** Stalls inside one Attempt before the host stops it and reports the failure. */
export const TOOL_STALL_FUSE_COUNT = 3;
/** Side-channel the Pi guard appends stall facts to. */
export const TOOL_STALL_FACTS_FILE = '.metaclaw-tool-stall.jsonl';

export type ToolStallEvent = 'stalled' | 'interrupted';

export interface ToolStallFact {
  /** `stalled` observes the call; `interrupted` confirms the kill attempt. */
  event: ToolStallEvent;
  /** Pi tool call id the fact belongs to. */
  toolCallId: string;
  toolName: string;
  /** Bounded command/input summary, never the full payload. */
  command: string;
  /** Consecutive progress-free time when the fact was written. */
  stalledMs: number;
  /** Process group that was terminated; absent when ownership was unclear. */
  processGroup?: number;
  /** Why the kill was skipped, when it was. */
  skipReason?: string;
  at: string;
}

export interface ToolProgressSample {
  /** Tool output bytes observed so far. */
  outputBytes: number;
  /** Cumulative CPU seconds of the call's process subtree. */
  cpuSeconds: number;
  /** Workspace fingerprint: directory stamp plus capture spool size. */
  workspaceStamp: string;
}

export interface ToolProgressState extends ToolProgressSample {
  /** Last sample at which at least one signal moved. */
  lastProgressAt: number;
}

/**
 * Folds one sample into the progress state. Any moving signal refreshes the
 * progress time; a sample where all three stand still leaves it untouched.
 */
export function advanceToolProgress(
  state: ToolProgressState,
  sample: ToolProgressSample,
  now: number,
): ToolProgressState {
  const moved = sample.outputBytes > state.outputBytes
    || sample.cpuSeconds > state.cpuSeconds + CPU_EPSILON_SECONDS
    || sample.workspaceStamp !== state.workspaceStamp;
  return {
    ...sample,
    lastProgressAt: moved ? now : state.lastProgressAt,
  };
}

/** Tolerance for `ps` CPU-time rounding so idle subtrees stay idle. */
const CPU_EPSILON_SECONDS = 0.02;

export function isToolCallStalled(input: {
  now: number;
  lastProgressAt: number;
  windowMs?: number;
}): boolean {
  const windowMs = input.windowMs ?? TOOL_STALL_WINDOW_MS;
  return input.now - input.lastProgressAt >= windowMs;
}

export interface ToolStallFuseDecision {
  /** Interruptions recorded so far, including this one. */
  count: number;
  /** The Attempt must stop now and report a failure. */
  tripped: boolean;
}

/**
 * Counts interruptions inside one Attempt. The first stalls are self-healed by
 * the guard; reaching the limit means the Executor is looping and the Attempt
 * stops with an explicit failure instead of retrying forever.
 */
export class ToolStallFuse {
  private count = 0;

  constructor(private readonly limit: number = TOOL_STALL_FUSE_COUNT) {}

  get interruptions(): number {
    return this.count;
  }

  record(): ToolStallFuseDecision {
    this.count += 1;
    return { count: this.count, tripped: this.count >= Math.max(1, this.limit) };
  }
}

const TOOL_STALL_EVENTS = new Set<ToolStallEvent>(['stalled', 'interrupted']);

/** Parses one side-channel line. Unknown or malformed entries are dropped. */
export function parseToolStallFact(line: string): ToolStallFact | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const event = typeof record.event === 'string' ? record.event as ToolStallEvent : null;
  if (!event || !TOOL_STALL_EVENTS.has(event)) return null;
  const toolCallId = nonEmpty(record.toolCallId);
  const at = nonEmpty(record.at);
  if (!toolCallId || !at) return null;
  const processGroup = typeof record.processGroup === 'number' && Number.isInteger(record.processGroup)
    && record.processGroup > 0
    ? record.processGroup
    : undefined;
  const skipReason = nonEmpty(record.skipReason);
  return {
    event,
    toolCallId,
    toolName: nonEmpty(record.toolName)?.slice(0, 120) ?? 'unknown',
    command: nonEmpty(record.command)?.slice(0, 400) ?? '',
    stalledMs: typeof record.stalledMs === 'number' && Number.isFinite(record.stalledMs) && record.stalledMs >= 0
      ? record.stalledMs
      : 0,
    ...(processGroup !== undefined ? { processGroup } : {}),
    ...(skipReason ? { skipReason } : {}),
    at,
  };
}

/** Seconds formatter used in user-visible facts. */
export function formatStallDuration(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  return `${minutes} 分钟`;
}

/** User-visible progress text for an observed or handled stall. */
export function describeToolStall(fact: ToolStallFact): string {
  const tool = fact.toolName === 'bash' ? 'bash 命令' : `${fact.toolName} 工具调用`;
  const target = fact.command ? `「${fact.command}」` : '';
  const silent = `连续 ${formatStallDuration(fact.stalledMs)} 无输出、无 CPU 活动、无工作区写入`;
  if (fact.event === 'interrupted' && fact.processGroup !== undefined) {
    return `已中断停滞的工具调用：${tool}${target}${silent}（进程组 ${fact.processGroup} 已终止），Agent 将继续改用其他途径`;
  }
  const reason = fact.skipReason ? `（${fact.skipReason}）` : '';
  return `工具调用停滞：${tool}${target}${silent}；无法确认该调用的进程归属，未执行中断${reason}`;
}

/** Failure summary reported when the Attempt stops after repeated stalls. */
export function toolStallFailureMessage(input: {
  interruptions: number;
  last: ToolStallFact | null;
}): string {
  const tool = input.last
    ? `${input.last.toolName === 'bash' ? 'bash 命令' : input.last.toolName}${input.last.command ? `「${input.last.command}」` : ''}`
    : '工具调用';
  const silent = input.last
    ? `连续 ${formatStallDuration(input.last.stalledMs)} 无输出、无 CPU 活动、无工作区写入`
    : '反复停滞';
  return `执行失败：工具调用在同一 Attempt 内反复停滞并已中断 ${input.interruptions} 次`
    + `（最后一次为 ${tool}${silent}）。本次执行已停止且未产出可用结果，请重新执行任务。`;
}

/**
 * Failure summary for a stall that could not be interrupted because the call's
 * process group could not be proven. Continuing would hang forever, so the
 * Attempt stops instead of waiting for the user to notice.
 */
export function toolStallUnrecoverableMessage(fact: ToolStallFact): string {
  const tool = `${fact.toolName === 'bash' ? 'bash 命令' : fact.toolName}${fact.command ? `「${fact.command}」` : ''}`;
  const reason = fact.skipReason ? `（${fact.skipReason}）` : '';
  return `执行失败：工具调用停滞且无法确认其进程归属，未能自动中断${reason}`
    + `。本次执行已停止且未产出可用结果，请重新执行任务。最后一次停滞：${tool}连续 `
    + `${formatStallDuration(fact.stalledMs)} 无输出、无 CPU 活动、无工作区写入。`;
}

/**
 * Parses the CPU time column of `ps -o time`. Accepts `SS.ss`, `MM:SS`,
 * `HH:MM:SS` and `DD-HH:MM:SS` so macOS and Linux hosts agree.
 */
export function parsePsCpuSeconds(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const [daysPart, clockPart] = trimmed.includes('-')
    ? [trimmed.slice(0, trimmed.indexOf('-')), trimmed.slice(trimmed.indexOf('-') + 1)]
    : ['0', trimmed];
  const days = Number.parseFloat(daysPart);
  if (!Number.isFinite(days)) return 0;
  const segments = clockPart.split(':');
  if (segments.length === 0 || segments.length > 3) return 0;
  let seconds = 0;
  for (const segment of segments) {
    const parsed = Number.parseFloat(segment);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    seconds = seconds * 60 + parsed;
  }
  return days * 86_400 + seconds;
}

// ─── Guard ─────────────────────────────────────────────────────────────────

export interface ProcessCpuRow {
  pid: number;
  ppid: number;
  pgid: number;
  cpuSeconds: number;
}

export interface ToolStallGuardDependencies {
  /** Host process the guard belongs to (the Harness itself). */
  selfPid: number;
  now?: () => number;
  windowMs?: number;
  sampleMs?: number;
  /** Grace before SIGKILL of an interrupted group. */
  killGraceMs?: number;
  readProcessTable: () => Promise<readonly ProcessCpuRow[]>;
  signalGroup: (pgid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  /** Workspace fingerprint; changes mean the call produced files. */
  readWorkspaceStamp: () => string;
  /** Persists one fact; failures must never break tool execution. */
  writeFact: (fact: ToolStallFact) => void;
}

interface TrackedCall {
  toolCallId: string;
  toolName: string;
  command: string;
  startedAt: number;
  outputBytes: number;
  progress: ToolProgressState;
  processGroup?: number;
  /** Pids observed in the group when it was interrupted. */
  members: number[];
  skipReason?: string;
  interrupting: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Watches in-flight tool calls and interrupts a single stalled call.
 *
 * Ownership is derived from the process groups the Harness started: a call that
 * owns an unclaimed group is interrupted; a call whose group cannot be proven
 * is reported but never killed. The Attempt itself is never terminated here.
 */
export class ToolStallGuard {
  private readonly calls = new Map<string, TrackedCall>();
  private readonly interrupting = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private sampling = false;

  constructor(private readonly deps: ToolStallGuardDependencies) {}

  get windowMs(): number {
    return this.deps.windowMs ?? TOOL_STALL_WINDOW_MS;
  }

  /** Tool calls this guard already killed; their results must be rewritten. */
  get interruptedCalls(): ReadonlySet<string> {
    return this.interrupting;
  }

  start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => { void this.sample(); }, this.deps.sampleMs ?? TOOL_STALL_SAMPLE_MS);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const call of this.calls.values()) {
      if (call.killTimer) clearTimeout(call.killTimer);
    }
    this.calls.clear();
  }

  begin(input: { toolCallId: string; toolName: string; command: string }): void {
    if (this.disposed || !input.toolCallId) return;
    const now = this.now();
    // The baseline is captured at call start so the first sample reflects real
    // movement rather than the transition from "no observation" to "observed".
    const workspaceStamp = this.safeWorkspaceStamp();
    this.calls.set(input.toolCallId, {
      toolCallId: input.toolCallId,
      toolName: input.toolName || 'unknown',
      command: input.command.slice(0, 400),
      startedAt: now,
      outputBytes: 0,
      progress: { outputBytes: 0, cpuSeconds: 0, workspaceStamp, lastProgressAt: now },
      members: [],
      interrupting: false,
    });
    this.start();
  }

  /** Records streamed tool output; any output is progress by definition. */
  observeOutput(input: { toolCallId: string; outputBytes: number }): void {
    const call = this.calls.get(input.toolCallId);
    if (!call) return;
    call.outputBytes = Math.max(call.outputBytes, input.outputBytes);
    call.progress.lastProgressAt = this.now();
  }

  end(toolCallId: string): void {
    const call = this.calls.get(toolCallId);
    if (call?.killTimer) clearTimeout(call.killTimer);
    this.calls.delete(toolCallId);
  }

  /** Whether a finished call was interrupted by this guard. */
  consumeInterrupted(toolCallId: string): boolean {
    if (!this.interrupting.has(toolCallId)) return false;
    this.interrupting.delete(toolCallId);
    return true;
  }

  /** One sampling pass. Exposed so hosts and tests drive time explicitly. */
  async sample(): Promise<void> {
    if (this.disposed || this.sampling || this.calls.size === 0) return;
    this.sampling = true;
    try {
      const now = this.now();
      const rows = [...await this.deps.readProcessTable()];
      this.assignProcessGroups(rows);
      const workspaceStamp = this.safeWorkspaceStamp();
      for (const call of [...this.calls.values()]) {
        if (call.interrupting) continue;
        const sample = {
          outputBytes: call.outputBytes,
          cpuSeconds: this.subtreeCpuSeconds(rows, call.processGroup),
          workspaceStamp,
        };
        call.progress = advanceToolProgress(call.progress, sample, now);
        if (!isToolCallStalled({ now, lastProgressAt: call.progress.lastProgressAt, windowMs: this.windowMs })) continue;
        this.interrupt(call, now, rows);
      }
    } catch {
      // Observation must never break the Executor loop.
    } finally {
      this.sampling = false;
    }
  }

  private interrupt(call: TrackedCall, now: number, rows: readonly ProcessCpuRow[]): void {
    const stalledMs = now - call.progress.lastProgressAt;
    call.interrupting = true;
    const base = {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      command: call.command,
      stalledMs,
      at: new Date(now).toISOString(),
    };
    const pgid = call.processGroup;
    if (pgid === undefined) {
      // The attempt stays honest: report the stall without guessing a victim.
      // The host stops the Attempt because this call cannot self-heal.
      this.writeFact({
        ...base,
        event: 'stalled',
        skipReason: call.skipReason ?? '未找到属于该工具调用的进程组',
      });
      return;
    }
    call.members = rows.filter(row => row.pgid === pgid).map(row => row.pid);
    this.interrupting.add(call.toolCallId);
    this.writeFact({ ...base, event: 'interrupted', processGroup: pgid });
    this.signal(pgid, 'SIGTERM');
    const graceMs = this.deps.killGraceMs ?? 5_000;
    call.killTimer = setTimeout(() => { void this.escalate(call, pgid); }, graceMs);
    (call.killTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * SIGKILL only while the recorded members are still alive, so a recycled
   * process group id can never hit an unrelated process.
   */
  private async escalate(call: TrackedCall, pgid: number): Promise<void> {
    let rows: readonly ProcessCpuRow[];
    try {
      rows = await this.deps.readProcessTable();
    } catch {
      return;
    }
    const alive = rows.some(row => row.pgid === pgid && call.members.includes(row.pid));
    if (!alive) return;
    this.signal(pgid, 'SIGKILL');
  }

  private signal(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
    try {
      this.deps.signalGroup(pgid, signal);
    } catch {
      // A group that already exited needs no escalation.
    }
  }

  /**
   * Attributes direct children of the Harness to calls that have no group yet.
   *
   * Newer calls own newer process groups, so an equal number of unclaimed
   * groups and unassigned calls is paired by order. Anything else is recorded
   * as ambiguous rather than guessed: an unattributable call is reported but
   * never killed.
   */
  private assignProcessGroups(rows: readonly ProcessCpuRow[]): void {
    const claimed = new Set<number>();
    for (const call of this.calls.values()) {
      if (call.processGroup !== undefined) claimed.add(call.processGroup);
    }
    const ownGroup = this.ownGroup(rows);
    const unclaimed: number[] = [];
    for (const row of rows) {
      if (row.ppid !== this.deps.selfPid) continue;
      if (row.pgid <= 0 || row.pgid === ownGroup) continue;
      if (claimed.has(row.pgid) || unclaimed.includes(row.pgid)) continue;
      unclaimed.push(row.pgid);
    }
    const pending = [...this.calls.values()].filter(call => call.processGroup === undefined);
    if (unclaimed.length === 0 || pending.length === 0) return;
    if (unclaimed.length !== pending.length) {
      for (const call of pending) call.skipReason = '同时存在无法归属的进程组';
      return;
    }
    unclaimed.sort((left, right) => left - right);
    pending.sort((left, right) => left.startedAt - right.startedAt);
    for (const [index, call] of pending.entries()) {
      call.processGroup = unclaimed[index];
      call.skipReason = undefined;
    }
  }

  /** The Harness's own group must never be treated as a tool call's group. */
  private ownGroup(rows: readonly ProcessCpuRow[]): number {
    return rows.find(row => row.pid === this.deps.selfPid)?.pgid ?? -1;
  }

  private subtreeCpuSeconds(rows: readonly ProcessCpuRow[], pgid: number | undefined): number {
    if (pgid === undefined) return 0;
    let total = 0;
    for (const row of rows) if (row.pgid === pgid) total += row.cpuSeconds;
    return total;
  }

  private safeWorkspaceStamp(): string {
    try {
      return this.deps.readWorkspaceStamp();
    } catch {
      return '';
    }
  }

  private writeFact(fact: ToolStallFact): void {
    try {
      this.deps.writeFact(fact);
    } catch {
      // Facts are observation; a write failure must not affect execution.
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
