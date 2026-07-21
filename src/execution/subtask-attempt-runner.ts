import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { ExecutorProgressEvent } from '../executor/adapter.js';
import type { ExecutorAdapter } from '../executor/adapter.js';
import type { AgentClassService } from '../executor/agent-class-service.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import { ExecutorAttemptReceiptRepo, type ExecutorAttemptReceipt } from '../storage/executor-attempt-receipt-repo.js';
import { SubtaskHandoffRepo } from '../storage/subtask-handoff-repo.js';
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import type { ExecutionMode } from './types.js';
import type { ExecutionRuntime } from './execution-runtime.js';
import {
  COMPLETION_MARKER_V1,
  validateCompletionProtocol,
  type CompletionContractViolation,
  type CompletionHandoffV1,
} from './completion-protocol.js';
import { SubtaskExecutionContextBuilder } from './subtask-execution-context.js';
import type { WorkUnitClaimService } from './work-unit-claim-service.js';
import { generateInteractionId } from '../utils/id.js';
import { ExecutionEvidenceToolServer } from './execution-evidence-tool-server.js';
import type { KernelFailure } from '../core/kernel-failure.js';

export type ProgressCallback = (event: ExecutorProgressEvent, executor: ExecutorAdapter) => void;

export type SubtaskAttemptOutcome =
  | { outcome: 'completed'; attemptId: string; output: string; artifacts: string[]; warnings: string[]; executorName: string; durationMs: number }
  | { outcome: 'capacity_unavailable'; attemptId: string; agentClassName: string }
  | { outcome: 'contract_failed'; attemptId: string; workUnitId: string; agentClassName: string; responseBytes: number; receiptCount: number; completionContract: unknown; violations: CompletionContractViolation[] }
  | { outcome: 'executor_failed'; attemptId: string; error: string; failure: KernelFailure }
  | { outcome: 'cancelled_or_stale'; attemptId: string; reason: string };

export interface SubtaskAttemptRunnerDeps {
  db: Database.Database;
  sessionId: string;
  taskRuntimeService: TaskRuntimeService;
  subtaskRepo: SubtaskRepo;
  workUnitClaimService: WorkUnitClaimService;
  executionRuntime: ExecutionRuntime;
  agentClassService: AgentClassService;
}

/** Owns one Subtask attempt from claim through immutable terminal persistence. */
export class SubtaskAttemptRunner {
  private readonly contextBuilder: SubtaskExecutionContextBuilder;
  private readonly receiptRepo: ExecutorAttemptReceiptRepo;
  private readonly handoffRepo: SubtaskHandoffRepo;

  constructor(private readonly deps: SubtaskAttemptRunnerDeps) {
    this.contextBuilder = new SubtaskExecutionContextBuilder(deps.db);
    this.receiptRepo = new ExecutorAttemptReceiptRepo(deps.db);
    this.handoffRepo = new SubtaskHandoffRepo(deps.db);
  }

  supportsResponseOnly(agentClassName: string): boolean {
    return this.deps.executionRuntime.supportsResponseOnly(agentClassName);
  }

  landHeartbeatLost(input: {
    attemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    workUnitId: string;
    agentClassName: string;
  }): void {
    const subtask = this.deps.subtaskRepo.findById(input.subtaskId);
    if (!subtask || subtask.status === 'done' || this.receiptRepo.findByAttemptId(input.attemptId)) return;
    const now = new Date().toISOString();
    this.deps.db.transaction(() => {
      this.receiptRepo.insert(buildReceipt({
        ...input,
        startedAt: now,
        terminalState: 'heartbeat_lost',
        rawResponse: '',
        errorCode: 'heartbeat_lost',
        errorDetail: 'WorkUnit lease expired before a terminal observation',
      }, now));
      this.deps.subtaskRepo.updateStatus(input.subtaskId, 'awaiting_decision', {
        error: 'WorkUnit heartbeat lost',
      });
    })();
  }

