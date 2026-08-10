import type { Task } from '../core/types.js';
import type { WorkspaceRepositoryPort } from './repositories.js';
import type { WorkspaceStore } from './workspace-store.js';

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Schedules terminal Task workspaces and removes only metadata-expired, unreferenced data. */
export class WorkspaceRetentionService {
  constructor(
    private readonly repository: WorkspaceRepositoryPort,
    private readonly store: WorkspaceStore,
    private readonly retentionMs = DEFAULT_RETENTION_MS,
  ) {}

  reconcileTaskStatuses(tasks: readonly Pick<Task, 'id' | 'status'>[], now = new Date()): number {
    const cleanupAfter = new Date(now.getTime() + this.retentionMs).toISOString();
    let scheduled = 0;
    for (const task of tasks) {
      if (task.status !== 'archived' && task.status !== 'cancelled') continue;
      scheduled += this.repository.scheduleTaskCleanup(task.id, task.status, cleanupAfter, now.toISOString());
    }
    return scheduled;
  }

  async sweepDue(now = new Date()): Promise<{ workspaces: number; objects: number; repositories: number }> {
    let workspaces = 0;
    let objects = 0;
    let repositories = 0;
    for (const candidate of this.repository.listCleanupDue(now.toISOString())) {
      const cleanup = this.repository.deleteWorkspace(candidate.id);
      if (!cleanup) continue;
      await this.store.removeWorkspaceUri(cleanup.rootUri);
      for (const objectUri of cleanup.unreferencedObjectUris) {
        await this.store.removeObjectUri(objectUri);
        objects += 1;
      }
      for (const repositoryUri of cleanup.unreferencedManagedRepositoryUris) {
        await this.store.removeManagedRepositoryUri(repositoryUri);
        repositories += 1;
      }
      workspaces += 1;
    }
    return { workspaces, objects, repositories };
  }
}
