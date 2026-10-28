/**
 * `/task dashboard` presentation model.
 *
 * Two accepted decisions shape this view:
 * - ADR-0049: every surface reads the one six-state Task conclusion. The
 *   legacy active/blocked/parked/done aggregation is not a second vocabulary.
 * - ADR-0037: the execution slot is per Conversation, while the concurrency
 *   limit is account scoped. A Workspace-scoped dashboard must still show the
 *   account-wide capacity line, otherwise a task queued because of another
 *   Workspace looks inexplicable.
 *
 * This module is pure: `buildTaskDashboard()` renders facts the command
 * gathers, and it never invents a status of its own.
 */

import {
  TASK_STATUS_LABELS,
  isTerminalTaskStatus,
  type TaskOperationPhase,
  type TaskReasonCode,
  type TaskStatus,
} from '../task/task-state.js';

/** The operational detail a row may render, taken from the canonical TaskView. */
export interface TaskDashboardViewFact {
  readonly status: TaskStatus;
  readonly reasonCode: TaskReasonCode;
  readonly reasonMessage: string;
  readonly phase: TaskOperationPhase | null;
  readonly pendingActionKinds: readonly string[];
  readonly cleanup: {
    readonly state: 'none' | 'pending' | 'blocked';
    readonly objects: readonly string[];
  };
}

export interface TaskDashboardTaskFact {
  readonly taskId: string;
  readonly title: string;
  /** Persisted conclusion; used when the Runtime cannot project a full view. */
  readonly status: TaskStatus;
  readonly conversationId: string | null;
  readonly conversationTitle: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Canonical projection; `null` when the Runtime cannot project this Task. */
  readonly view: TaskDashboardViewFact | null;
}

export interface TaskDashboardCapacityFact {
  /** Slots currently holding a Task (occupied, releasing or recovery blocked). */
  readonly active: number;
  readonly limit: number;
  /** How many of `active` belong to the scoped Workspace / hold no Workspace fact. */
  readonly localActive: number;
  /** How many belong to another Workspace. */
  readonly foreignActive: number;
}

export interface TaskDashboardFacts {
  readonly now: string;
  readonly currentConversationId: string | null;
  readonly capacity: TaskDashboardCapacityFact;
  /** Tasks of every Conversation in the current Workspace. */
  readonly tasks: readonly TaskDashboardTaskFact[];
}

export interface TaskDashboardRow {
  readonly taskId: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly statusLabel: string;
  /** Only rendered when the row belongs to another Conversation. */
  readonly ownership: string | null;
  readonly reason: string;
  /** Bounded diagnostic detail; never an internal identifier list. */
  readonly detail: string | null;
  readonly actions: readonly string[];
  readonly ageLabel: string;
}

export interface TaskDashboardModel {
  readonly capacity: {
    readonly active: number;
    readonly limit: number;
    readonly text: string;
  };
  readonly needsAction: readonly TaskDashboardRow[];
  readonly executing: readonly TaskDashboardRow[];
  readonly queued: readonly TaskDashboardRow[];
  readonly finished: readonly TaskDashboardRow[];
  readonly empty: boolean;
}

const MAX_FINISHED_ROWS = 3;
const MAX_DETAIL_LENGTH = 140;

const PHASE_TEXT: Readonly<Record<TaskOperationPhase, string>> = Object.freeze({
  executing: '正在执行',
  publishing: '正在集成发布',
  delivering: '正在交付文件',
  starting_service: '正在启动服务',
  retrying: '等待自动重试',
  stopping: '正在安全停止',
  verifying: '正在核实结果',
});

/** Reason codes that explain themselves; a failure message never replaces them. */
const REASON_TEXT: Readonly<Record<TaskReasonCode, string>> = Object.freeze({
  none: '',
  user_cancelled: '你取消了任务',
  result_acceptance_required: '结果已安全保存，等你接受后才能交付',
  input_required: '需要你补充信息或确认',
  external_outcome_unknown: '上一次外部操作结果未知，需要核实',
  no_authorized_driver: '没有可用的执行器继续这项工作',
  port_in_use: '端口被占用',
  command_not_found: '启动命令不存在',
  service_start_failed: '本地服务启动失败',
  service_health_timeout: '本地服务健康检查超时',
  delivery_failed: '文件交付失败',
  execution_failed: '执行失败',
  retry_exhausted: '自动重试次数已用完',
  requirements_incomplete: '必需的工作还没全部完成',
  waiting_for_capacity: '等待执行名额',
  cleanup_in_progress: '正在安全收尾',
  system_anomaly: '系统异常',
});

/** Codes whose free-text message still helps the user understand the blocker. */
const DETAIL_CODES: ReadonlySet<TaskReasonCode> = new Set<TaskReasonCode>([
  'input_required',
  'external_outcome_unknown',
  'execution_failed',
  'delivery_failed',
  'service_start_failed',
  'service_health_timeout',
  'requirements_incomplete',
  'system_anomaly',
  'command_not_found',
  'port_in_use',
]);