  async run(input: {
    attemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    agentClassName: string;
    executionMode: ExecutionMode;
    onProgress?: ProgressCallback;
  }): Promise<SubtaskAttemptOutcome> {
    const attemptId = input.attemptId;
    const task = this.deps.taskRuntimeService.findTask(input.taskId);
    const subtask = this.deps.subtaskRepo.findById(input.subtaskId);
    if (!task || !subtask || subtask.taskId !== input.taskId || subtask.status !== 'ready') {
      return { outcome: 'cancelled_or_stale', attemptId, reason: 'Task or ready Subtask no longer matches the authorized attempt' };
    }
    const claim = await this.deps.workUnitClaimService.claim({
      taskId: input.taskId,
      subtask: { id: subtask.id, preferredAgentClassList: [input.agentClassName] },
      attemptId,
    });
    if (!claim) return { outcome: 'capacity_unavailable', attemptId, agentClassName: input.agentClassName };

    const startedAt = new Date().toISOString();
    let rawResponse = '';
    let evidenceCapability: { revoke(): void } | null = null;
    let evidenceToolServer: ExecutionEvidenceToolServer | null = null;
    try {
      claim.startAttempt();
      this.deps.subtaskRepo.updateStatus(subtask.id, 'running');
      claim.markRunning();
      const agentClass = this.deps.agentClassService.listAgentClasses().find(item => item.name === input.agentClassName);
      if (!agentClass || claim.workUnit.agentClassName !== input.agentClassName) {
        throw new Error(`attempt AgentClass mismatch: ${input.agentClassName}`);
      }
      const allSubtasks = this.deps.subtaskRepo.listByTask(input.taskId);
      const targetPath = resolve(process.cwd(), 'metaclaw-tasks', task.id);
      mkdirSync(targetPath, { recursive: true });
      const evidenceToolsAvailable = input.agentClassName === 'codex-cli' || input.agentClassName === 'pi-agent';
      const built = this.contextBuilder.build({
        executionId: input.executionId,
        task,
        subtask,
        allSubtasks,
        attemptId,
        workUnitId: claim.workUnit.id,
        sessionId: this.deps.sessionId,
        workspaceContext: {
          allowFilesystem: true,
          workingDirectory: process.cwd(),
          targetPaths: [targetPath],
        },
        evidenceToolsAvailable,
      });
      evidenceCapability = built.evidenceCapability;
      if (evidenceToolsAvailable) {
        evidenceToolServer = new ExecutionEvidenceToolServer(built.evidenceCapability);
        built.context.evidenceTools.binding = await evidenceToolServer.start();
      }
      const execution = await this.deps.executionRuntime.run({
        taskId: input.taskId,
        executionId: input.executionId,
        spec: { subtask, workUnit: claim.workUnit, agentClass, acceptance: subtask.acceptance, expectedOutput: subtask.expectedOutput },
        executorInput: { context: built.context },
        onProgress: input.onProgress ?? (() => undefined),
      });
      rawResponse = execution.output;
      if (execution.status !== 'success') {
        const error = execution.error ?? 'Executor failed without an error message';
        this.persistNonSuccess({
          attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName: agentClass.name, startedAt,
          terminalState: execution.status === 'cancelled' ? 'cancelled_or_stale' : 'executor_failed', rawResponse,
          errorCode: execution.status === 'cancelled' ? 'attempt_cancelled' : 'executor_failed', errorDetail: error,
        });
        claim.markFailed(error);
        return execution.status === 'cancelled'
          ? { outcome: 'cancelled_or_stale', attemptId, reason: error }
          : {
              outcome: 'executor_failed', attemptId, error,
              failure: execution.failure ?? { kind: 'unknown', scope: 'attempt', code: 'executor_failed', summary: error },
            };
      }

      const outgoingHandoffs = allSubtasks.flatMap(candidate => {
        const dependency = candidate.dependencies.find(item => item.fromSubtaskId === subtask.id);
        return dependency ? [{ toSubtaskId: candidate.id, requiredItems: dependency.requiredItems }] : [];
      });
      const completion = validateCompletionProtocol({
        rawResponse,
        subtask,
        outgoingHandoffs,
        targetPaths: built.context.workspaceContext.targetPaths,
        cwd: built.context.workspaceContext.workingDirectory,
        incomingUsageByTarget: new Map(outgoingHandoffs.map(contract => [
          contract.toSubtaskId,
          summarizeHandoffUsage(this.handoffRepo.listIncoming(task.id, contract.toSubtaskId)),
        ])),
      });
      if (!completion.ok) {
        const detail = completion.violations.map(item => `${item.code}:${item.path}:${item.message}`).join('; ');
        const transaction = this.deps.db.transaction(() => {
          this.receiptRepo.insert(buildReceipt({
            attemptId,
            executionId: input.executionId,
            taskId: task.id,
            subtaskId: subtask.id,
            workUnitId: claim.workUnit.id,
            agentClassName: agentClass.name,
            startedAt,
            terminalState: 'contract_blocked',
            rawResponse,
            completionSchemaVersion: completion.envelope?.schemaVersion ?? null,
            violations: completion.violations,
            errorCode: completion.violations[0]?.code ?? 'completion_malformed',
            errorDetail: detail,
          }));
          this.deps.subtaskRepo.updateStatus(subtask.id, 'awaiting_decision', { error: detail });
        });
        transaction();
        claim.markFailed(detail);
        return {
          outcome: 'contract_failed', attemptId, workUnitId: claim.workUnit.id, agentClassName: agentClass.name,
          responseBytes: Buffer.byteLength(rawResponse, 'utf8'),
          receiptCount: this.receiptRepo.countByTerminal(task.id, subtask.id, 'contract_blocked'),
          completionContract: built.context.completionContract,
          violations: completion.violations,
        };
      }

      if (!this.isStillCurrent(task.id, subtask.id, attemptId, claim.workUnit.id)) {
        const detail = 'Task, Subtask, or WorkUnit claim changed before commit';
        this.deps.db.transaction(() => {
          this.receiptRepo.insert(buildReceipt({
            attemptId,
            executionId: input.executionId,
            taskId: task.id,
            subtaskId: subtask.id,
            workUnitId: claim.workUnit.id,
            agentClassName: agentClass.name,
            startedAt,
            terminalState: 'cancelled_or_stale',
            rawResponse,
            errorCode: 'attempt_stale',
            errorDetail: detail,
          }));
          if (this.deps.subtaskRepo.findById(subtask.id)?.status === 'running') {
            this.deps.subtaskRepo.updateStatus(subtask.id, 'awaiting_decision', { error: detail });
          }
        })();
        if (this.isAttemptClaimCurrent(attemptId, claim.workUnit.id)) {
          claim.markFailed(detail);
        }
        return { outcome: 'cancelled_or_stale', attemptId, reason: 'attempt became stale before commit' };
      }

      const completedAt = new Date().toISOString();
      this.deps.db.transaction(() => {
        this.receiptRepo.insert(buildReceipt({
          attemptId,
          executionId: input.executionId,
          taskId: task.id,
          subtaskId: subtask.id,
          workUnitId: claim.workUnit.id,
          agentClassName: agentClass.name,
          startedAt,
          terminalState: 'completed',
          rawResponse,
          completionSchemaVersion: 1,
          warnings: completion.warnings,
        }, completedAt));
        for (const handoff of completion.envelope.handoffs) {
          this.handoffRepo.insert({
            taskId: task.id,
            fromSubtaskId: subtask.id,
            toSubtaskId: handoff.toSubtaskId,
            attemptId,
            items: handoff.items,
            completionSchemaVersion: 1,
            createdAt: completedAt,
          });
        }
        this.deps.subtaskRepo.updateStatus(subtask.id, 'done', {
          result: completion.body,
          artifacts: completion.normalizedArtifacts,
          verification: { warnings: completion.warnings, completionSchemaVersion: 1 },
          error: null,
        });
      })();
      return {
        outcome: 'completed',
        attemptId,
        output: completion.body,
        artifacts: completion.normalizedArtifacts,
        warnings: completion.warnings,
        executorName: execution.executorName,
        durationMs: execution.durationMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.persistNonSuccess({
          attemptId, executionId: input.executionId, taskId: input.taskId, subtaskId: input.subtaskId,
          workUnitId: claim.workUnit.id, agentClassName: input.agentClassName, startedAt,
          terminalState: 'executor_failed', rawResponse, errorCode: 'attempt_exception', errorDetail: message,
        });
      } catch {
        // Preserve the original attempt exception; the finally block still clears the claim.
      }
      claim.markFailed(message);
      return {
        outcome: 'executor_failed', attemptId, error: message,
        failure: { kind: 'unknown', scope: 'attempt', code: 'attempt_exception', summary: message },
      };
    } finally {
      evidenceCapability?.revoke();
      await evidenceToolServer?.close();
      claim.release();
    }
  }

