// Applies a Kernel-approved v7 work graph revision or recovers its active revision.
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { Subtask, Task } from '../core/types.js';
import type { WorkGraphSubtask as SubtaskProposal, WorkGraphProposal } from '../work-graph/types.js';
import { SubtaskRepo } from '../storage/subtask-repo.js';
import { TaskEventRepo } from '../storage/task-event-repo.js';
import { TaskEventRecorder } from '../storage/task-event-recorder.js';
import { createEvidenceId, TaskExecutionEvidenceRepo } from './execution-evidence-port.js';
import { WorkGraphRevisionRepo } from '../storage/work-graph-revision-repo.js';

export interface WorkGraphAuthorization {
  decisionId: string;
  generationId: string;
  revision: number;
  source: 'initial' | 'replan' | 'conflict_replan';
  automaticReplan: boolean;
}

export type WorkGraphRuntimeResult =
  | { outcome: 'applied'; workGraph: WorkGraphProposal; subtasks: Subtask[] }
  | { outcome: 'recovered'; workGraph: WorkGraphProposal; subtasks: Subtask[] }
  | {
      outcome: 'not_executable';
      reason:
        | 'missing_graph'
        | 'missing_authorization'
        | 'missing_authorized_bindings'
        | 'configuration_conflict'
        | 'revision_conflict'
        | 'generation_conflict';
    };

/** Runtime materialization deliberately has no planning or routing fallback. */
export class WorkGraphRuntimeService {
  private readonly taskEvents: TaskEventRecorder;

  constructor(
    private readonly subtaskRepo: SubtaskRepo,
    taskEventRepo: TaskEventRepo,
    private readonly revisionRepo: WorkGraphRevisionRepo,
    private readonly evidenceRepo?: TaskExecutionEvidenceRepo,
  ) {
    this.taskEvents = new TaskEventRecorder(taskEventRepo);
  }

  apply(input: {
    task: Task;
    userPrompt: string;
    sessionId?: string;
    authorizedWorkGraph?: WorkGraphProposal | null;
    authorizedBindingsBySubtask?: Readonly<Record<string, AuthorizedExecutorBinding[]>> | null;
    authorization?: WorkGraphAuthorization | null;
  }): WorkGraphRuntimeResult {
    const proposedGraph = input.authorizedWorkGraph ?? null;
    const activeRevision = this.revisionRepo.findActive(input.task.id);
    const existing = activeRevision
      ? this.subtaskRepo.listActiveByTask(input.task.id)
      : this.subtaskRepo.listByTask(input.task.id);

    if (proposedGraph) {
      const authorization = input.authorization ?? null;
      if (!authorization) return { outcome: 'not_executable', reason: 'missing_authorization' };
      const authorizedBindings = validateAuthorizedBindings(
        proposedGraph,
        input.authorizedBindingsBySubtask ?? null,
      );
      if (!authorizedBindings) {
        return { outcome: 'not_executable', reason: 'missing_authorized_bindings' };
      }
      if (authorizedBindings === 'configuration_conflict') {
        return { outcome: 'not_executable', reason: 'configuration_conflict' };
      }
      if (activeRevision) {
        if (authorization.generationId !== activeRevision.generationId) {
          return { outcome: 'not_executable', reason: 'generation_conflict' };
        }
        if (proposedGraph.configurationRevision !== activeRevision.configurationRevision) {
          return { outcome: 'not_executable', reason: 'configuration_conflict' };
        }
        if (authorization.revision === activeRevision.revision) {
          return { outcome: 'recovered', workGraph: proposedGraph, subtasks: existing };
        }
        if (
          !['replan', 'conflict_replan'].includes(authorization.source)
          || authorization.revision !== activeRevision.revision + 1
        ) {
          return { outcome: 'not_executable', reason: 'revision_conflict' };
        }
      } else if (authorization.revision !== 1 || authorization.source !== 'initial') {
        return { outcome: 'not_executable', reason: 'revision_conflict' };
      }
      return this.revisionRepo.transaction(() => {
        if (activeRevision) this.supersedeActiveRevision(input.task.id, activeRevision.revision, existing);
        const now = new Date().toISOString();
        this.revisionRepo.activate({
          id: revisionId(input.task.id, authorization.revision),
          taskId: input.task.id,
          revision: authorization.revision,
          generationId: authorization.generationId,
          configurationRevision: proposedGraph.configurationRevision,
          authorizedDecisionId: authorization.decisionId,
          proposalSource: authorization.source,
          automaticReplan: authorization.automaticReplan,
          createdAt: now,
          updatedAt: now,
        });
        const subtasks = this.persistWorkGraph(
          input.task.id,
          input.userPrompt,
          input.sessionId,
          proposedGraph,
          authorizedBindings,
          authorization,
        );
        return { outcome: 'applied', workGraph: proposedGraph, subtasks } as const;
      });
    }
    if (activeRevision && existing.length > 0) {
      return {
        outcome: 'recovered',
        workGraph: {
          schemaVersion: 7,
          configurationRevision: activeRevision.configurationRevision,
          reason: 'reusing existing persisted v7 work graph revision',
          subtasks: existing.map(subtaskToProposal),
        },
        subtasks: existing,
      };
    }
    return { outcome: 'not_executable', reason: 'missing_graph' };
  }

