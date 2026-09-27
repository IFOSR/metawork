import type Database from 'better-sqlite3';
import type { ConversationRuntimePort } from '../account/account-runtime-ports.js';
import type { KernelDecision, KernelEvent } from '../kernel/control-kernel.js';
import { KernelApplicationInterruptedError } from '../kernel/kernel-workflow.js';
import type { ConfigurationSnapshot } from '../configuration/types.js';
import { buildKernelConfigurationView, buildPlannerConfigurationView, buildRuntimeConfigurationView } from '../configuration/projections.js';
import type { PlanningContext, PlanningAgentPlan } from '../planning/planning-types.js';
import { PlanningContextBuilder } from '../planning/planning-context-builder.js';
import type { SpanRoutingEvaluator } from '../routing/span-routing-types.js';
import { ConversationSession } from './conversation-session.js';
import { ConversationInputMailbox } from './conversation-input-mailbox.js';

export type RecoveryReplanDecision = KernelDecision & {
  action: Extract<KernelDecision['action'], { type: 'request_replan' | 'request_merge_replan' }>;
};
export type RecoveryReplan = (sessionId: string, decision: RecoveryReplanDecision) => Promise<KernelEvent | null>;

/** Reuses the application-shell proposal path without opening a client session. */
export function createRecoveryReplanner(deps: {
  db: Database.Database;
  getPort: () => ConversationRuntimePort;
  getSnapshot: (revisionId: string) => Promise<ConfigurationSnapshot>;
  plan: (context: PlanningContext) => Promise<PlanningAgentPlan>;
  evaluator: SpanRoutingEvaluator;
  signal: AbortSignal;
}): RecoveryReplan {
  const pending = new Map<string, Promise<KernelEvent | null>>();
  return (sessionId, decision) => {
    const key = JSON.stringify([sessionId, decision.id]);
    const existing = pending.get(key);
    if (existing) return existing;
    const work = (async () => {
      if (deps.signal.aborted) throw new KernelApplicationInterruptedError();
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
        planningContextBuilder: new PlanningContextBuilder({
          sessionId, conversationId: task.conversationId, requestSource: 'recovery',
          getPlannerConfiguration: () => buildPlannerConfigurationView(snapshot),
          getTimeoutMs: () => 180_000,
        }),
        kernelConfiguration: buildKernelConfigurationView(snapshot),
        resolveConfigurationSnapshot: deps.getSnapshot,
        getRuntimeConfiguration: () => buildRuntimeConfigurationView(snapshot),
        spanRoutingEvaluator: deps.evaluator,
        lifetimeSignal: deps.signal,
      });
      try {
        const callbacks = session.getKernelExecutionCallbacks().kernelExecutionCallbacks;
        const event = decision.action.type === 'request_replan'
          ? await callbacks.requestReplan(decision as Parameters<typeof callbacks.requestReplan>[0])
          : await callbacks.requestMergeReplan(decision as Parameters<typeof callbacks.requestMergeReplan>[0]);
        if (deps.signal.aborted) throw new KernelApplicationInterruptedError();
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
