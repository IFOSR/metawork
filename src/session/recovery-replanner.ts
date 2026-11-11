import type Database from 'better-sqlite3';
import type { ConversationRuntimePort } from '../account/account-runtime-ports.js';
import type { ControlDecision, ControlEvent } from '../control/control-contracts.js';
import { ControlApplicationInterruptedError } from '../control/control-workflow.js';
import type { ConfigurationSnapshot } from '../configuration/types.js';
import { buildControlConfigurationView, buildPlannerConfigurationView, buildRuntimeConfigurationView } from '../configuration/projections.js';
import type { PlanningContext, PlanningAgentPlan } from '../planning/planning-types.js';
import { PlanningContextBuilder } from '../planning/planning-context-builder.js';
import { ConversationSession } from './conversation-session.js';
import { ConversationInputMailbox } from './conversation-input-mailbox.js';

export type RecoveryReplanDecision = ControlDecision & {
  action: Extract<ControlDecision['action'], { type: 'request_replan' | 'request_merge_replan' }>;
};
export type RecoveryReplan = (sessionId: string, decision: RecoveryReplanDecision) => Promise<ControlEvent | null>;

/** The Task's durable Workspace binding, independent of any client selection. */
export interface RecoveryTaskWorkspace {
  workspaceId: string;
  canonicalPath: string;
}

/** Reuses the application-shell proposal path without opening a client session. */
export function createRecoveryReplanner(deps: {
  db: Database.Database;
  getPort: () => ConversationRuntimePort;
  getSnapshot: (revisionId: string) => Promise<ConfigurationSnapshot>;
  plan: (context: PlanningContext) => Promise<PlanningAgentPlan>;
  signal: AbortSignal;
  /**
   * Admission facts for the Task's own Workspace. A client-less replan continues
   * an admitted Task, so its target Workspace is that Task's immutable binding;
   * without it the Kernel rejects the proposal with "no Workspace is bound".
   */
  resolveTaskWorkspace?: (
    task: import('../core/types.js').Task,
  ) => Promise<RecoveryTaskWorkspace | null> | RecoveryTaskWorkspace | null;
  /**
   * The owner applier that admits the prepared replan directly. Resolved lazily
   * because the account runtime builds it after this replanner.
   */
  getSessionControlRuntime?: () => import('./session-control-runtime.js').SessionControlRuntime | null;
}): RecoveryReplan {
  const pending = new Map<string, Promise<ControlEvent | null>>();
  return (sessionId, decision) => {
    const key = JSON.stringify([sessionId, decision.id]);
    const existing = pending.get(key);
    if (existing) return existing;
    const work = (async () => {
      if (deps.signal.aborted) throw new ControlApplicationInterruptedError();
      const port = deps.getPort();
      const task = port.queries.findTask(decision.action.taskId);
      if (!task || !task.conversationId || task.ownerPlannerSessionId !== sessionId) {
        throw new Error('recovery replan owner is unavailable');
      }
      const snapshot = await deps.getSnapshot(decision.configurationRevision);
      const session = new ConversationSession({
        db: deps.db,
        conversationId: task.conversationId,
        plannerSessionId: sessionId,
        runtimePort: { ...port, planning: {
          plan: deps.plan,
          submit: async () => { throw new Error('recovery only permits validated proposals'); },
        } },
        mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
        workspace: deps.resolveTaskWorkspace
          ? {
            getWorkspace: async () => {
              const workspace = await deps.resolveTaskWorkspace!(task);
              if (!workspace) return null;
              const boundAt = task.admittedAt ?? new Date(0).toISOString();
              return {
                workspaceId: workspace.workspaceId,
                path: workspace.canonicalPath,
                boundAt,
                boundByPrincipal: 'system:recovery',
                selectedAt: boundAt,
                selectedByPrincipal: 'system:recovery',
              };
            },
            bindEmptyConversation: async () => ({
              status: 'rejected' as const,
              code: 'workspace_binding_locked' as const,
              message: '没有客户端的恢复重规划可以继续原 Task，但不能改写 Workspace 绑定。',
            }),
          }
          : undefined,
        planningContextBuilder: new PlanningContextBuilder({
          sessionId, conversationId: task.conversationId, requestSource: 'recovery',
          getPlannerConfiguration: () => buildPlannerConfigurationView(snapshot),
          getTimeoutMs: () => 180_000,
        }),
        kernelConfiguration: buildControlConfigurationView(snapshot),
        resolveConfigurationSnapshot: deps.getSnapshot,
        getRuntimeConfiguration: () => buildRuntimeConfigurationView(snapshot),
        lifetimeSignal: deps.signal,
        ...(deps.getSessionControlRuntime?.()
          ? { sessionControlRuntime: deps.getSessionControlRuntime()! }
          : {}),
      });
      try {
        const callbacks = session.getControlExecutionCallbacks().kernelExecutionCallbacks;
        const event = decision.action.type === 'request_replan'
          ? await callbacks.requestReplan(decision as Parameters<typeof callbacks.requestReplan>[0])
          : await callbacks.requestMergeReplan(decision as Parameters<typeof callbacks.requestMergeReplan>[0]);
        if (deps.signal.aborted) throw new ControlApplicationInterruptedError();
        return event;
      } finally {
        await session.dispose();
      }
    })();
    pending.set(key, work);
    void work.finally(() => pending.delete(key)).catch(() => undefined);
    return work;
  };
}