  materializeCompletedEvidence(taskId: string, revision: number): string[] {
    const ids: string[] = [];
    for (const subtask of this.subtaskRepo.listByTask(taskId).filter(item =>
      item.graphRevision === revision && item.status === 'done'
    )) {
      const evidenceId = createEvidenceId('task_evidence', `${taskId}_r${revision}_${subtask.id}`);
      this.evidenceRepo?.upsert({
        id: evidenceId,
        taskId,
        kind: 'task_evidence',
        sourceId: subtask.id,
        title: `Completed work: ${subtask.title}`,
        content: boundedTaskEvidence(subtask),
        exactOnly: false,
      });
      ids.push(evidenceId);
    }
    return ids;
  }

  private supersedeActiveRevision(taskId: string, revision: number, existing: Subtask[]): void {
    this.materializeCompletedEvidence(taskId, revision);
    for (const subtask of existing) {
      if (subtask.status === 'done') {
        continue;
      }
      if (subtask.status !== 'cancelled') {
        this.subtaskRepo.updateStatus(subtask.id, 'cancelled', {
          error: `superseded by graph revision ${revision + 1}`,
        });
        this.taskEvents.record(taskId, subtask.id, 'subtask_superseded', `graph revision ${revision + 1}`, {
          previousRevision: revision,
          nextRevision: revision + 1,
        });
      }
    }
  }

  private persistWorkGraph(
    taskId: string,
    userPrompt: string,
    sessionId: string | undefined,
    workGraph: WorkGraphProposal,
    authorizedBindingsBySubtask: Readonly<Record<string, AuthorizedExecutorBinding[]>>,
    authorization: WorkGraphAuthorization,
  ): Subtask[] {
    const now = new Date().toISOString();
    const idMap = buildSubtaskIdMap(taskId, authorization.revision, workGraph.subtasks);
    const subtasks: Subtask[] = workGraph.subtasks.map(proposal => ({
      id: idMap.get(proposal.id) ?? stableSubtaskId(taskId, authorization.revision, proposal.id, new Set()),
      taskId,
      graphRevision: authorization.revision,
      generationId: authorization.generationId,
      title: proposal.title,
      goal: proposal.goal,
      status: 'ready',
      dependencies: proposal.dependencies.map(dependency => ({
        ...dependency,
        fromSubtaskId: idMap.get(dependency.fromSubtaskId)
          ?? normalizeSubtaskId(taskId, authorization.revision, dependency.fromSubtaskId),
      })),
      contextRefs: proposal.contextRefs,
      requiredCapabilities: proposal.requiredCapabilities,
      executorBindings: authorizedBindingsBySubtask[proposal.id]!,
      deliveryKind: proposal.deliveryKind,
      acceptance: proposal.acceptance,
      riskLevel: proposal.riskLevel,
      result: '',
      artifacts: [],
      verification: { warnings: [], completionSchemaVersion: null },
      error: null,
      createdAt: now,
      updatedAt: now,
    }));

    for (const subtask of subtasks) {
      this.subtaskRepo.upsert(subtask);
      this.taskEvents.record(taskId, subtask.id, 'subtask_planned', subtask.title, {
        dependencies: subtask.dependencies,
        requiredCapabilities: subtask.requiredCapabilities,
        executorBindings: subtask.executorBindings,
      });
    }
    if (subtasks.some(subtask => subtask.contextRefs.some(ref => ref.kind === 'current_user_input'))) {
      this.evidenceRepo?.upsert({
        id: createEvidenceId('current_user_input', taskId),
        taskId,
        kind: 'user_input',
        sourceId: taskId,
        title: 'Current user input',
        content: userPrompt,
      });
    }
    for (const ref of subtasks.flatMap(subtask => subtask.contextRefs).filter(ref => ref.kind === 'interaction')) {
      if (!sessionId) throw new Error('sessionId is required to materialize interaction evidence');
      this.evidenceRepo?.materializeInteraction({
        taskId,
        sessionId,
        interactionId: ref.interactionId,
        side: ref.side,
      });
    }
    this.taskEvents.record(taskId, null, 'work_graph_applied', workGraph.reason, {
      subtaskIds: subtasks.map(subtask => subtask.id),
      graphRevision: authorization.revision,
      generationId: authorization.generationId,
      configurationRevision: workGraph.configurationRevision,
      authorizedDecisionId: authorization.decisionId,
    });
    return subtasks;
  }
}

