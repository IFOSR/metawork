import type { Subtask, Task } from '../core/types.js';
import type { PlanningAgentPlan, SubtaskProposal, WorkGraphProposal } from '../planning/planning-types.js';
import { SubtaskRepo } from '../storage/subtask-repo.js';
import { TaskEventRepo } from '../storage/task-event-repo.js';
import { TaskEventRecorder } from '../storage/task-event-recorder.js';

export interface WorkGraphRuntimeResult {
  workGraph: WorkGraphProposal;
  subtasks: Subtask[];
  recovered: boolean;
}

export class WorkGraphRuntimeService {
  private readonly taskEvents: TaskEventRecorder;

  constructor(
    private readonly subtaskRepo: SubtaskRepo,
    taskEventRepo: TaskEventRepo,
  ) {
    this.taskEvents = new TaskEventRecorder(taskEventRepo);
  }

  apply(input: {
    task: Task;
    userPrompt: string;
    approvedPlan?: PlanningAgentPlan | null;
  }): WorkGraphRuntimeResult {
    const approvedPlan = input.approvedPlan ?? null;
    const existing = this.subtaskRepo.listByTask(input.task.id);
    if (existing.length > 0) {
      return this.recoverExisting(input.task.id, existing, approvedPlan);
    }

    const workGraph = approvedPlan?.workGraph ?? fallbackWorkGraph(input.task, input.userPrompt, approvedPlan);
    const subtasks = this.persistWorkGraph(input.task.id, workGraph);
    return { workGraph, subtasks, recovered: false };
  }

  private recoverExisting(taskId: string, existing: Subtask[], approvedPlan: PlanningAgentPlan | null): WorkGraphRuntimeResult {
    // Kernel-approved executor routing (e.g. after rewriteUnavailableExecutors)
    // must win over the stale persisted routing when recovering a task.
    const approvedRouting = buildApprovedRoutingMap(taskId, approvedPlan);
    const subtasks = existing.map(subtask => {
      // Terminal subtasks are never resurrected — flipping a done/cancelled/
      // archived subtask back to ready would silently re-run finished or
      // deliberately-stopped work.
      if (isTerminalStatus(subtask.status)) {
        return subtask;
      }
      const previousStatus = subtask.status;
      const routing = approvedRouting.get(subtask.id) ?? null;
      const rerouted = routing !== null && (
        routing.agentClassHint !== subtask.agentClassHint
        || !sameStringList(routing.candidateAgentClasses, subtask.candidateAgentClasses)
      );
      const readySubtask: Subtask = {
        ...subtask,
        status: 'ready' as const,
        ...(routing
          ? { agentClassHint: routing.agentClassHint, candidateAgentClasses: routing.candidateAgentClasses }
          : {}),
      };
      if (previousStatus !== 'ready' || rerouted) {
        this.subtaskRepo.upsert(readySubtask);
        this.taskEvents.record(taskId, readySubtask.id, 'subtask_recovered_for_dispatch', readySubtask.title, {
          previousStatus,
          rerouted,
        });
      }
      return readySubtask;
    });

    return {
      workGraph: {
        reason: 'reusing existing persisted work graph',
        subtasks: subtasks.map(subtaskToProposal),
      },
      subtasks,
      recovered: true,
    };
  }

  private persistWorkGraph(taskId: string, workGraph: WorkGraphProposal): Subtask[] {
    const now = new Date().toISOString();
    const idMap = buildSubtaskIdMap(taskId, workGraph.subtasks);
    const subtasks = workGraph.subtasks.map(proposal => ({
      ...proposal,
      id: idMap.get(proposal.id) ?? stableSubtaskId(taskId, proposal.id, new Set()),
      taskId,
      status: 'ready' as const,
      dependsOn: proposal.dependsOn.map(dependencyId => idMap.get(dependencyId) ?? normalizeSubtaskId(taskId, dependencyId)),
      result: '',
      error: null,
      createdAt: now,
      updatedAt: now,
    }));

    for (const subtask of subtasks) {
      this.subtaskRepo.upsert(subtask);
      this.taskEvents.record(taskId, subtask.id, 'subtask_planned', subtask.title, {
        dependsOn: subtask.dependsOn,
        candidateAgentClasses: subtask.candidateAgentClasses,
      });
    }
    this.taskEvents.record(taskId, null, 'work_graph_applied', workGraph.reason, {
      subtaskIds: subtasks.map(subtask => subtask.id),
    });

    return subtasks;
  }
}

