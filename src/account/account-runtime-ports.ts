/**
 * AccountRuntime 端口契约（ADR-0031 第 2 节）。
 *
 * Conversation 通过窄端口访问账户运行时服务，绝不能构造或恢复 Kernel /
 * Execution 服务。
 */

import type { AccountPermissionService } from './account-permission-service.js';
import type { AccountKernelCoordinator } from './account-kernel-coordinator.js';
import type { Task, Subtask } from '../core/types.js';
import type { PlanningAgent } from '../planning/planning-agent.js';
import type { KernelDecision, KernelEvent } from '../kernel/control-kernel.js';
import type { RevisionedKernelDecisionLedgerRecord } from '../storage/kernel-decision-repo.js';
import type { RevisionedKernelExecutorStatusProjection } from '../storage/kernel-executor-status-repo.js';
import type { PermissionRequestRecord } from '../resource/index.js';
import type { KernelDecisionApplicationRecord } from '../kernel/kernel-workflow.js';
import type { KernelEffectRecord } from '../storage/kernel-effect-outbox-repo.js';
import type { WorkspacePublicationRecord } from '../storage/workspace-publication-repo.js';
import type { TaskEvidenceRecord } from '../execution/execution-evidence-port.js';
import type { ExecutorAttemptReceipt } from '../storage/executor-attempt-receipt-repo.js';
import type { WorkGraphRevisionRecord } from '../storage/work-graph-revision-repo.js';
import type { ActiveExecutionControl } from '../execution/active-execution-control.js';
import type {
  ExecutorRecoveryRefreshReport,
} from '../execution/executor-recovery-refresh-service.js';
import type { ExecutorRecoveryRefreshTrigger } from '../kernel/executor-status-projection.js';
import type {
  ConfigurationActivationStatusSnapshot,
} from '../configuration/configuration-activation-gate.js';

/** AccountRuntime 暴露给 Application Shell 的窄句柄。 */
export interface AccountRuntimeHandle {
  readonly accountId: string;
  getConversationPort(): ConversationRuntimePort;
  initialize(): Promise<void>;
  attachClient(): void;
  detachClient(): void;
  beginWork(): void;
  endWork(): void;
  getConfigurationActivationStatus?(): ConfigurationActivationStatusSnapshot;
  closeWhenIdle(): Promise<'closed' | 'busy'>;
}

/** Conversation 通过该端口访问账户 runtime-wide 服务。 */
export interface ConversationRuntimePort {
  readonly accountId: string;
  readonly planning: Pick<PlanningAgent, 'plan' | 'submit'> | null;
  readonly permissions: AccountPermissionService | null;
  readonly queries: {
    findTask(taskId: string): Task | null;
    listTasks(): Task[];
    listTasksByStatus(status: Task['status']): Task[];
    listSubtasks(taskId: string): Subtask[];
    findSubtask(subtaskId: string): Subtask | null;
    findKernelEvent(eventId: string): KernelEvent | null;
    findKernelApplicationByDecisionId(
      decisionId: string,
    ): KernelDecisionApplicationRecord | null;
    listKernelDecisionsBySession(sessionId: string): RevisionedKernelDecisionLedgerRecord[];
    listKernelDecisionsByTask(taskId: string): RevisionedKernelDecisionLedgerRecord[];
    listCurrentKernelDecisions(action: KernelDecision['action']['type']): RevisionedKernelDecisionLedgerRecord[];
    listExecutorStatuses(configurationRevision: string): RevisionedKernelExecutorStatusProjection[];
    listWorkGraphTaskIds(): string[];
    findOldestPendingPermission(): PermissionRequestRecord | null;
    listIntegratedPublications(taskIds: string[]): WorkspacePublicationRecord[];
    listRecoveryApplications(taskId: string): KernelDecisionApplicationRecord[];
    findRecoveryApplication(recoveryItemId: string): KernelDecisionApplicationRecord | null;
    listRecoveryEffects(taskId: string): KernelEffectRecord[];
    findRecoveryEffect(recoveryItemId: string): KernelEffectRecord | null;
    findActiveWorkGraphRevision(taskId: string): WorkGraphRevisionRecord | null;
    listTaskEvidence(taskId: string, generationId: string): TaskEvidenceRecord[];
    listAttemptReceipts(taskId: string): ExecutorAttemptReceipt[];
  };
  readonly commands: {
    submitKernel: AccountKernelCoordinator['submit'];
    materializeCompletedEvidence(taskId: string, revision: number): void;
    resolveRecoveryApplication(
      recoveryItemId: string,
      resolution: 'assume_applied' | 'retry',
      now: string,
    ): void;
    resolveRecoveryEffect(
      recoveryItemId: string,
      resolution: 'assume_applied' | 'retry',
      now: string,
    ): void;
    refreshExecutors(input: {
      trigger: ExecutorRecoveryRefreshTrigger;
      agentClassNames?: string[];
    }): Promise<ExecutorRecoveryRefreshReport>;
  };
  readonly execution: {
    readonly activeExecutions: ActiveExecutionControl;
    listExecutorAgentClassNames(): string[];
  } | null;
}