  async runCorrection(input: {
    attemptId: string;
    sourceAttemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    agentClassName: string;
    completionContract: unknown;
    violations: CompletionContractViolation[];
  }): Promise<SubtaskAttemptOutcome> {
    const task = this.deps.taskRuntimeService.findTask(input.taskId);
    const subtask = this.deps.subtaskRepo.findById(input.subtaskId);
    const source = this.receiptRepo.findByAttemptId(input.sourceAttemptId);
    if (!task || !subtask || subtask.status !== 'awaiting_decision' || !source || source.agentClassName !== input.agentClassName) {
      return { outcome: 'cancelled_or_stale', attemptId: input.attemptId, reason: 'response-only correction source is stale' };
    }
    const claim = await this.deps.workUnitClaimService.claim({
      taskId: task.id,
      subtask: { id: subtask.id, preferredAgentClassList: [input.agentClassName] },
      attemptId: input.attemptId,
    });
    if (!claim) return { outcome: 'capacity_unavailable', attemptId: input.attemptId, agentClassName: input.agentClassName };
    const startedAt = new Date().toISOString();
    try {
      claim.startAttempt();
      this.deps.subtaskRepo.updateStatus(subtask.id, 'running');
      claim.markRunning();
      const prompt = buildCorrectionPrompt(source.rawResponse, input.completionContract, input.violations);
      const result = await this.deps.executionRuntime.runResponseOnly(input.agentClassName, prompt, 128 * 1024);
      if (!result?.success) {
        const error = result?.error ?? 'AgentClass does not enforce response-only correction';
        this.persistNonSuccess({
          attemptId: input.attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName: input.agentClassName, startedAt,
          terminalState: 'executor_failed', rawResponse: result?.output ?? '', errorCode: 'correction_unavailable', errorDetail: error,
        });
        claim.markFailed(error);
        return {
          outcome: 'executor_failed', attemptId: input.attemptId, error,
          failure: result?.failure ?? { kind: 'unknown', scope: 'attempt', code: 'correction_unavailable', summary: error },
        };
      }
      const allSubtasks = this.deps.subtaskRepo.listByTask(task.id);
      const outgoingHandoffs = allSubtasks.flatMap(candidate => {
        const dependency = candidate.dependencies.find(item => item.fromSubtaskId === subtask.id);
        return dependency ? [{ toSubtaskId: candidate.id, requiredItems: dependency.requiredItems }] : [];
      });
      const targetPath = resolve(process.cwd(), 'metaclaw-tasks', task.id);
      const completion = validateCompletionProtocol({
        rawResponse: result.output,
        subtask,
        outgoingHandoffs,
        targetPaths: [targetPath],
        cwd: process.cwd(),
        incomingUsageByTarget: new Map(outgoingHandoffs.map(contract => [
          contract.toSubtaskId,
          summarizeHandoffUsage(this.handoffRepo.listIncoming(task.id, contract.toSubtaskId)),
        ])),
      });
      if (!completion.ok) {
        const detail = completion.violations.map(item => `${item.code}:${item.path}:${item.message}`).join('; ');
        this.deps.db.transaction(() => {
          this.receiptRepo.insert(buildReceipt({
            attemptId: input.attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
            workUnitId: claim.workUnit.id, agentClassName: input.agentClassName, startedAt,
            terminalState: 'contract_blocked', rawResponse: result.output,
            completionSchemaVersion: completion.envelope?.schemaVersion ?? null,
            violations: completion.violations, errorCode: completion.violations[0]?.code ?? 'completion_malformed', errorDetail: detail,
          }));
          this.deps.subtaskRepo.updateStatus(subtask.id, 'awaiting_decision', { error: detail });
        })();
        claim.markFailed(detail);
        return {
          outcome: 'contract_failed', attemptId: input.attemptId, workUnitId: claim.workUnit.id,
          agentClassName: input.agentClassName, responseBytes: Buffer.byteLength(result.output, 'utf8'),
          receiptCount: this.receiptRepo.countByTerminal(task.id, subtask.id, 'contract_blocked'),
          completionContract: input.completionContract, violations: completion.violations,
        };
      }
      const completedAt = new Date().toISOString();
      this.deps.db.transaction(() => {
        this.receiptRepo.insert(buildReceipt({
          attemptId: input.attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName: input.agentClassName, startedAt,
          terminalState: 'completed', rawResponse: result.output, completionSchemaVersion: 1, warnings: completion.warnings,
        }, completedAt));
        for (const handoff of completion.envelope.handoffs) {
          this.handoffRepo.insert({
            taskId: task.id, fromSubtaskId: subtask.id, toSubtaskId: handoff.toSubtaskId,
            attemptId: input.attemptId, items: handoff.items, completionSchemaVersion: 1, createdAt: completedAt,
          });
        }
        this.deps.subtaskRepo.updateStatus(subtask.id, 'done', {
          result: completion.body, artifacts: completion.normalizedArtifacts,
          verification: { warnings: completion.warnings, completionSchemaVersion: 1 }, error: null,
        });
      })();
      return {
        outcome: 'completed', attemptId: input.attemptId, output: completion.body,
        artifacts: completion.normalizedArtifacts, warnings: completion.warnings,
        executorName: input.agentClassName, durationMs: result.durationMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.receiptRepo.findByAttemptId(input.attemptId)) {
        this.persistNonSuccess({
          attemptId: input.attemptId, executionId: input.executionId, taskId: input.taskId, subtaskId: input.subtaskId,
          workUnitId: claim.workUnit.id, agentClassName: input.agentClassName, startedAt,
          terminalState: 'executor_failed', rawResponse: '', errorCode: 'correction_exception', errorDetail: message,
        });
      }
      claim.markFailed(message);
      return {
        outcome: 'executor_failed', attemptId: input.attemptId, error: message,
        failure: { kind: 'unknown', scope: 'attempt', code: 'correction_exception', summary: message },
      };
    } finally {
      claim.release();
    }
  }

