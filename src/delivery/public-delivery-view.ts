import { resolve, relative, isAbsolute } from 'node:path';
import type { Task } from '../core/types.js';
import type { TaskArtifactRecord } from '../storage/task-artifact-repo.js';
import type { WorkspacePublicationRecord, WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';

/** Where an isolated candidate round currently stands (design §9). */
export type CandidateDeliveryState =
  | 'none'
  | 'executing'
  | 'awaiting_acceptance'
  | 'conflict'
  | 'published'
  | 'cleaned';

export interface PublicDeliveryView {
  workspace: string;
  /**
   * `null` unless the Task explicitly targets an existing project directory.
   * A generated `metaclaw-tasks/<slug>` directory is no longer a delivery
   * target: Worktree publication applies only its authorized change set.
   */
  taskDirectory: string | null;
  mode: 'worktree' | 'in_place';
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
  in_place: 'In-place',
  worktree: 'Worktree',
};

const SOURCE_LABELS: Record<NonNullable<PublicDeliveryView['modeSource']>, string> = {
  explicit_user: '用户明确要求',
  planner: 'Planner 判断',
  fallback: '高级设置默认',
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

/** Public paths and delivery facts; internal worktrees are never an input. */
export function projectPublicDelivery(input: {
  task: Pick<Task, 'id' | 'publicTaskDirectory' | 'executionMode' | 'publicProject'> & {
    workspaceExecutionSource?: Task['workspaceExecutionSource'];
    workspaceDeliveryPolicy?: Task['workspaceDeliveryPolicy'];
  };
  workspace: string | null;
  pendingDecision: boolean;
  artifacts: readonly Pick<TaskArtifactRecord, 'status' | 'taskId' | 'publishedPath' | 'relativePath'>[];
  publications: readonly WorkspacePublicationRecord[];
  delivery(id: string): ReturnType<WorkspacePublicationRepo['delivery']>;
}): PublicDeliveryView | null {
  const mode = input.task.executionMode === 'in_place' ? 'in_place' : 'worktree';
  if (!input.workspace) return null;
  const workspace = resolve(input.workspace);
  // Only an explicitly selected existing project keeps a subdirectory root.
  let taskDirectory: string | null = null;
  if (input.task.publicProject && input.task.publicTaskDirectory) {
    taskDirectory = resolve(workspace, input.task.publicTaskDirectory);
    const rel = relative(workspace, taskDirectory);
    if (!rel || rel.split(/[\\/]/u).includes('..') || isAbsolute(rel)) return null;
  }
  const latest = new Map<string, WorkspacePublicationRecord>();
  for (const publication of [...input.publications].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    latest.set(publication.subtaskId, publication);
  }
  const publications = [...latest.values()];
  const deliveries = publications.map(item => input.delivery(item.id)).filter(item => item !== null);
  const files = [...new Set(input.artifacts.filter(item => item.status === 'published' && item.taskId === input.task.id
    && (taskDirectory === null || item.publishedPath === resolve(taskDirectory, item.relativePath)))
    .map(item => item.relativePath))].sort();
  const failed = publications.some(item => ['conflicted', 'uncertain'].includes(item.status))
    || deliveries.some(item => item.status === 'failed');
  const awaiting = input.task.workspaceDeliveryPolicy === 'await_acceptance'
    && publications.some(item => (
      item.status === 'integrated' && item.deliveryAuthorizedAt === null
    ));
  const publishing = publications.some(item => ['pending', 'applying'].includes(item.status))
    || deliveries.some(item => item.status === 'pending' && !awaiting);
  const state: PublicDeliveryView['state'] = failed ? 'failed'
    : publishing ? 'publishing'
    : awaiting || input.pendingDecision ? 'awaiting_acceptance'
    : deliveries.some(item => item.status === 'succeeded') || files.length > 0 ? 'published' : 'not_published';
  const candidate: CandidateDeliveryState = mode === 'in_place'
    ? 'none'
    : failed
      ? 'conflict'
      : awaiting
        ? 'awaiting_acceptance'
        : publishing
          ? 'executing'
          : state === 'published'
            ? 'published'
            : 'none';
  return {
    workspace,
    taskDirectory,
    mode,
    modeSource: input.task.workspaceExecutionSource ?? null,
    deliveryPolicy: input.task.workspaceDeliveryPolicy ?? null,
    files,
    state,
    candidate,
    stateLabel: (mode === 'in_place' ? IN_PLACE_DELIVERY_LABELS : PUBLIC_DELIVERY_LABELS)[state],
    conflicts: [...new Set(deliveries.flatMap(item => item.failures.map(failure => failure.sourceRelativePath)).filter(Boolean))],
  };
}

export function publicDeliveryStateLabel(view: PublicDeliveryView): string {
  return view.mode === 'in_place' ? IN_PLACE_DELIVERY_LABELS[view.state] : PUBLIC_DELIVERY_LABELS[view.state];
}

export function publicDeliveryLines(view: PublicDeliveryView | null): string[] {
  if (!view) return [];
  const stateLabel = publicDeliveryStateLabel(view);
  const modeLine = `执行模式: ${publicDeliveryModeLabel(view)}（${publicDeliverySourceLabel(view)}）`;
  const targetLine = view.taskDirectory
    ? `目标目录: ${view.taskDirectory}`
    : `目标 Workspace: ${view.workspace}`;
  return view.mode === 'in_place'
    ? [modeLine, targetLine, `工作区文件: ${stateLabel}`,
      `交付文件: ${view.files.join('、') || '无'}`,
      ...(view.conflicts.length ? [`未登记文件: ${view.conflicts.join('、')}`] : [])]
    : [modeLine, targetLine, `候选状态: ${stateLabel}`,
      `交付文件: ${view.files.join('、') || '无'}`,
      ...(view.conflicts.length ? [`冲突文件: ${view.conflicts.join('、')}`] : [])];
}
