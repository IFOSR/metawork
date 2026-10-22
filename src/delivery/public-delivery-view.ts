import { resolve, relative, isAbsolute } from 'node:path';
import type { Task } from '../core/types.js';
import type { TaskArtifactRecord } from '../storage/task-artifact-repo.js';
import type { WorkspacePublicationRecord, WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';

export interface PublicDeliveryView {
  workspace: string;
  taskDirectory: string;
  state: 'not_published' | 'awaiting_acceptance' | 'publishing' | 'published' | 'failed';
  files: string[];
  conflicts: string[];
}

/** Public paths and delivery facts; internal worktrees are never an input. */
export function projectPublicDelivery(input: {
  task: Pick<Task, 'id' | 'publicTaskDirectory'>;
  workspace: string | null;
  pendingDecision: boolean;
  artifacts: readonly Pick<TaskArtifactRecord, 'status' | 'taskId' | 'publishedPath' | 'relativePath'>[];
  publications: readonly WorkspacePublicationRecord[];
  delivery(id: string): ReturnType<WorkspacePublicationRepo['delivery']>;
}): PublicDeliveryView | null {
  if (!input.workspace || !input.task.publicTaskDirectory) return null;
  const workspace = resolve(input.workspace);
  const taskDirectory = resolve(workspace, input.task.publicTaskDirectory);
  const rel = relative(workspace, taskDirectory);
  if (!rel || rel.split(/[\\/]/u).includes('..') || isAbsolute(rel)) return null;
  const latest = new Map<string, WorkspacePublicationRecord>();
  for (const publication of [...input.publications].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    latest.set(publication.subtaskId, publication);
  }
  const publications = [...latest.values()];
  const deliveries = publications.map(item => input.delivery(item.id)).filter(item => item !== null);
  const files = [...new Set(input.artifacts.filter(item => item.status === 'published' && item.taskId === input.task.id
    && item.publishedPath === resolve(taskDirectory, item.relativePath)).map(item => item.relativePath))].sort();
  return { workspace, taskDirectory, files,
    state: publications.some(item => ['conflicted', 'uncertain'].includes(item.status)) || deliveries.some(item => item.status === 'failed') ? 'failed'
      : publications.some(item => ['pending', 'applying'].includes(item.status)) || deliveries.some(item => item.status === 'pending') ? 'publishing'
      : input.pendingDecision ? 'awaiting_acceptance'
      : deliveries.some(item => item.status === 'succeeded') || files.length > 0 ? 'published' : 'not_published',
    conflicts: [...new Set(deliveries.flatMap(item => item.failures.map(failure => failure.sourceRelativePath)).filter(Boolean))],
  };
}

export const PUBLIC_DELIVERY_LABELS: Record<PublicDeliveryView['state'], string> = {
  not_published: '已生成内部结果，待发布', awaiting_acceptance: '等待用户接受', publishing: '正在发布到任务目录',
  published: '已发布到任务目录', failed: '发布失败',
};
export function publicDeliveryLines(view: PublicDeliveryView | null): string[] {
  return view ? [`Workspace: ${view.workspace}`, `任务目录: ${view.taskDirectory}`, `代码状态: ${PUBLIC_DELIVERY_LABELS[view.state]}`,
    `交付文件: ${view.files.join('、') || '无'}`, ...(view.conflicts.length ? [`冲突文件: ${view.conflicts.join('、')}`] : [])] : [];
}
