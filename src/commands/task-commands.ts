import { publicText } from '../utils/public-text.js';
import type { TaskView } from '../task/task-view.js';
import { publicDeliveryLines } from '../delivery/public-delivery-view.js';
import { TASK_STATUS_LABELS, isTerminalTaskStatus } from '../task/task-state.js';
import { WorkGraphRevisionRepo } from '../storage/work-graph-revision-repo.js';
import {
  optionalStringArg,
  optionArg,
  stringArg,
  stringListArg,
  type CommandContext,
  type CommandResult,
  type ResolvedCommandArgs,
} from './catalog.js';
import { MANAGEABLE_TASK_STATUSES, type TaskClearScope } from '../task/task-control-types.js';
import { buildMaterialSummary, extractMaterialTextSnippets, isWebLink, splitTaskResources } from '../intent/material-utils.js';
import type { Task, TaskStatus } from '../core/types.js';
import { TaskSearchIndexRepo } from '../storage/task-search-index-repo.js';
import {
  formatBlockedTaskRecoveryAction,
  formatBlockedTaskNextStep,
  formatBlockedTaskReason,
  isUnknownTaskBlocker,
} from '../task/task-blocker-guidance.js';

/**
 * Both legacy scope names select `needs_action`: `parked` and `blocked` are one
 * user-facing state now. The scope names stay for command compatibility.
 */
const CLEAR_SCOPE_STATUSES: Record<TaskClearScope, TaskStatus[]> = {
  all: MANAGEABLE_TASK_STATUSES,
  parked: ['needs_action'],
  blocked: ['needs_action'],
};

const CLEAR_SCOPE_LABELS: Record<TaskClearScope, string> = {
  all: '所有未完成任务',
  parked: '待处理任务',
  blocked: '待处理任务',
};

function parseClearScope(value: string | undefined): TaskClearScope | null {
  if (!value || value === 'all') {
    return 'all';
  }

  if (value === 'parked') {
    return 'parked';
  }

  if (value === 'blocked') {
    return 'blocked';
  }

  return null;
}

export async function cancelTasksByScope(
  context: CommandContext,
  scope: TaskClearScope,
  reason = `用户清空${CLEAR_SCOPE_LABELS[scope]}`,
): Promise<{ cancelled: Task[]; runningCancelled: boolean }> {
  const repo = context.taskEngine.getTaskRepo();
  const statuses = CLEAR_SCOPE_STATUSES[scope];
  const candidates = repo.findAll()
    .filter(task => statuses.includes(task.status));
  const runningCancelled = candidates.some(task => task.status === 'running');

  for (const task of candidates) {
    await context.taskControl.cancelTask(task.id, reason);
  }

  return { cancelled: candidates, runningCancelled };
}

export function formatTaskClearResult(scope: TaskClearScope, cancelled: Task[], runningCancelled = false): string {
  const lines = [
    `已清空${CLEAR_SCOPE_LABELS[scope]}：取消 ${cancelled.length} 个任务`,
  ];

  if (cancelled.length === 0) {
    lines.push('→ 没有匹配的可清空任务');
    return lines.join('\n');
  }

  if (runningCancelled) {
    lines.push('→ 已中止当前执行器，避免被取消任务继续输出');
  }

  lines.push(
    ...cancelled.map(task => `  - #${task.id} [${TASK_STATUS_LABELS[task.status]}] ${task.title}`),
  );
  lines.push('→ 相关会话任务槽、调度队列与执行派发已同步释放；新任务可立即执行');
  return lines.join('\n');
}

function formatTaskLine(task: Task, view: TaskView | null): string {
  const label = view?.statusLabel ?? TASK_STATUS_LABELS[task.status];
  const reason = view?.state.reason.message
    || task.stateDetail.reason.message
    || '暂无补充说明';
  return publicText(`  #${task.id} [${label}] ${task.title}\n    → ${reason}`);
}