/** Residue categories are runtime vocabulary; users read what they own. */
const CLEANUP_OBJECT_TEXT: Readonly<Record<string, string>> = Object.freeze({
  dispatch: '执行记录',
  publication: '文件发布',
  execution_backend: '执行环境',
  work_unit: '执行单元',
  resource_lease: '资源占用',
  generation_replan: '重新规划',
  retry_wake: '自动重试',
  kernel_application: '上一次系统操作',
  attempt_receipt: '执行回执',
  service_operation: '本地服务',
  continuation: '后续执行',
});

export function buildTaskDashboard(facts: TaskDashboardFacts): TaskDashboardModel {
  const rows = facts.tasks.map(task => toRow(task, facts));
  const needsAction = rows.filter(row => row.status === 'needs_action');
  const executing = rows.filter(row => row.status === 'running');
  const queued = rows.filter(row => row.status === 'queued');
  const finished = orderByRecency(
    rows.filter(row => isTerminalTaskStatus(row.status)),
    facts.tasks,
  ).slice(0, MAX_FINISHED_ROWS);
  return {
    capacity: {
      active: facts.capacity.active,
      limit: facts.capacity.limit,
      text: capacityText(facts.capacity),
    },
    needsAction: orderByRecency(needsAction, facts.tasks),
    executing: orderByRecency(executing, facts.tasks),
    queued: orderByRecency(queued, facts.tasks),
    finished,
    empty: rows.length === 0,
  };
}

export function formatTaskDashboard(model: TaskDashboardModel): string {
  const lines: string[] = [`执行名额 ${model.capacity.text}`];
  if (model.empty) {
    lines.push('', '当前没有任务。直接说你想做什么就行。');
    return lines.join('\n');
  }
  appendSection(lines, '需要你处理', model.needsAction);
  appendSection(lines, '执行中', model.executing);
  appendSection(lines, '排队', model.queued);
  appendSection(lines, '已结束（最近）', model.finished);
  return lines.join('\n');
}

function appendSection(lines: string[], title: string, rows: readonly TaskDashboardRow[]): void {
  if (rows.length === 0) return;
  // Markdown-safe shape: a section line, one list item per Task and a
  // two-space continuation. Deep indentation would render as a code block.
  lines.push('', `${title} ${rows.length}`);
  for (const row of rows) {
    lines.push(`- [${row.statusLabel}] ${row.title}${row.ownership ? ` · ${row.ownership}` : ''} · ${row.ageLabel}`);
    if (row.reason) lines.push(`  原因：${row.reason}`);
    if (row.detail) lines.push(`  细节：${row.detail}`);
    if (row.actions.length > 0) {
      lines.push('  可执行命令：');
      for (const action of row.actions) lines.push(`  - ${action}`);
    }
  }
}

function toRow(task: TaskDashboardTaskFact, facts: TaskDashboardFacts): TaskDashboardRow {
  const status = task.view?.status ?? task.status;
  const reason = rowReason(task, facts);
  return {
    taskId: task.taskId,
    title: task.title,
    status,
    statusLabel: TASK_STATUS_LABELS[status],
    ownership: ownershipText(task, facts.currentConversationId),
    reason: reason.reason,
    detail: reason.detail,
    actions: status === 'needs_action' ? actionsFor(task) : [],
    ageLabel: ageLabel(task, facts.now),
  };
}

function rowReason(
  task: TaskDashboardTaskFact,
  facts: TaskDashboardFacts,
): { reason: string; detail: string | null } {
  const view = task.view;
  if (!view) return { reason: '', detail: null };
  if (isTerminalTaskStatus(view.status)) {
    return { reason: REASON_TEXT[view.reasonCode], detail: null };
  }
  const parts: string[] = [];
  if (view.status === 'queued') {
    parts.push(waitingReason(task, facts));
  } else {
    if (view.phase) parts.push(PHASE_TEXT[view.phase]);
    const reasonText = REASON_TEXT[view.reasonCode];
    if (reasonText && reasonText !== '等待执行名额') parts.push(reasonText);
  }
  const cleanupText = cleanupSummary(view.cleanup);
  if (cleanupText) parts.push(cleanupText);
  return {
    reason: parts.join('；'),
    detail: DETAIL_CODES.has(view.reasonCode) ? userFacingDetail(view.reasonMessage) : null,
  };
}

/**
 * A queued Task is waiting for capacity. Saying which capacity is what makes
 * the row actionable: the account limit is shared across Workspaces.
 */