  private isStillCurrent(taskId: string, subtaskId: string, attemptId: string, workUnitId: string): boolean {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    const subtask = this.deps.subtaskRepo.findById(subtaskId);
    const workUnit = this.deps.db.prepare(`SELECT state, claimed_attempt_id FROM work_units WHERE id = ?`)
      .get(workUnitId) as { state: string; claimed_attempt_id: string | null } | undefined;
    return task?.status === 'running'
      && subtask?.status === 'running'
      && workUnit?.state === 'running'
      && workUnit.claimed_attempt_id === attemptId;
  }

  private isAttemptClaimCurrent(attemptId: string, workUnitId: string): boolean {
    const workUnit = this.deps.db.prepare(`SELECT claimed_attempt_id FROM work_units WHERE id = ?`)
      .get(workUnitId) as { claimed_attempt_id: string | null } | undefined;
    return workUnit?.claimed_attempt_id === attemptId;
  }

  private persistNonSuccess(input: {
    attemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    workUnitId: string;
    agentClassName: string;
    startedAt: string;
    terminalState: ExecutorAttemptReceipt['terminalState'];
    rawResponse: string;
    errorCode: string;
    errorDetail: string;
  }): void {
    this.deps.db.transaction(() => {
      this.receiptRepo.insert(buildReceipt(input));
      this.deps.subtaskRepo.updateStatus(input.subtaskId, 'awaiting_decision', { error: input.errorDetail });
    })();
  }
}

