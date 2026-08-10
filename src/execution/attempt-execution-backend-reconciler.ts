import type { AttemptExecutionBackend } from './attempt-execution-backend.js';
import type { AttemptExecutionPersistenceRecord, AttemptExecutionRepositoryPort } from './repositories.js';

export interface AttemptExecutionReconciliation {
  orphanContainerIds: string[];
  lostAttempts: AttemptExecutionPersistenceRecord[];
  exitedAttempts: AttemptExecutionPersistenceRecord[];
}

/** Reconciles trusted Docker labels with durable attempt records at control-plane startup. */
export class AttemptExecutionBackendReconciler {
  constructor(
    private readonly backend: AttemptExecutionBackend,
    private readonly repository: AttemptExecutionRepositoryPort,
  ) {}

  async reconcile(input: {
    checkpoint(record: AttemptExecutionPersistenceRecord): Promise<void>;
  }): Promise<AttemptExecutionReconciliation> {
    const managed = await this.backend.listManaged();
    const active = this.repository.listActive();
    const managedById = new Map(managed.map(record => [record.containerId, record]));
    const activeByContainer = new Map(active.map(record => [record.containerId, record]));
    const orphanContainerIds: string[] = [];
    const lostAttempts: AttemptExecutionPersistenceRecord[] = [];
    const exitedAttempts: AttemptExecutionPersistenceRecord[] = [];

    for (const container of managed) {
      if (activeByContainer.has(container.containerId)) continue;
      await this.backend.stop(container.containerId);
      await this.backend.remove(container.containerId);
      orphanContainerIds.push(container.containerId);
    }

    for (const record of active) {
      const container = managedById.get(record.containerId);
      if (!container) {
        this.repository.update(record.attemptId, {
          status: 'lost', cleanupStatus: 'missing', updatedAt: new Date().toISOString(),
        });
        lostAttempts.push(record);
        continue;
      }
      await input.checkpoint(record);
      if (container.status === 'exited') {
        const now = new Date().toISOString();
        this.repository.update(record.attemptId, {
          status: 'exited', exitCode: container.exitCode, resultCollectedAt: now, updatedAt: now,
        });
        exitedAttempts.push(record);
      } else {
        lostAttempts.push(record);
      }
      await this.backend.stop(container.containerId);
      await this.backend.remove(container.containerId);
      this.repository.update(record.attemptId, {
        status: 'removed', cleanupStatus: 'removed', updatedAt: new Date().toISOString(),
      });
    }
    return { orphanContainerIds, lostAttempts, exitedAttempts };
  }
}