function waitingReason(task: TaskDashboardTaskFact, facts: TaskDashboardFacts): string {
  const { active, limit, foreignActive } = facts.capacity;
  if (active >= limit) {
    return foreignActive > 0
      ? `等待执行名额（账号名额已满，其中 ${foreignActive} 个被其他 Workspace 占用）`
      : '等待执行名额（账号名额已满）';
  }
  if (task.view?.reasonCode === 'waiting_for_capacity') return REASON_TEXT.waiting_for_capacity;
  return '等待执行名额（本会话有其他任务正在收尾）';
}

function cleanupSummary(cleanup: TaskDashboardViewFact['cleanup']): string {
  if (cleanup.state === 'none') return '';
  const objects = cleanup.objects
    .map(object => CLEANUP_OBJECT_TEXT[object] ?? null)
    .filter((value): value is string => Boolean(value));
  const suffix = objects.length > 0 ? `：${[...new Set(objects)].join('、')}` : '';
  return `${cleanup.state === 'blocked' ? '收尾需要核实' : '正在安全收尾'}${suffix}`;
}

function actionsFor(task: TaskDashboardTaskFact): string[] {
  const kinds = new Set(task.view?.pendingActionKinds ?? []);
  const actions: string[] = [];
  if (kinds.has('accept_result')) actions.push(`/task accept-result ${task.taskId}`);
  if (kinds.has('retry_attempt')) actions.push(`/task retry-result ${task.taskId}`);
  if (kinds.has('resolve_recovery')) actions.push(`/task recovery ${task.taskId}`);
  if (kinds.has('provide_input') || kinds.has('start_service') || actions.length === 0) {
    actions.push(`/task resume ${task.taskId}`);
  }
  actions.push(`/task cancel ${task.taskId}`);
  return [...new Set(actions)];
}

function ownershipText(
  task: TaskDashboardTaskFact,
  currentConversationId: string | null,
): string | null {
  if (!task.conversationId || task.conversationId === currentConversationId) return null;
  const title = task.conversationTitle?.trim();
  if (!title) return '其他会话';
  const bounded = title.length > 18 ? `${title.slice(0, 18)}…` : title;
  return `会话「${bounded}」`;
}

function capacityText(capacity: TaskDashboardCapacityFact): string {
  const base = `${capacity.active}/${capacity.limit} 使用中`;
  const scope = capacity.foreignActive > 0
    ? `（本 Workspace ${capacity.localActive} · 其他 Workspace ${capacity.foreignActive}）`
    : '';
  return `${base}${scope}`;
}

function orderByRecency(
  rows: readonly TaskDashboardRow[],
  tasks: readonly TaskDashboardTaskFact[],
): TaskDashboardRow[] {
  const updated = new Map(tasks.map(task => [task.taskId, Date.parse(task.updatedAt) || 0]));
  return [...rows].sort((left, right) => (
    (updated.get(right.taskId) ?? 0) - (updated.get(left.taskId) ?? 0)
  ));
}

function ageLabel(task: TaskDashboardTaskFact, now: string): string {
  const reference = isTerminal(task) ? task.updatedAt : task.createdAt;
  const elapsed = Date.parse(now) - Date.parse(reference);
  if (!Number.isFinite(elapsed) || elapsed < 0) return '刚刚';
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

function isTerminal(task: TaskDashboardTaskFact): boolean {
  return task.view ? isTerminalTaskStatus(task.view.status) : false;
}

/**
 * Executor and Runtime diagnostics carry raw identity digests and English
 * internals. A user-facing row keeps at most one bounded, identifier-free
 * sentence; the full text stays in the execution detail.
 */
/**
 * `reason.message` is producer-owned free text and today mostly carries Runtime
 * diagnostics ("dependency materialization failed: …"). Such a line is not a
 * user-facing explanation, so the row omits it and keeps the diagnostic in the
 * execution detail. A message written in Chinese is treated as intentional
 * user copy and may appear as a bounded detail.
 */
function userFacingDetail(message: string): string | null {
  // Runtime diagnostics start with an English clause even when they later quote
  // a Chinese Subtask title; intentional user copy starts in Chinese.
  if (!/^\s*[\u4e00-\u9fff]/u.test(message)) return null;
  return sanitizeDetail(message);
}

export function sanitizeDetail(message: string, limit = MAX_DETAIL_LENGTH): string | null {
  const withoutIdentifiers = message
    .replace(/[A-Za-z0-9][A-Za-z0-9_-]{23,}/gu, '…')
    .replace(/sha256:[0-9a-f]+/giu, '…');
  const normalized = withoutIdentifiers.replace(/\s+/gu, ' ').trim();
  if (!normalized) return null;
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trimEnd()}…`;
}

export function taskDashboardStatusGroups(model: TaskDashboardModel): {
  needsAction: number;
  executing: number;
  queued: number;
  finished: number;
} {
  return {
    needsAction: model.needsAction.length,
    executing: model.executing.length,
    queued: model.queued.length,
    finished: model.finished.length,
  };
}
