/**
 * Run Contract: the one authorized input projection a Harness receives.
 *
 * Architecture (2026-10-27 Agent execution architecture realignment §4.1):
 * Planner produces the Work Graph, Kernel authorizes it, and the Runtime hands
 * each authorized Subtask exactly one Run Contract. The contract is an input
 * boundary, not a state machine: it never carries a turn loop, a retry loop, a
 * repair budget or a delivery decision. Those belong to the Harness (its own
 * agent loop) and to the Kernel (authorization), respectively.
 *
 * This module is a pure projection over already-authorized facts
 * (`SubtaskExecutionContext` + the dispatch execution binding). It does not
 * read storage, the clock or the filesystem, and it never mutates scheduling
 * state: it exists so Planner, Runtime, Executor diagnostics and tests can all
 * describe "what this Attempt was authorized to do" the same way.
 */
import type { WorkspaceContext } from '../core/types.js';
import type { WorkGraphAcceptanceCriterion } from '../work-graph/index.js';
import type { SubtaskExecutionContext } from './subtask-execution-context.js';

/** Intent the Graph/Kernel authorized for the Task's local service, if any. */
export interface RunContractServiceIntent {
  readonly requested: boolean;
  readonly serviceId?: string;
  readonly specificationRevision?: string | null;
  readonly sourceTaskId?: string | null;
  readonly operationTaskId?: string | null;
  readonly sourceCommit?: string;
  readonly serviceWorktreeId?: string;
  readonly projectPath?: string;
}

export interface RunContractProjection {
  readonly taskId: string;
  readonly generationId: string | null;
  readonly subtaskId: string;
  readonly attemptId: string;
  readonly workUnitId: string | null;
  readonly workspaceId: string | null;
  readonly workingDirectory: string;
  readonly targetPaths: readonly string[];
  readonly accessMode: 'read' | 'execute' | 'write';
  readonly objective: string;
  readonly acceptance: readonly WorkGraphAcceptanceCriterion[];
  readonly fileOutputs: readonly string[];
  readonly serviceIntent?: RunContractServiceIntent;
  readonly configurationRevision: string | null;
  readonly bindingFingerprint: string | null;
}

export interface RunContractSources {
  context: Pick<SubtaskExecutionContext,
    'currentSubtask' | 'identity' | 'workspaceContext'>;
  executionBinding?: {
    taskId: string;
    generationId: string;
    subtaskId: string;
    workUnitId: string;
    configurationRevision: string;
    bindingFingerprint: string;
  } | null;
  /** Authorized service intent, when the Runtime resolved one for this Attempt. */
  serviceIntent?: RunContractServiceIntent;
}

/**
 * Derive the Run Contract for one authorized Attempt.
 *
 * Every field is copied from an authorized fact; nothing is inferred from the
 * ambient environment. `generationId`, `workUnitId`, `configurationRevision`
 * and `bindingFingerprint` stay `null` when the caller has no execution binding
 * (for example a focused projection used by tests or diagnostics).
 */
export function projectRunContract(sources: RunContractSources): RunContractProjection {
  const { context, executionBinding } = sources;
  const workspace: WorkspaceContext = context.workspaceContext;
  return {
    taskId: context.identity.taskId,
    generationId: executionBinding?.generationId ?? null,
    subtaskId: context.identity.subtaskId,
    attemptId: context.identity.attemptId,
    workUnitId: executionBinding?.workUnitId ?? context.identity.workUnitId ?? null,
    workspaceId: workspace.workspaceId ?? null,
    workingDirectory: workspace.workingDirectory,
    targetPaths: [...workspace.targetPaths],
    accessMode: workspace.accessMode ?? 'write',
    objective: context.currentSubtask.goal,
    acceptance: [...(context.currentSubtask.acceptance ?? [])],
    fileOutputs: [...(context.currentSubtask.fileOutputs ?? [])],
    ...(sources.serviceIntent ? { serviceIntent: sources.serviceIntent } : workspace.service ? {
      serviceIntent: { requested: true, ...workspace.service },
    } : {}),
    configurationRevision: executionBinding?.configurationRevision ?? null,
    bindingFingerprint: executionBinding?.bindingFingerprint ?? null,
  };
}

/**
 * Bounded, secret-free summary of the contract for execution traces and
 * attempt receipts. Objective/acceptance text is intentionally omitted: the
 * trace records the authorization identity and boundaries, not the prompt.
 */
export function runContractDiagnostics(
  contract: RunContractProjection,
): Record<string, unknown> {
  return {
    taskId: contract.taskId,
    generationId: contract.generationId,
    subtaskId: contract.subtaskId,
    attemptId: contract.attemptId,
    workUnitId: contract.workUnitId,
    workspaceId: contract.workspaceId,
    accessMode: contract.accessMode,
    targetPathCount: contract.targetPaths.length,
    acceptanceCount: contract.acceptance.length,
    fileOutputs: [...contract.fileOutputs],
    ...(contract.serviceIntent ? { serviceIntent: { ...contract.serviceIntent } } : {}),
    configurationRevision: contract.configurationRevision,
    bindingFingerprint: contract.bindingFingerprint,
  };
}