function summarizeHandoffUsage(handoffs: Array<{ items: CompletionHandoffV1['items'] }>): {
  textCharacters: number;
  artifactPaths: number;
} {
  let textCharacters = 0;
  let artifactPaths = 0;
  for (const handoff of handoffs) {
    for (const item of handoff.items) {
      if (item.type === 'text') textCharacters += item.value.length;
      else artifactPaths += item.paths.length;
    }
  }
  return { textCharacters, artifactPaths };
}

function buildReceipt(input: {
  attemptId: string;
  executionId: string;
  taskId: string;
  subtaskId: string;
  workUnitId: string;
  agentClassName: string;
  startedAt: string;
  terminalState: ExecutorAttemptReceipt['terminalState'];
  rawResponse: string;
  completionSchemaVersion?: number | null;
  warnings?: string[];
  violations?: CompletionContractViolation[];
  errorCode?: string | null;
  errorDetail?: string | null;
}, completedAt = new Date().toISOString()): ExecutorAttemptReceipt {
  return {
    attemptId: input.attemptId,
    executionId: input.executionId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    workUnitId: input.workUnitId,
    agentClassName: input.agentClassName,
    startedAt: input.startedAt,
    completedAt,
    terminalState: input.terminalState,
    rawResponse: input.rawResponse,
    completionSchemaVersion: input.completionSchemaVersion ?? null,
    parsing: { completionMarker: input.completionSchemaVersion ? 'parsed' : 'unavailable' },
    verification: { warnings: input.warnings ?? [], violations: input.violations ?? [] },
    errorCode: input.errorCode ?? null,
    errorDetail: input.errorDetail ?? null,
  };
}

function buildCorrectionPrompt(
  rawResponse: string,
  completionContract: unknown,
  violations: CompletionContractViolation[],
): string {
  return [
    'Correct only the final response format. Do not execute the task, use tools, inspect files, or change the workspace.',
    'Return non-empty Markdown followed by exactly one completion trailer.',
    `Trailer marker: ${COMPLETION_MARKER_V1}`,
    `Completion contract:\n${JSON.stringify(completionContract, null, 2)}`,
    `Violations:\n${JSON.stringify(violations, null, 2)}`,
    `Original response:\n${rawResponse}`,
  ].join('\n\n');
}