/**
 * Runtime fallback for a scheduled task whose plan carries no work graph
 * (e.g. a resume/continuation relabeled to plan_work_graph). When an approved
 * plan is present, its execution routing and risk are threaded into the
 * fallback subtask instead of a fully generic one, so planned executor
 * candidates / expected output are not silently discarded.
 */
function fallbackWorkGraph(task: Task, userPrompt: string, approvedPlan: PlanningAgentPlan | null): WorkGraphProposal {
  const execution = approvedPlan?.execution ?? null;
  const candidateAgentClasses = execution
    ? uniqueStrings([execution.selectedExecutor, ...execution.candidateExecutors])
    : [];
  const expectedOutput: Subtask['expectedOutput'] = execution?.capabilityClass === 'code_edit' ? 'patch' : 'summary';
  return {
    reason: 'runtime fallback for scheduled task without an approved work graph proposal',
    subtasks: [{
      id: 'subtask_execute',
      title: task.title || 'Execute task',
      goal: userPrompt,
      dependsOn: [],
      requiredAgentClassKind: 'executor',
      agentClassHint: candidateAgentClasses[0] ?? null,
      candidateAgentClasses,
      expectedOutput,
      acceptance: expectedOutput === 'patch'
        ? ['List changed files and provide test command output or explain why tests were not run.']
        : ['Satisfy the user request and report verification or remaining risk.'],
      riskLevel: mapRiskLevel(approvedPlan?.risk.level),
    }],
  };
}

function mapRiskLevel(level: PlanningAgentPlan['risk']['level'] | undefined): Subtask['riskLevel'] {
  if (level === 'high') return 'high';
  if (level === 'low') return 'low';
  return 'medium';
}

function uniqueStrings(items: Array<string | null>): string[] {
  return Array.from(new Set(items.filter((item): item is string => Boolean(item))));
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

const TERMINAL_SUBTASK_STATUSES: ReadonlySet<Subtask['status']> = new Set(['done', 'cancelled', 'archived']);

function isTerminalStatus(status: Subtask['status']): boolean {
  return TERMINAL_SUBTASK_STATUSES.has(status);
}

/**
 * Map persisted subtask id -> kernel-approved executor routing, keyed by the
 * same normalized id the proposals persist under, so recovery can adopt the
 * approved candidates/hint for a matching subtask.
 */
function buildApprovedRoutingMap(
  taskId: string,
  approvedPlan: PlanningAgentPlan | null,
): Map<string, { agentClassHint: string | null; candidateAgentClasses: string[] }> {
  const routing = new Map<string, { agentClassHint: string | null; candidateAgentClasses: string[] }>();
  const proposals = approvedPlan?.workGraph?.subtasks ?? [];
  for (const proposal of proposals) {
    routing.set(normalizeSubtaskId(taskId, proposal.id), {
      agentClassHint: proposal.agentClassHint,
      candidateAgentClasses: proposal.candidateAgentClasses,
    });
  }
  return routing;
}

function subtaskToProposal(subtask: Subtask): SubtaskProposal {
  return {
    id: subtask.id,
    title: subtask.title,
    goal: subtask.goal,
    dependsOn: subtask.dependsOn,
    requiredAgentClassKind: subtask.requiredAgentClassKind,
    agentClassHint: subtask.agentClassHint,
    candidateAgentClasses: subtask.candidateAgentClasses,
    expectedOutput: subtask.expectedOutput,
    acceptance: subtask.acceptance,
    riskLevel: subtask.riskLevel,
  };
}

function buildSubtaskIdMap(taskId: string, proposals: SubtaskProposal[]): Map<string, string> {
  const used = new Set<string>();
  const idMap = new Map<string, string>();
  for (const proposal of proposals) {
    idMap.set(proposal.id, stableSubtaskId(taskId, proposal.id, used));
  }
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
  if (id.startsWith(`${taskId}_`)) {
    return id;
  }
  const safeId = id.replace(/[^a-zA-Z0-9_:-]+/g, '_').replace(/^_+|_+$/g, '') || 'subtask_execute';
  return `${taskId}_${safeId}`;
}
