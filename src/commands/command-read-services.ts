import type Database from 'better-sqlite3';
import type { WorkUnitEvent } from '../core/types.js';
import type { ExecutorRegistrationInspection } from '../execution/execution-runtime.js';
import { AgentClassRepo } from '../storage/agent-class-repo.js';
import { KernelDecisionRepo } from '../storage/kernel-decision-repo.js';
import { TaskEventRepo } from '../storage/task-event-repo.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';

const TASK_HISTORY_LIMIT = 20;
const ACTIVE_WORK_UNIT_STATES = new Set(['starting', 'claimed', 'running', 'waiting']);
const FEEDBACK_WORK_UNIT_EVENTS = new Set([
  'claimed',
  'running',
  'waiting',
  'released',
  'failed',
  'heartbeat_lost',
]);
const FEEDBACK_TASK_EVENTS = new Set([
  'subtask_claimed',
  'subtask_done',
  'subtask_failed',
  'subtask_exception',
  'subtask_abandoned_after_task_status_change',
  'dispatch_stopped',
  'work_unit_heartbeat_lost',
  'no_ready_subtask_blocked',
]);

export interface ExecutorRuntimeInspector {
  inspectExecutorRegistration(name: string): ExecutorRegistrationInspection;
}

export interface CommandReadServicesDependencies {
  getConfigurationRevision?(): Promise<string | null> | string | null;
}

interface InteractionHistoryRow {
  id: string;
  user_input: string | null;
  system_output: string | null;
  executor_used: string | null;
  created_at: string;
}

interface TaskSummaryRow {
  id: string;
  title: string;
  status: string;
}

type TaskHistoryEntry =
  | { kind: 'interaction'; createdAt: string; row: InteractionHistoryRow }
  | { kind: 'task-event'; createdAt: string; event: ReturnType<TaskEventRepo['listByTask']>[number] };

export class CommandReadServices {
  private readonly agentClasses: AgentClassRepo;
  private readonly kernelDecisions: KernelDecisionRepo;
  private readonly taskEvents: TaskEventRepo;
  private readonly workUnits: WorkUnitRepo;

  constructor(
    private readonly db: Database.Database,
    private readonly executorRuntime: ExecutorRuntimeInspector,
    private readonly dependencies: CommandReadServicesDependencies = {},
  ) {
    this.agentClasses = new AgentClassRepo(db);
    this.kernelDecisions = new KernelDecisionRepo(db);
    this.taskEvents = new TaskEventRepo(db);
    this.workUnits = new WorkUnitRepo(db);
  }

  async currentConfigurationRevision(): Promise<string | null> {
    return await this.dependencies.getConfigurationRevision?.() ?? null;
  }

  taskHistory(taskId: string): string {
    const task = this.findTask(taskId);
    if (!task) {
      return `Error: task not found ${taskId}`;
    }

    const fetchLimit = TASK_HISTORY_LIMIT + 1;
    const interactions = this.db.prepare(`
      SELECT id, user_input, system_output, executor_used, created_at
      FROM interactions
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(taskId, fetchLimit) as InteractionHistoryRow[];
    const taskEvents = this.taskEvents.listRecentByTask(taskId, fetchLimit);
    const merged: TaskHistoryEntry[] = [
      ...interactions.map(row => ({ kind: 'interaction' as const, createdAt: row.created_at, row })),
      ...taskEvents.map(event => ({ kind: 'task-event' as const, createdAt: event.createdAt, event })),
    ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    if (merged.length === 0) {
      return `任务 #${task.id} ${task.title} 暂无持久化历史。`;
    }

    const truncated = merged.length > TASK_HISTORY_LIMIT;
    const selected = merged.slice(0, TASK_HISTORY_LIMIT).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const lines = [
      `任务历史：#${task.id} [${task.status.toUpperCase()}] ${task.title}`,
      ...(truncated ? [`仅展示最近 ${TASK_HISTORY_LIMIT} 条记录。`] : []),
      ...selected.flatMap(entry => this.formatTaskHistoryEntry(entry)),
    ];
    return lines.join('\n');
  }

