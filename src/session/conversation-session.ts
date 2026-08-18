/**
 * ConversationSession（ADR-0031 第 2、7 节）。
 *
 * 一个 Conversation 的实时应用外壳对象。它拥有稳定的 Planner 会话身份、
 * 串行输入邮箱、输出/轨迹投影、聚焦状态与客户端附着；通过
 * ConversationRuntimePort 访问账户事实，不拥有 Kernel、调度、恢复或
 * Executor 服务。
 *
 * 本文件逐步接管 MetaclawSession 的 conversation-facing 行为。当前实现
 * 基础状态（output/currentTaskId/runtimeState/focus/listeners）与基础
 * callbacks（appendOutput/setCurrentTaskId/getCurrentTaskId/refreshRuntimeState）。
 */

import type { GuidanceProposal, RuntimeState } from '../core/types.js';
import type { SessionPresentationService, GuidanceState } from './session-presentation-service.js';
import type { SessionStateRepo } from '../storage/session-state-repo.js';
import {
  ConversationInputMailbox,
  type MailboxCommand,
  type MailboxReceipt,
} from './conversation-input-mailbox.js';
import type { ConversationRuntimePort } from './conversation-runtime-port.js';

export interface ConversationSessionSnapshot {
  readonly output: string[];
  readonly currentTaskId: string | null;
  readonly runtimeState: RuntimeState;
  readonly plannerState: { readonly status: 'idle' | 'running' };
}

export interface ConversationSessionDeps {
  readonly conversationId: string;
  readonly plannerSessionId: string;
  readonly runtimePort: ConversationRuntimePort;
  readonly mailbox: ConversationInputMailbox;
  readonly presentation?: SessionPresentationService;
  readonly sessionStateRepo?: SessionStateRepo;
  readonly dispose?: () => Promise<void>;
}

export class ConversationSession {
  private output: string[] = [];
  private currentTaskId: string | null = null;
  private runtimeState: RuntimeState = {
    runningTaskId: null,
    runningExecutorName: null,
    readyTaskIds: [],
    blockedTaskIds: [],
    parkedTaskIds: [],
    lastEvent: null,
  };
  private focusContext: { kind: 'conversation' | 'task'; taskId: string | null } | null = null;
  private activePlannerRuns = 0;
  private latestGuidance: GuidanceState | null = null;
  private listeners = new Set<(snapshot: ConversationSessionSnapshot) => void>();
  private attachedClients = 0;

  constructor(private readonly deps: ConversationSessionDeps) {}

  get conversationId(): string {
    return this.deps.conversationId;
  }

  get plannerSessionId(): string {
    return this.deps.plannerSessionId;
  }

  get accountId(): string {
    return this.deps.runtimePort.accountId;
  }

  attachClient(): void {
    this.attachedClients += 1;
  }

  detachClient(): void {
    this.attachedClients = Math.max(0, this.attachedClients - 1);
  }

  get attachedClientCount(): number {
    return this.attachedClients;
  }

  appendOutput(...lines: string[]): void {
    if (lines.length === 0) return;
    this.output.push(...lines);
    this.notify();
  }

  getOutput(): readonly string[] {
    return [...this.output];
  }

  setCurrentTaskId(taskId: string | null): void {
    this.currentTaskId = taskId;
    this.notify();
  }

  getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }

  setFocusContext(focus: { kind: 'conversation' | 'task'; taskId: string | null } | null): void {
    this.focusContext = focus;
    if (focus?.kind === 'task' && focus.taskId) {
      this.persistSessionState({ lastFocusedTaskId: focus.taskId });
    }
  }

  getFocusContext(): { kind: 'conversation' | 'task'; taskId: string | null } | null {
    return this.focusContext;
  }

  setLatestGuidance(
    scene: string,
    suggestion: { taskId: string; recommendedAction: string; reasons: string[] },
  ): GuidanceState | null {
    if (!this.deps.presentation) return null;
    this.latestGuidance = this.deps.presentation.buildGuidanceState(
      scene,
      suggestion,
      this.deps.runtimePort.taskServices?.taskRuntimeService.findTask(suggestion.taskId)?.title ?? '',
    );
    return this.latestGuidance;
  }

  appendGuidance(
    scene: string,
    suggestion: { taskId: string; recommendedAction: string; reasons: string[] },
  ): void {
    this.setLatestGuidance(scene, suggestion);
    if (!this.deps.presentation) return;
    this.appendOutput(
      ...this.deps.presentation.formatGuidanceBlock(scene, suggestion, this.latestGuidance?.taskTitle ?? ''),
    );
  }

  queueProposal(scene: string, proposal: GuidanceProposal): void {
    if (!this.deps.presentation) return;
    this.appendOutput(...this.deps.presentation.formatProposalBlock(
      scene,
      proposal,
      proposal.taskId
        ? this.deps.runtimePort.taskServices?.taskRuntimeService.findTask(proposal.taskId)?.title ?? ''
        : '',
    ));
    this.appendOutput('→ 操作提案已记录，不等待用户确认；满足执行条件的任务由调度器自动处理');
  }

  persistSessionState(changes: {
    lastFocusedTaskId?: string | null;
    lastCompletedTaskId?: string | null;
    lastSessionId?: string | null;
  }): void {
    this.deps.sessionStateRepo?.upsert(changes);
  }

  refreshRuntimeState(): void {
    const taskRuntimeService = this.deps.runtimePort.taskServices?.taskRuntimeService;
    if (!taskRuntimeService) return;
    const tasks = taskRuntimeService.listTasks();
    const runningTask = tasks.find(task => task.status === 'running') ?? null;
    this.runtimeState = {
      runningTaskId: runningTask?.id ?? null,
      runningExecutorName: null,
      readyTaskIds: tasks.filter(task => task.status === 'ready').map(task => task.id),
      blockedTaskIds: tasks.filter(task => task.status === 'blocked').map(task => task.id),
      parkedTaskIds: tasks.filter(task => task.status === 'parked').map(task => task.id),
      lastEvent: this.runtimeState.lastEvent,
    };
    this.notify();
  }

  subscribe(listener: (snapshot: ConversationSessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): ConversationSessionSnapshot {
    return {
      output: [...this.output],
      currentTaskId: this.currentTaskId,
      runtimeState: {
        ...this.runtimeState,
        readyTaskIds: [...this.runtimeState.readyTaskIds],
        blockedTaskIds: [...this.runtimeState.blockedTaskIds],
        parkedTaskIds: [...this.runtimeState.parkedTaskIds],
      },
      plannerState: {
        status: this.activePlannerRuns > 0 ? 'running' : 'idle',
      },
    };
  }

  submit(command: MailboxCommand): MailboxReceipt {
    return this.deps.mailbox.submit(command);
  }

  cancelTurn(requestId: string): boolean {
    return this.deps.mailbox.cancel(requestId);
  }

  isIdle(): boolean {
    return !this.deps.mailbox.isActive;
  }

  async dispose(): Promise<void> {
    await (this.deps.dispose ?? (async () => undefined))();
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
