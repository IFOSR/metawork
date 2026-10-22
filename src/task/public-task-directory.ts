import { createHash } from 'node:crypto';

export function userTaskDirectorySlug(taskTitle: string, taskId: string): string {
  const title = taskTitle.normalize('NFKC').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-')
    .replace(/^-+|-+$/gu, '').slice(0, 48).replace(/-+$/gu, '');
  const shortId = createHash('sha256').update(taskId).digest('hex').slice(0, 16);
  return `${title || 'task'}-${shortId}`;
}

export function publicTaskRelativeDirectory(title: string, taskId: string): string {
  return `metaclaw-tasks/${userTaskDirectorySlug(title, taskId)}`;
}