  executorDetails(executorName: string): string {
    const agentClass = this.agentClasses.findByName(executorName);
    if (!agentClass) {
      return `Error: Executor AgentClass is not registered: ${executorName}`;
    }

    const registration = this.executorRuntime.inspectExecutorRegistration(executorName);
    const activeWorkUnits = this.workUnits.listByAgentClass(executorName)
      .filter(unit => ACTIVE_WORK_UNIT_STATES.has(unit.state));
    const affinity = Object.entries(agentClass.intentAffinity)
      .map(([intent, score]) => `${intent}:${score}`)
      .join(', ') || '-';
    const runtime = [agentClass.runtimeCommand, ...agentClass.runtimeArgs].filter(Boolean).join(' ') || '-';
    const lines = [
      `Executor AgentClass：${agentClass.name}`,
      `  kind: ${agentClass.kind}`,
      '  配置状态: 已配置',
      `  runtime binding: ${registration.bindingSource}${registration.adapterName ? ` (${registration.adapterName})` : ''}`,
      `  runtime configured: ${registration.configured ? '是' : '否'}`,
      `  domains: ${formatList(agentClass.domains)}`,
      `  capabilities: ${formatList(agentClass.capabilities)}`,
      `  input types: ${formatList(agentClass.inputTypes)}`,
      `  output types: ${formatList(agentClass.outputTypes)}`,
      `  strengths: ${formatList(agentClass.strengths)}`,
      `  weaknesses: ${formatList(agentClass.weaknesses)}`,
      `  primary use cases: ${formatList(agentClass.primaryUseCases)}`,
      `  avoid use cases: ${formatList(agentClass.avoidUseCases)}`,
      `  intent affinity: ${affinity}`,
      `  risk: ${agentClass.riskLevel}`,
      `  harness/model: ${agentClass.harness ?? '-'} / ${agentClass.model ?? '-'}`,
      `  skills: ${formatList(agentClass.skills)}`,
      `  MCP servers: ${formatList(agentClass.mcpServers)}`,
      `  plugins: ${formatList(agentClass.plugins)}`,
      `  runtime command: ${runtime}`,
      `  runtime check: ${agentClass.runtimeCheckCommand ?? '-'}`,
      `  project URL: ${agentClass.projectUrl ?? '-'}`,
      '',
      `当前工作的 WorkUnits (${activeWorkUnits.length})：`,
      ...(activeWorkUnits.length > 0
        ? activeWorkUnits.map(unit => [
            `  - ${unit.id} [${unit.state}]`,
            ` task=${unit.claimedTaskId ?? '-'} subtask=${unit.claimedSubtaskId ?? '-'}`,
            ` heartbeat=${unit.heartbeatAt ?? '-'} lease=${unit.leaseExpiresAt ?? '-'}`,
          ].join(''))
        : ['  - 无']),
    ];
    return lines.join('\n');
  }

  executorFeedback(taskId: string): string {
    const task = this.findTask(taskId);
    if (!task) {
      return `Error: task not found ${taskId}`;
    }

    const kernelDecisions = this.kernelDecisions.listByTask(taskId).map(record => {
      const plan = record.event.type === 'plan_proposed' ? record.event.proposal : null;
      return {
        ...record,
        plan,
        planSchemaVersion: plan?.schemaVersion ?? null,
        decisionPlanSchemaVersion: plan?.schemaVersion ?? null,
        outcome: 'issued',
        decision: { plan, runtimeAction: record.action } as Record<string, unknown>,
      };
    });
    const decisions = kernelDecisions
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const workUnitEvents = collapseWorkUnitHeartbeats(
      this.workUnits.listEventsByTask(taskId).filter(event => FEEDBACK_WORK_UNIT_EVENTS.has(event.eventType)),
    );
    const executorEvents = this.taskEvents.listByTask(taskId)
      .filter(event => FEEDBACK_TASK_EVENTS.has(event.eventType));

    return [
      `Executor 路由反馈：#${task.id} [${task.status.toUpperCase()}] ${task.title}`,
      '',
      '1. Planner 提议',
      ...(decisions.length > 0
        ? decisions.flatMap(record => {
            const auditPlan = readAuditPlan(record.plan);
            return [
              `  - ${record.createdAt} schema=v${record.planSchemaVersion ?? '?'} action=${auditPlan.action} reason=${auditPlan.reason}`,
              ...(auditPlan.subtasks.length > 0
                ? auditPlan.subtasks.map(subtask => `    ${subtask.id}: ${subtask.routing}`)
                : ['    无 WorkGraph']),
            ];
          })
        : ['  - 该任务没有可关联的 Planner 路由记录（旧任务可能未保存 taskId 关联）。']),
      '',
      '2. ControlKernel 决策',
      ...(decisions.length > 0
        ? decisions.flatMap(record => {
            const decision = isRecord(record.decision) ? record.decision : {};
            const auditPlan = readAuditPlan(decision.plan);
            return [
              `  - ${record.createdAt} schema=v${record.decisionPlanSchemaVersion ?? '?'} outcome=${record.outcome} action=${String(decision.runtimeAction ?? '-')} reason=${record.reason}`,
              ...(auditPlan.subtasks.length > 0
                ? auditPlan.subtasks.map(subtask => `    ${subtask.id}: ${subtask.routing}`)
                : ['    无获批 WorkGraph']),
            ];
          })
        : ['  - 无']),
      '',
      '3. WorkUnit 过程',
      ...(workUnitEvents.length > 0
        ? workUnitEvents.map(event =>
            `  - ${event.createdAt} ${event.workUnitId} ${event.eventType} state=${event.state ?? '-'} subtask=${event.subtaskId ?? '-'} ${event.message}`
          )
        : ['  - 无']),
      '',
      '4. Executor 结果',
      ...(executorEvents.length > 0
        ? executorEvents.map(event =>
            `  - ${event.createdAt} ${event.eventType} subtask=${event.subtaskId ?? '-'} ${event.message}`
          )
        : ['  - 无']),
    ].join('\n');
  }