function buildLatestNextStep(task: {
  id: string;
  status: string;
  snapshots: Array<{ nextStep: string }>;
  dependencies: Array<{ status: string; description: string }>;
}): string {
  const latestSnapshot = task.snapshots[task.snapshots.length - 1];
  if (latestSnapshot?.nextStep) {
    return latestSnapshot.nextStep;
  }

  if (task.status === 'needs_action') {
    const blocker = task.dependencies.find(dep => dep.status === 'waiting')?.description;
    return blocker ? formatBlockedTaskNextStep(task.id, blocker) : '先确认需要处理的条件';
  }

  if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
    return '如需延续，可直接输入新的要求创建 follow-up 任务';
  }

  return '继续推进当前任务';
}

function buildRecoveryAction(task: {
  id: string;
  status: string;
  resources?: string[];
  materialSummary?: { status: 'missing' | 'partial' | 'ready'; sufficiency: string };
  blockerReason?: string;
}): string {
  if (task.status === 'needs_action') {
    if (task.blockerReason && isUnknownTaskBlocker(task.blockerReason)) {
      return formatBlockedTaskRecoveryAction(task.id, task.blockerReason);
    }
    const hasLinks = (task.resources ?? []).some(resource => isWebLink(resource));
    if (task.materialSummary?.status === 'ready') {
      return `现有材料已具备可读内容，可直接执行 /task resume ${task.id}；如仍不够，再补充材料：/task resume ${task.id} [材料路径]`;
    }
    if (hasLinks) {
      return `若现有链接信息已足够，直接执行 /task resume ${task.id}；如需补材料：/task resume ${task.id} [材料路径]`;
    }
    return `/task resume ${task.id} [材料路径]`;
  }

  if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'succeeded') {
    return '直接输入 follow-up 指令，基于当前结果继续';
  }

  return '无';
}

export async function listTasks(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const scope = optionalStringArg(args, 'scope');
  const legacyStatus = scope === 'active' ? 'active'
    : scope === 'ready' || scope === 'parked' || scope === 'blocked' || scope === 'done' ? scope
      : undefined;
  // Scope names map onto the six states directly. Legacy names stay accepted so
  // an old client cannot silently show an empty list.
  const filter: TaskStatus | 'active' | 'finished' | undefined =
    scope === 'needs-action' || scope === 'blocked' || scope === 'parked' ? 'needs_action'
      : scope === 'executing' || scope === 'running' ? 'running'
        : scope === 'waiting' || scope === 'ready' || scope === 'queued' ? 'queued'
          : scope === 'active' ? 'active'
            : scope === 'finished' || scope === 'done' || scope === 'succeeded' ? 'finished'
              : undefined;
  const repo = context.taskEngine.getTaskRepo();
  const tasks = repo.findAll();
  const views = new Map(tasks.map(task => [task.id, context.taskControl?.taskView?.(task.id) ?? null]));
  const matches = (task: Task): boolean => {
    if (filter === 'active') return !isTerminalTaskStatus(task.status);
    if (filter === 'finished') return isTerminalTaskStatus(task.status);
    if (filter) return task.status === filter;
    return true;
  };
  const visibleTasks = tasks.filter(matches);

  if (visibleTasks.length === 0) {
    return { type: 'text', content: '暂无任务' };
  }

  if (filter) {
    const lines = visibleTasks.map(task => formatTaskLine(task, views.get(task.id) ?? null));
    return { type: 'text', content: `任务列表：\n${lines.join('\n')}` };
  }

  const groups = ([
    'running', 'queued', 'needs_action', 'succeeded', 'failed', 'cancelled',
  ] as const).map(status => ({
    title: TASK_STATUS_LABELS[status],
    tasks: visibleTasks.filter(task => task.status === status),
  })).filter(group => group.tasks.length > 0);

  const lines = ['任务清单：', ''];
  for (const group of groups) {
    lines.push(group.title);
    group.tasks.forEach(task => lines.push(formatTaskLine(task, views.get(task.id) ?? null)));
    lines.push('');
  }

  return { type: 'text', content: publicText(lines.join('\n')).trimEnd() };
}