function subtaskToProposal(subtask: Subtask): SubtaskProposal {
  return {
    id: subtask.id,
    title: subtask.title,
    goal: subtask.goal,
    dependencies: subtask.dependencies,
    contextRefs: subtask.contextRefs,
    requiredCapabilities: subtask.requiredCapabilities as SubtaskProposal['requiredCapabilities'],
    executorBindings: subtask.executorBindings.map(binding => ({
      agentClassRef: binding.agentClassRef,
      modelSelection: {
        mode: 'proposed',
        modelRef: binding.modelRef,
        reason: 'recovered from Kernel-authorized binding',
      },
    })),
    deliveryKind: subtask.deliveryKind,
    acceptance: subtask.acceptance,
    riskLevel: subtask.riskLevel,
  };
}

function validateAuthorizedBindings(
  workGraph: WorkGraphProposal,
  authorizedBindingsBySubtask: Readonly<Record<string, AuthorizedExecutorBinding[]>> | null,
): Readonly<Record<string, AuthorizedExecutorBinding[]>> | 'configuration_conflict' | null {
  if (!authorizedBindingsBySubtask) return null;
  const proposalIds = new Set(workGraph.subtasks.map(subtask => subtask.id));
  const bindingIds = Object.keys(authorizedBindingsBySubtask);
  if (
    bindingIds.length !== proposalIds.size
    || bindingIds.some(id => !proposalIds.has(id))
  ) {
    return null;
  }
  for (const subtask of workGraph.subtasks) {
    const bindings = authorizedBindingsBySubtask[subtask.id];
    if (!bindings || bindings.length === 0) return null;
    if (bindings.some(
      binding => binding.configurationRevision !== workGraph.configurationRevision,
    )) {
      return 'configuration_conflict';
    }
  }
  return authorizedBindingsBySubtask;
}

function buildSubtaskIdMap(taskId: string, revision: number, proposals: SubtaskProposal[]): Map<string, string> {
  const used = new Set<string>();
  const idMap = new Map<string, string>();
  for (const proposal of proposals) idMap.set(proposal.id, stableSubtaskId(taskId, revision, proposal.id, used));
  return idMap;
}

function stableSubtaskId(taskId: string, revision: number, id: string, used: Set<string>): string {
  const base = normalizeSubtaskId(taskId, revision, id);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  for (;;) {
    const candidate = `${base}_${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    index += 1;
  }
}

function normalizeSubtaskId(taskId: string, revision: number, id: string): string {
  if (id.startsWith(`${taskId}_r${revision}_`)) return id;
  const safeId = id.replace(/[^a-zA-Z0-9_:-]+/g, '_').replace(/^_+|_+$/g, '') || 'subtask_execute';
  return `${taskId}_r${revision}_${safeId}`;
}

function revisionId(taskId: string, revision: number): string {
  return `graph_revision_${taskId}_${revision}`;
}

function boundedTaskEvidence(subtask: Subtask): string {
  return JSON.stringify({
    subtaskId: subtask.id,
    title: subtask.title,
    result: subtask.result.slice(0, 12_000),
    artifacts: subtask.artifacts.slice(0, 100),
    verification: subtask.verification,
  }).slice(0, 16_000);
}
