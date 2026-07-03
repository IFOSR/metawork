import type { Subtask, Task } from '../core/types.js';
import type { PlanningAgentPlan, SubtaskProposal, WorkGraphProposal } from '../planning/planning-types.js';
import { SubtaskRepo } from '../storage/subtask-repo.js';
import { TaskEventRepo } from '../storage/task-event-repo.js';
import { generateInteractionId } from '../utils/id.js';

export interface WorkGraphRuntimeResult {
  workGraph: WorkGraphProposal;
  subtasks: Subtask[];
  recovered: boolean;
}

export class WorkGraphRuntimeService {
  constructor(
    private readonly subtaskRepo: SubtaskRepo,
    private readonly taskEventRepo: TaskEventRepo,
  ) {}

  apply(input: {
    task: Task;
    userPrompt: string;
    approvedPlan?: PlanningAgentPlan | null;
  }): WorkGraphRuntimeResult {
    const existing = this.subtaskRepo.listByTask(input.task.id);
    if (existing.length > 0) {
      return this.recoverExisting(input.task.id, existing);
    }

    const workGraph = input.approvedPlan?.workGraph ?? fallbackWorkGraph(input.task, input.userPrompt);
    const subtasks = this.persistWorkGraph(input.task.id, workGraph);
    return { workGraph, subtasks, recovered: false };
  }

  private recoverExisting(taskId: string, existing: Subtask[]): WorkGraphRuntimeResult {
    const subtasks = existing.map(subtask => {
      if (subtask.status === 'done') {
        return subtask;
      }
      const previousStatus = subtask.status;
      const readySubtask = {
        ...subtask,
        status: 'ready' as const,
      };
      if (previousStatus !== 'ready') {
        this.subtaskRepo.upsert(readySubtask);
        this.recordTaskEvent(taskId, readySubtask.id, 'subtask_recovered_for_dispatch', readySubtask.title, {
          previousStatus,
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
      this.recordTaskEvent(taskId, subtask.id, 'subtask_planned', subtask.title, {
        dependsOn: subtask.dependsOn,
        candidateAgentClasses: subtask.candidateAgentClasses,
      });
    }
    this.recordTaskEvent(taskId, null, 'work_graph_applied', workGraph.reason, {
      subtaskIds: subtasks.map(subtask => subtask.id),
    });

    return subtasks;
  }

  private recordTaskEvent(
    taskId: string,
    subtaskId: string | null,
    eventType: string,
    message: string,
    payload: Record<string, unknown>,
  ): void {
    this.taskEventRepo.insert({
      id: `te_${generateInteractionId()}`,
      taskId,
      subtaskId,
      eventType,
      message,
      payload,
      createdAt: new Date().toISOString(),
    });
  }
}

function fallbackWorkGraph(task: Task, userPrompt: string): WorkGraphProposal {
  return {
    reason: 'runtime fallback for scheduled task without an approved work graph proposal',
    subtasks: [{
      id: 'subtask_execute',
      title: task.title || 'Execute task',
      goal: userPrompt,
      dependsOn: [],
      requiredAgentClassKind: 'executor',
      agentClassHint: null,
      candidateAgentClasses: [],
      expectedOutput: 'summary',
      acceptance: ['Satisfy the user request and report verification or remaining risk.'],
      riskLevel: 'medium',
    }],
  };
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
