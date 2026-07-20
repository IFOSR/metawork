// Applies a Kernel-approved v4 work graph or recovers an already-persisted v4 graph.
import type { Subtask, Task } from '../core/types.js';
import type { WorkGraphSubtask as SubtaskProposal, WorkGraphProposal } from '../work-graph/types.js';
import { SubtaskRepo } from '../storage/subtask-repo.js';
import { TaskEventRepo } from '../storage/task-event-repo.js';
import { TaskEventRecorder } from '../storage/task-event-recorder.js';
import { createEvidenceId, TaskExecutionEvidenceRepo } from './execution-evidence-port.js';

export type WorkGraphRuntimeResult =
  | { outcome: 'applied'; workGraph: WorkGraphProposal; subtasks: Subtask[] }
  | { outcome: 'recovered'; workGraph: WorkGraphProposal; subtasks: Subtask[] }
  | { outcome: 'not_executable'; reason: 'missing_graph' | 'graph_already_exists' };

/** Runtime materialization deliberately has no planning or routing fallback. */
export class WorkGraphRuntimeService {
  private readonly taskEvents: TaskEventRecorder;

  constructor(
    private readonly subtaskRepo: SubtaskRepo,
    taskEventRepo: TaskEventRepo,
    private readonly evidenceRepo?: TaskExecutionEvidenceRepo,
  ) {
    this.taskEvents = new TaskEventRecorder(taskEventRepo);
  }

  apply(input: {
    task: Task;
    userPrompt: string;
    sessionId?: string;
    authorizedWorkGraph?: WorkGraphProposal | null;
  }): WorkGraphRuntimeResult {
    const proposedGraph = input.authorizedWorkGraph ?? null;
    const existing = this.subtaskRepo.listByTask(input.task.id);

    if (proposedGraph && existing.length > 0) {
      return { outcome: 'not_executable', reason: 'graph_already_exists' };
    }
    if (proposedGraph) {
      const subtasks = this.persistWorkGraph(input.task.id, input.userPrompt, input.sessionId, proposedGraph);
      return { outcome: 'applied', workGraph: proposedGraph, subtasks };
    }
    if (existing.length > 0) {
      const subtasks = this.recoverExisting(input.task.id, existing);
      return {
        outcome: 'recovered',
        workGraph: {
          reason: 'reusing existing persisted v4 work graph',
          subtasks: subtasks.map(subtaskToProposal),
        },
        subtasks,
      };
    }
    return { outcome: 'not_executable', reason: 'missing_graph' };
  }

  private recoverExisting(taskId: string, existing: Subtask[]): Subtask[] {
    return existing.map(subtask => {
      if (isTerminalStatus(subtask.status) || subtask.status === 'ready' || subtask.status === 'blocked') return subtask;
      const blockedSubtask: Subtask = {
        ...subtask,
        status: 'blocked',
        error: subtask.error ?? `stale ${subtask.status} subtask requires explicit future recovery policy`,
      };
      this.subtaskRepo.upsert(blockedSubtask);
      this.taskEvents.record(taskId, blockedSubtask.id, 'subtask_recovery_blocked', blockedSubtask.error ?? '', {
        previousStatus: subtask.status,
      });
      return blockedSubtask;
    });
  }

  private persistWorkGraph(taskId: string, userPrompt: string, sessionId: string | undefined, workGraph: WorkGraphProposal): Subtask[] {
    const now = new Date().toISOString();
    const idMap = buildSubtaskIdMap(taskId, workGraph.subtasks);
    const subtasks: Subtask[] = workGraph.subtasks.map(proposal => ({
      ...proposal,
      id: idMap.get(proposal.id) ?? stableSubtaskId(taskId, proposal.id, new Set()),
      taskId,
      status: 'ready',
      dependencies: proposal.dependencies.map(dependency => ({
        ...dependency,
        fromSubtaskId: idMap.get(dependency.fromSubtaskId)
          ?? normalizeSubtaskId(taskId, dependency.fromSubtaskId),
      })),
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
        preferredAgentClassList: subtask.preferredAgentClassList,
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
    });
    return subtasks;
  }
}

const TERMINAL_SUBTASK_STATUSES: ReadonlySet<Subtask['status']> = new Set(['done', 'cancelled']);

function isTerminalStatus(status: Subtask['status']): boolean {
  return TERMINAL_SUBTASK_STATUSES.has(status);
}

function subtaskToProposal(subtask: Subtask): SubtaskProposal {
  return {
    id: subtask.id,
    title: subtask.title,
    goal: subtask.goal,
    dependencies: subtask.dependencies,
    contextRefs: subtask.contextRefs,
    requiredCapabilities: subtask.requiredCapabilities as SubtaskProposal['requiredCapabilities'],
    preferredAgentClassList: subtask.preferredAgentClassList as SubtaskProposal['preferredAgentClassList'],
    expectedOutput: subtask.expectedOutput,
    acceptance: subtask.acceptance,
    riskLevel: subtask.riskLevel,
  };
}

function buildSubtaskIdMap(taskId: string, proposals: SubtaskProposal[]): Map<string, string> {
  const used = new Set<string>();
  const idMap = new Map<string, string>();
  for (const proposal of proposals) idMap.set(proposal.id, stableSubtaskId(taskId, proposal.id, used));
  return idMap;
}

function stableSubtaskId(taskId: string, id: string, used: Set<string>): string {
  const base = normalizeSubtaskId(taskId, id);
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

function normalizeSubtaskId(taskId: string, id: string): string {
  if (id.startsWith(`${taskId}_`)) return id;
  const safeId = id.replace(/[^a-zA-Z0-9_:-]+/g, '_').replace(/^_+|_+$/g, '') || 'subtask_execute';
  return `${taskId}_${safeId}`;
}