export async function clearTasks(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const scope = parseClearScope(optionalStringArg(args, 'scope'));
  if (!scope) {
    return { type: 'text', content: '用法: /task clear [all|parked|blocked]' };
  }

  const result = await cancelTasksByScope(context, scope);
  return {
    type: 'text',
    content: formatTaskClearResult(scope, result.cancelled, result.runningCancelled),
  };
}

export async function showTask(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  const task = context.taskEngine.getTaskRepo().findById(taskId);
  if (!task || (context.conversationId && task.conversationId !== context.conversationId)) {
    return { type: 'text', content: `当前会话中没有该任务: ${taskId}` };
  }
  const taskView = context.taskControl?.taskView?.(taskId) ?? null;
  const delivery = await context.taskControl?.publicTaskDelivery?.(taskId) ?? null;

  const latestInteraction = context.db.prepare(
    'SELECT executor_used, system_output, created_at FROM interactions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(taskId) as { executor_used: string | null; system_output: string | null; created_at: string } | undefined;
  const latestSnapshot = task.snapshots[task.snapshots.length - 1] ?? null;
  const blocker = task.dependencies.find(dep => dep.status === 'waiting')?.description || '无';
  const latestResult = task.summary || latestInteraction?.system_output || '无';
  const latestNextStep = buildLatestNextStep(task);
  const lastProgress = latestSnapshot?.done.join('；') || task.summary || '无';
  const materialGroups = splitTaskResources(task.resources);
  const materialSnippets = await extractMaterialTextSnippets(task.resources);
  const materialSummary = buildMaterialSummary(task.resources, materialSnippets);
  const recoveryAction = buildRecoveryAction({
    ...task,
    materialSummary,
    blockerReason: blocker,
  });

  const lines = [
    `任务视图 #${task.id}`,
    `标题: ${task.title}`,
    `目标: ${task.goal}`,
    '',
    `当前状态: ${TASK_STATUS_LABELS[taskView?.status ?? task.status]}（版本 ${taskView?.state.stateVersion ?? task.stateVersion}）`,
    `状态说明: ${taskView?.explanation || task.stateDetail.reason.message || '暂无补充说明'}`,
    ...publicDeliveryLines(delivery),
    ...(taskView?.pendingActions.some(action => action.kind === 'accept_result'
      && (action.publicationId || action.actionId.startsWith('accept_partial:')))
      ? [`接受候选并发布: /task accept-partial ${taskId}`] : []),
    ...(taskView?.pendingActions.some(action => action.kind === 'accept_result' && !action.publicationId)
      ? [`接受并交付: /task accept-result ${taskId}`] : []),
    ...(taskView?.pendingActions.some(action => action.kind === 'retry_attempt')
      ? [`重新执行: /task retry-result ${taskId}`] : []),
    `上次做到: ${lastProgress}`,
    `最新结果摘要: ${latestResult}`,
    `最新下一步: ${latestNextStep}`,
    `待处理原因: ${blocker}`,
    `材料概览: ${materialSummary.overview}`,
    `材料状态: ${materialSummary.sufficiency}`,
    `关联材料: ${task.resources.join(', ') || '无'}`,
    `本地文件材料: ${materialGroups.files.join(', ') || '无'}`,
    `网页链接材料: ${materialGroups.links.join(', ') || '无'}`,
    `任务产物: ${task.artifacts.join(', ') || '无'}`,
    `恢复操作: ${recoveryAction}`,
    '',
    `最近执行器: ${latestInteraction?.executor_used || '无'}`,
    `最近调度原因: ${task.lastSchedulingReason || '无'}`,
    `最近中断原因: ${task.lastInterruptionReason || '无'}`,
    `最新快照时间: ${latestSnapshot ? latestSnapshot.createdAt : '无'}`,
    `创建时间: ${task.createdAt}`,
    `更新时间: ${task.updatedAt}`,
  ];
  return { type: 'text', content: publicText(lines.join('\n')) };
}

export async function pauseTask(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  const task = context.taskEngine.getTaskRepo().findById(taskId);
  if (!task) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  try {
    const wasRunning = task.status === 'running';
    if (!context.taskControl?.blockTask) {
      return { type: 'text', content: '操作失败: 当前环境不支持安全暂停' };
    }
    await context.taskControl.blockTask(taskId, '用户手动暂停');
    if (wasRunning) context.activeExecutions?.abortTask(taskId);
    return { type: 'text', content: `任务 #${taskId} 已暂停（待处理）` };
  } catch (error) {
    return { type: 'text', content: `操作失败: ${(error as Error).message}` };
  }
}

export async function resumeTask(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  const task = context.taskEngine.getTaskRepo().findById(taskId);
  if (!task) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  const revision = new WorkGraphRevisionRepo(context.db).findActive(taskId);
  const expectedGenerationId = optionArg(args, '--generation') ?? revision?.generationId;
  const revisionOption = optionArg(args, '--revision');
  const expectedGraphRevision = revisionOption === undefined ? revision?.revision : Number(revisionOption);
  if (expectedGraphRevision !== undefined && (!Number.isSafeInteger(expectedGraphRevision) || expectedGraphRevision < 1)) {
    return { type: 'text', content: '任务图版本无效，请刷新任务后重试。' };
  }
  const newlyProvidedResources = Array.from(new Set(stringListArg(args, 'resources').filter(Boolean)));
  return {
    type: 'directive',
    content: newlyProvidedResources.length > 0
      ? `任务 #${taskId} 已提交恢复请求，并附带 ${newlyProvidedResources.length} 份材料`
      : `任务 #${taskId} 已提交恢复请求`,
    directive: {
      kind: 'resume-task',
      taskId,
      expectedGenerationId,
      expectedGraphRevision,
      mode: task.status === 'needs_action' ? 'resume-blocked' : 'resume-parked',
      newlyProvidedResources,
    },
  };
}

export async function blockTask(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  const task = context.taskEngine.getTaskRepo().findById(taskId);
  if (!task) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  try {
    const wasRunning = task.status === 'running';
    const reason = stringArg(args, 'reason') || '未指定原因';
    if (!context.taskControl?.blockTask) {
      return { type: 'text', content: '操作失败: 当前环境不支持安全标记' };
    }
    await context.taskControl.blockTask(taskId, reason);
    if (wasRunning) context.activeExecutions?.abortTask(taskId);
    return { type: 'text', content: `任务 #${taskId} 已标记为待处理: ${reason}` };
  } catch (error) {
    return { type: 'text', content: `操作失败: ${(error as Error).message}` };
  }
}

export async function unblockTask(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  const task = context.taskEngine.getTaskRepo().findById(taskId);
  if (!task) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  const newlyProvidedResources = Array.from(new Set(stringListArg(args, 'resources').filter(Boolean)));
  const blockedReason = task.dependencies
    .filter(dependency => dependency.status === 'waiting')
    .map(dependency => dependency.description)
    .filter(Boolean)
    .join('；');

  return {
    type: 'directive',
    content: newlyProvidedResources.length > 0
      ? `任务 #${taskId} 已提交恢复请求，并附带资源 ${newlyProvidedResources.join(', ')}`
      : `任务 #${taskId} 已提交恢复请求`,
    directive: {
      kind: 'resume-task',
      taskId,
      mode: 'resume-blocked',
      newlyProvidedResources,
      blockedReason,
    },
  };
}

export async function cancelTask(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  if (!context.taskEngine.getTaskRepo().findById(taskId)) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  try {
    const receipt = await context.taskControl.cancelTask(taskId);
    return {
      type: 'text',
      content: `任务 #${taskId} 已取消：影响 ${receipt.affectedSubtaskIds.length} 个 Subtask，${receipt.cleanupAttemptIds.length} 个 attempt 正在清理`,
    };
  } catch (error) {
    return { type: 'text', content: `操作失败: ${(error as Error).message}` };
  }
}

export async function completeTask(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  if (!context.taskEngine.getTaskRepo().findById(taskId)) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  return {
    type: 'text',
    content: `任务 #${taskId} 不能手工绕过完成门；完整结果会在运行残留清零后自动完成，部分结果请使用 /task accept-partial ${taskId}`,
  };
}

export async function cancelSubtasks(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  if (!context.taskEngine.getTaskRepo().findById(taskId)) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  const subtaskIds = stringListArg(args, 'subtaskIds');
  if (subtaskIds.length === 0) {
    return { type: 'text', content: `用法: /task subtask-cancel ${taskId} <subtaskId...>` };
  }

  try {
    const receipt = await context.taskControl.cancelSubtasks(taskId, subtaskIds);
    return {
      type: 'text',
      content: `任务 #${taskId} 已提交原子 Subtask 取消：影响 ${receipt.affectedSubtaskIds.length} 个节点，${receipt.cleanupAttemptIds.length} 个 attempt 正在清理`,
    };
  } catch (error) {
    return { type: 'text', content: `操作失败: ${(error as Error).message}` };
  }
}

export async function acceptPartialResult(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  if (!context.taskEngine.getTaskRepo().findById(taskId)) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  try {
    const view = context.taskControl.taskView?.(taskId);
    const acceptsCandidate = view?.pendingActions.some(action => action.publicationId) ?? false;
    const receipt = await context.taskControl.acceptPartialResult(taskId);
    return {
      type: 'text',
      content: acceptsCandidate
        ? `任务 #${taskId} 已接受候选变更，正在发布到目标 Workspace。`
        : `任务 #${taskId} 已显式接受部分结果；取消节点 ${receipt.affectedSubtaskIds.length} 个`,
    };
  } catch (error) {
    return { type: 'text', content: `操作失败: ${(error as Error).message}` };
  }
}

export async function acceptResult(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  return decideResult(args, context, false);
}

export async function retryRemainingWork(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  try {
    if (!context.taskControl.retryRemainingWork) throw new Error('当前 Runtime 不支持剩余工作重试');
    const result = await context.taskControl.retryRemainingWork(stringArg(args, 'taskId'));
    return { type: 'text', content: `已创建关联重试任务 #${result.taskId}，原任务结论与成果保留。` };
  } catch (error) {
    return { type: 'text', content: `操作失败: ${(error as Error).message}` };
  }
}

export async function retryResult(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  return decideResult(args, context, true);
}

async function decideResult(args: ResolvedCommandArgs, context: CommandContext, retry: boolean): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  const expected = context.taskControl.pendingTaskResult?.(taskId);
  if (!expected) return { type: 'text', content: '没有待处理的安全结果，请刷新任务状态。' };
  try {
    if (retry) {
      if (!context.taskControl.retryTaskResult) throw new Error('task_control_unavailable');
      await context.taskControl.retryTaskResult(taskId, expected);
    } else await context.taskControl.acceptPartialResult(taskId, expected);
    return { type: 'text', content: retry ? '已请求重新执行，历史结果保留。' : '已接受当前结果，正在执行发布与交付检查。' };
  } catch (error) {
    return { type: 'text', content: `操作失败: ${(error as Error).message}` };
  }
}

export async function rebuildTaskIndex(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const count = new TaskSearchIndexRepo(context.db).rebuild();
  return { type: 'text', content: `任务检索索引已重建：${count} 条索引记录` };
}

export async function searchTaskIndex(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const query = stringArg(args, 'query').trim();
  if (!query) {
    return { type: 'text', content: '用法: /task index search <query>' };
  }

  const results = new TaskSearchIndexRepo(context.db).search(query, 10);
  if (results.length === 0) {
    return { type: 'text', content: '任务检索索引没有命中结果' };
  }

  return {
    type: 'text',
    content: [
      `任务检索索引命中 ${results.length} 条：`,
      ...results.map(result => {
        const snippet = result.snippet.replace(/\s+/g, ' ').trim();
        return `  - #${result.taskId} [${result.sourceKind}] ${result.title || result.sourceId}: ${snippet}`;
      }),
    ].join('\n'),
  };
}