  private findTask(taskId: string): TaskSummaryRow | null {
    return this.db.prepare('SELECT id, title, status FROM tasks WHERE id = ?').get(taskId) as TaskSummaryRow | undefined ?? null;
  }

  private formatTaskHistoryEntry(entry: TaskHistoryEntry): string[] {
    if (entry.kind === 'task-event') {
      return [
        `- ${entry.createdAt} [task-event:${entry.event.eventType}] subtask=${entry.event.subtaskId ?? '-'}`,
        `  ${excerpt(entry.event.message) || '-'}`,
      ];
    }
    return [
      `- ${entry.createdAt} [interaction] executor=${entry.row.executor_used ?? '-'}`,
      `  用户: ${excerpt(entry.row.user_input) || '-'}`,
      `  系统: ${excerpt(entry.row.system_output) || '-'}`,
    ];
  }
}

function formatList(values: string[]): string {
  return values.join(', ') || '-';
}

function readAuditPlan(value: unknown): { action: string; reason: string; subtasks: Array<{ id: string; routing: string }> } {
  if (!isRecord(value)) return { action: '-', reason: '-', subtasks: [] };
  const graph = isRecord(value.workGraph) ? value.workGraph : null;
  const rawSubtasks = graph && Array.isArray(graph.subtasks) ? graph.subtasks : [];
  return {
    action: String(value.action ?? '-'),
    reason: String(value.reason ?? '-'),
    subtasks: rawSubtasks.filter(isRecord).map(subtask => {
      const capabilities = stringArray(subtask.requiredCapabilities);
      const bindings = executorBindingSummaries(subtask.executorBindings);
      const preferences = stringArray(subtask.preferredAgentClassList);
      const legacyCandidates = stringArray(subtask.candidateAgentClasses);
      return {
        id: String(subtask.id ?? '-'),
        routing: bindings.length > 0
          ? `capabilities=${formatList(capabilities)} bindings=${formatList(bindings)}`
          : preferences.length > 0 || capabilities.length > 0
          ? `capabilities=${formatList(capabilities)} preferences=${formatList(preferences)}`
          : `legacyHint=${String(subtask.agentClassHint ?? '-')} legacyCandidates=${formatList(legacyCandidates)}`,
      };
    }),
  };
}

function executorBindingSummaries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map(binding => {
    const agentClassRef = String(binding.agentClassRef ?? '-');
    const selection = isRecord(binding.modelSelection) ? binding.modelSelection : null;
    if (!selection) {
      const modelRef = typeof binding.modelRef === 'string' ? binding.modelRef : '-';
      return `${agentClassRef}@${modelRef}`;
    }
    const mode = String(selection.mode ?? '-');
    const modelRef = typeof selection.modelRef === 'string' ? `:${selection.modelRef}` : '';
    return `${agentClassRef}[${mode}${modelRef}]`;
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function excerpt(value: string | null, maxLength = 200): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function collapseWorkUnitHeartbeats(events: WorkUnitEvent[]): WorkUnitEvent[] {
  const result: WorkUnitEvent[] = [];
  for (const event of events) {
    const previous = result.at(-1);
    const duplicateRunningHeartbeat = event.eventType === 'running'
      && previous?.eventType === 'running'
      && previous.workUnitId === event.workUnitId
      && previous.subtaskId === event.subtaskId;
    if (duplicateRunningHeartbeat) {
      result[result.length - 1] = event;
    } else {
      result.push(event);
    }
  }
  return result;
}
