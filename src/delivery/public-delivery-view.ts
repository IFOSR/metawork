import { resolve, relative, isAbsolute } from 'node:path';
import type { Task } from '../core/types.js';
import type { TaskArtifactRecord } from '../storage/task-artifact-repo.js';
import type { WorkspacePublicationRecord, WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';

/** Where an isolated candidate round currently stands (design §9). */
export type CandidateDeliveryState = 'none';

export interface PublicDeliveryView {
  workspace: string;
  /** `null` unless the user explicitly selected an existing Workspace subdirectory. */
  taskDirectory: string | null;
  mode: 'in_place';
  /** Which admission fact authorized the mode. */
  modeSource: 'explicit_user' | 'planner' | 'fallback' | 'kernel_safety' | null;
  deliveryPolicy: 'none' | 'auto_publish' | 'await_acceptance' | null;
  state: 'not_published' | 'awaiting_acceptance' | 'publishing' | 'published' | 'failed';
  /** Resolved, user-facing sentence for `state` in this delivery mode. */
  stateLabel: string;
  files: string[];
  conflicts: string[];
  candidate: CandidateDeliveryState;
}

export const PUBLIC_DELIVERY_LABELS: Record<PublicDeliveryView['state'], string> = {
  not_published: '已生成内部候选，尚未发布', awaiting_acceptance: '等待用户接受',
  publishing: '正在发布到工作区', published: '已发布到工作区', failed: '发布失败',
};

/**
 * In-place rounds never publish into a task directory, so reporting "待发布"
 * would read as unfinished work. These labels state what actually happened to
 * the files in the user's Workspace.
 */
export const IN_PLACE_DELIVERY_LABELS: Record<PublicDeliveryView['state'], string> = {
  not_published: '本轮没有文件变更', awaiting_acceptance: '等待用户接受',
  publishing: '正在登记本轮文件', published: '已在工作区就地更新', failed: '文件登记失败',
};

const MODE_LABELS: Record<PublicDeliveryView['mode'], string> = {
  in_place: '目标 Workspace 就地执行',
};

const SOURCE_LABELS: Record<NonNullable<PublicDeliveryView['modeSource']>, string> = {
  explicit_user: '用户明确要求',
  planner: 'Planner 判断',
  fallback: '系统默认规则',
  kernel_safety: 'Kernel 安全规则',
};

export function publicDeliveryModeLabel(view: Pick<PublicDeliveryView, 'mode'>): string {
  return MODE_LABELS[view.mode];
}

export function publicDeliverySourceLabel(
  view: Pick<PublicDeliveryView, 'modeSource'>,
): string {
  return view.modeSource ? SOURCE_LABELS[view.modeSource] : '未知来源';
}

/** Public paths and delivery facts for the single Workspace model. */
export function projectPublicDelivery(input: {
  task: Pick<Task, 'id' | 'publicTaskDirectory' | 'executionMode' | 'publicProject'> & {
    workspaceExecutionSource?: Task['workspaceExecutionSource'];
    workspaceDeliveryPolicy?: Task['workspaceDeliveryPolicy'];
  };
  workspace: string | null;
  artifacts: readonly Pick<TaskArtifactRecord, 'status' | 'taskId' | 'publishedPath' | 'relativePath'>[];
  publications: readonly WorkspacePublicationRecord[];
  delivery(id: string): ReturnType<WorkspacePublicationRepo['delivery']>;
}): PublicDeliveryView | null {
  // Public projections expose the single current Workspace model and never
  // present a candidate lifecycle.
  const mode = 'in_place' as const;
  if (!input.workspace) return null;
  const workspace = resolve(input.workspace);
  // Only an explicitly selected existing project keeps a subdirectory root.
  let taskDirectory: string | null = null;
  if (input.task.publicProject && input.task.publicTaskDirectory) {
    taskDirectory = resolve(workspace, input.task.publicTaskDirectory);
    const rel = relative(workspace, taskDirectory);
    if (!rel || rel.split(/[\\/]/u).includes('..') || isAbsolute(rel)) return null;
  }
  // Publication rows belong to the retired Worktree lifecycle. They remain
  // queryable for migration/audit, but never affect the current In-place view.
  const publications: WorkspacePublicationRecord[] = [];
  const deliveries: NonNullable<ReturnType<WorkspacePublicationRepo['delivery']>>[] = [];
  const files = [...new Set(input.artifacts.filter(item => item.status === 'published' && item.taskId === input.task.id
    && (taskDirectory === null || item.publishedPath === resolve(taskDirectory, item.relativePath)))
    .map(item => item.relativePath))].sort();
  const failed = false;
  // The Workspace file state reports file facts only. A pending result decision
  // is a Task-level action (accept/retry the Executor result), not a delivery
  // state: In-place files are already in the user's Workspace, so presenting
  // them as "awaiting acceptance" would invent a publication gate that does not
  // exist (2026-10-27 realignment §6).
  const publishing = publications.some(item => ['pending', 'applying'].includes(item.status))
    || deliveries.some(item => item.status === 'pending');
  const state: PublicDeliveryView['state'] = failed ? 'failed'
    : publishing ? 'publishing'
    : deliveries.some(item => item.status === 'succeeded') || files.length > 0 ? 'published' : 'not_published';
  const candidate: CandidateDeliveryState = 'none';
  return {
    workspace,
    taskDirectory,
    mode,
    modeSource: input.task.workspaceExecutionSource ?? null,
    deliveryPolicy: input.task.workspaceDeliveryPolicy ?? null,
    files,
    state,
    candidate,
    stateLabel: IN_PLACE_DELIVERY_LABELS[state],
    conflicts: [...new Set(deliveries.flatMap(item => item.failures.map(failure => failure.sourceRelativePath)).filter(Boolean))],
  };
}

export function publicDeliveryStateLabel(view: PublicDeliveryView): string {
  return IN_PLACE_DELIVERY_LABELS[view.state];
}

export function publicDeliveryLines(view: PublicDeliveryView | null): string[] {
  if (!view) return [];
  const stateLabel = publicDeliveryStateLabel(view);
  const modeLine = `执行方式: ${publicDeliveryModeLabel(view)}（${publicDeliverySourceLabel(view)}）`;
  const targetLine = view.taskDirectory
    ? `目标目录: ${view.taskDirectory}`
    : `目标 Workspace: ${view.workspace}`;
  return [modeLine, targetLine, `工作区文件: ${stateLabel}`,
    `交付文件: ${view.files.join('、') || '无'}`,
    ...(view.conflicts.length ? [`未登记文件: ${view.conflicts.join('、')}`] : [])];
}
