import { resolve, relative, isAbsolute } from 'node:path';
import type { Task } from '../core/types.js';
import type { TaskArtifactRecord } from '../storage/task-artifact-repo.js';
import type { WorkspacePublicationRecord, WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';

export interface PublicDeliveryView {
  workspace: string;
  /** `null` for in-place delivery: the files stay where the Executor wrote them. */
  taskDirectory: string | null;
  mode: 'worktree' | 'in_place';
  state: 'not_published' | 'awaiting_acceptance' | 'publishing' | 'published' | 'failed';
  /** Resolved, user-facing sentence for `state` in this delivery mode. */
  stateLabel: string;
  files: string[];
  conflicts: string[];
}

export const PUBLIC_DELIVERY_LABELS: Record<PublicDeliveryView['state'], string> = {
  not_published: '已生成内部结果，待发布', awaiting_acceptance: '等待用户接受', publishing: '正在发布到任务目录',
  published: '已发布到任务目录', failed: '发布失败',
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

/** Public paths and delivery facts; internal worktrees are never an input. */
export function projectPublicDelivery(input: {
  task: Pick<Task, 'id' | 'publicTaskDirectory' | 'executionMode'>;
  workspace: string | null;
  pendingDecision: boolean;
  artifacts: readonly Pick<TaskArtifactRecord, 'status' | 'taskId' | 'publishedPath' | 'relativePath'>[];
  publications: readonly WorkspacePublicationRecord[];
  delivery(id: string): ReturnType<WorkspacePublicationRepo['delivery']>;
}): PublicDeliveryView | null {
  const mode = input.task.executionMode === 'in_place' ? 'in_place' : 'worktree';
  if (!input.workspace) return null;
  const workspace = resolve(input.workspace);
  // In-place rounds keep their files in the Workspace, so there is no task
  // directory to point at; worktree rounds still publish into one.
  let taskDirectory: string | null = null;
  if (mode === 'worktree') {
    if (!input.task.publicTaskDirectory) return null;
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
    && (mode === 'in_place'
      ? true
      : taskDirectory !== null && item.publishedPath === resolve(taskDirectory, item.relativePath)))
    .map(item => item.relativePath))].sort();
  const failed = publications.some(item => ['conflicted', 'uncertain'].includes(item.status))
    || deliveries.some(item => item.status === 'failed');
  const publishing = publications.some(item => ['pending', 'applying'].includes(item.status))
    || deliveries.some(item => item.status === 'pending');
  const state: PublicDeliveryView['state'] = failed ? 'failed'
    : publishing ? 'publishing'
    : input.pendingDecision ? 'awaiting_acceptance'
    : deliveries.some(item => item.status === 'succeeded') || files.length > 0 ? 'published' : 'not_published';
  return { workspace, taskDirectory, mode, files, state,
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
  return view.mode === 'in_place'
    ? [`Workspace: ${view.workspace}`, `工作区文件: ${stateLabel}`,
      `交付文件: ${view.files.join('、') || '无'}`,
      ...(view.conflicts.length ? [`未登记文件: ${view.conflicts.join('、')}`] : [])]
    : [`Workspace: ${view.workspace}`, `任务目录: ${view.taskDirectory}`, `代码状态: ${stateLabel}`,
      `交付文件: ${view.files.join('、') || '无'}`, ...(view.conflicts.length ? [`冲突文件: ${view.conflicts.join('、')}`] : [])];
}
