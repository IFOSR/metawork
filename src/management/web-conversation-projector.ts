import type { ExecutionTimeline } from './execution-projector.js';
import {
  sanitizeInteractionTraceDetails,
  sanitizeInteractionTraceText,
  type InteractionTrace,
  type InteractionTraceEvent,
} from './interaction-trace.js';
import type {
  ConversationTurn,
  ConversationTurnProjection,
} from './web-session-types.js';

export interface WebConversationProjectionStore {
  appendTurn(
    sessionId: string,
    turn: ConversationTurn,
  ): Promise<unknown>;
}

export interface WebConversationProjectorDeps {
  sessionId: string;
  store: WebConversationProjectionStore;
  createTurnId?: () => string;
  now?: () => string;
}

export class WebConversationProjector {
  private readonly listeners = new Set<
    (turn: ConversationTurnProjection | null) => void
  >();
  private readonly createTurnId: () => string;
  private readonly now: () => string;
  private current: ConversationTurnProjection | null = null;
  private outputFrom = 0;
  private readonly outputLines = new Map<number, string>();
  private submissionCompleted = false;
  private provisionalTurn = false;
  private persisted = false;

  constructor(private readonly deps: WebConversationProjectorDeps) {
    this.createTurnId = deps.createTurnId
      ?? (() => `turn_web_${Date.now().toString(36)}`);
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  beginTurn(input: { userInput: string; outputFrom: number }): ConversationTurnProjection {
    const startedAt = this.now();
    this.current = {
      id: this.createTurnId(),
      sessionId: this.deps.sessionId,
      userInput: sanitizeInteractionTraceText(input.userInput, 8_000),
      status: 'running',
      finalAnswer: null,
      taskId: null,
      startedAt,
      completedAt: null,
      traceEvents: [],
      executionTimeline: null,
      artifactRefs: [],
      artifacts: [],
    };
    this.outputFrom = Math.max(0, input.outputFrom);
    this.outputLines.clear();
    this.submissionCompleted = false;
    this.provisionalTurn = true;
    this.persisted = false;
    this.publish();
    return this.getSnapshot()!;
  }

  getSnapshot(): ConversationTurnProjection | null {
    return this.current ? structuredClone(this.current) : null;
  }

  subscribe(
    listener: (turn: ConversationTurnProjection | null) => void,
  ): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  async applyTrace(trace: InteractionTrace): Promise<void> {
    if (trace.sessionId !== this.deps.sessionId) return;
    if (!this.current || (!this.provisionalTurn && this.current.id !== trace.turnId)) {
      const query = trace.events.find(event => event.kind === 'query_received');
      this.beginTurn({
        userInput: query?.summary ?? '',
        outputFrom: 0,
      });
    }
    if (!this.current) return;

    if (this.provisionalTurn) {
      this.current.id = trace.turnId;
      this.current.startedAt = trace.startedAt;
      this.provisionalTurn = false;
    }
    const events = new Map(this.current.traceEvents.map(event => [event.id, event]));
    for (const event of trace.events) {
      events.set(event.id, structuredClone(event));
    }
    this.current.traceEvents = [...events.values()].sort(
      (left, right) => left.sequence - right.sequence
        || left.occurredAt.localeCompare(right.occurredAt)
        || left.id.localeCompare(right.id),
    );
    this.current.taskId = trace.taskId ?? this.current.taskId;
    this.current.status = trace.status;
    this.current.completedAt = trace.completedAt;
    this.publish();
    await this.persistIfReady();
  }

  async applyTimeline(timeline: ExecutionTimeline): Promise<void> {
    if (!this.current) return;
    if (this.current.taskId && this.current.taskId !== timeline.taskId) return;
    this.current.taskId = timeline.taskId;
    this.current.executionTimeline = structuredClone(timeline);

    const terminalStatus = terminalStatusFromTimeline(timeline);
    if (terminalStatus) {
      this.current.status = terminalStatus;
      this.current.completedAt ??= this.now();
    }
    this.publish();
    await this.persistIfReady();
  }

  applyOutput(lines: string[], from: number): void {
    if (!this.current) return;
    lines.forEach((line, index) => {
      const absoluteIndex = from + index;
      if (absoluteIndex >= this.outputFrom) {
        this.outputLines.set(absoluteIndex, line);
      }
    });
    const orderedLines = [...this.outputLines.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, line]) => line);
    const executorResults = orderedLines
      .map(extractExecutorFinalResult)
      .filter((value): value is string => Boolean(value));
    const answer = (executorResults.length > 0
      ? executorResults
      : orderedLines
      .filter(line => isAnswerLine(line, this.current!.userInput))
    )
      .join('\n\n')
      .trim();
    this.current.finalAnswer = answer
      ? sanitizeInteractionTraceText(answer, 40_000)
      : null;
    this.publish();
  }

  async finishSubmission(): Promise<void> {
    this.submissionCompleted = true;
    await this.persistIfReady();
  }

  async failSubmission(error: unknown): Promise<void> {
    if (!this.current) return;
    const summary = sanitizeInteractionTraceText(
      error instanceof Error ? error.message : String(error),
      1_000,
    );
    const sequence = (this.current.traceEvents.at(-1)?.sequence ?? 0) + 1;
    const failureEvent: InteractionTraceEvent = {
      id: `web:${this.current.id}:submission_failed`,
      sequence,
      occurredAt: this.now(),
      phase: 'delivery',
      actor: 'runtime',
      kind: 'submission_failed',
      status: 'failed',
      title: 'Submission failed',
      summary,
      details: sanitizeInteractionTraceDetails({}),
    };
    this.current.traceEvents = mergeTraceEvents(
      this.current.traceEvents,
      [failureEvent],
    );
    this.current.status = 'failed';
    this.current.completedAt = failureEvent.occurredAt;
    this.current.finalAnswer ??= summary;
    this.submissionCompleted = true;
    this.publish();
    await this.persistIfReady();
  }

  private async persistIfReady(): Promise<void> {
    if (!this.current
      || this.current.status === 'running'
      || !this.submissionCompleted
      || this.persisted) {
      return;
    }
    const turn: ConversationTurn = {
      ...structuredClone(this.current),
      status: this.current.status,
    };
    await this.deps.store.appendTurn(this.deps.sessionId, turn);
    this.persisted = true;
  }

  private publish(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function mergeTraceEvents(
  current: InteractionTraceEvent[],
  incoming: InteractionTraceEvent[],
): InteractionTraceEvent[] {
  const events = new Map(current.map(event => [event.id, event]));
  for (const event of incoming) events.set(event.id, event);
  return [...events.values()].sort(
    (left, right) => left.sequence - right.sequence
      || left.occurredAt.localeCompare(right.occurredAt)
      || left.id.localeCompare(right.id),
  );
}

function isAnswerLine(line: string, userInput: string): boolean {
  const normalized = line.trim();
  if (!normalized) return false;
  if (normalized === `> ${userInput}`) return false;
  if (normalized.startsWith('【MetaClaw｜')) return false;
  if (normalized.startsWith('【MetaWork｜')) return false;
  if (normalized.startsWith('MetaClaw:')) return false;
  if (normalized.startsWith('MetaWork:')) return false;
  if (/^【Executor: .+｜派发准备】$/u.test(normalized)) return false;
  if (/^→ Executor: .+ 将处理该任务$/u.test(normalized)) return false;
  if (/^【Executor: .+｜最终结果｜#[^】]+】/u.test(normalized)) return false;
  return true;
}

function extractExecutorFinalResult(line: string): string | null {
  const match = /^【Executor: .+｜最终结果｜#[^】]+】\r?\n([\s\S]+)$/u.exec(line.trim());
  return match?.[1]?.trim() || null;
}

function terminalStatusFromTimeline(
  timeline: ExecutionTimeline,
): ConversationTurn['status'] | null {
  if (['done', 'archived'].includes(timeline.status)) return 'completed';
  if (['blocked', 'parked'].includes(timeline.status)) return 'blocked';
  if (['cancelled', 'failed'].includes(timeline.status)) return 'failed';

  const delivery = timeline.stages.find(stage => stage.phase === 'delivery');
  if (delivery?.status === 'done') return 'completed';
  if (delivery?.status === 'blocked') return 'blocked';
  if (delivery?.status === 'failed') return 'failed';
  return null;
}
