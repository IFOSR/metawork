import type { AttemptSandboxPort } from './attempt-sandbox.js';
import type { AttemptSandboxPersistenceRecord, AttemptSandboxRepositoryPort } from './repositories.js';

export interface AttemptSandboxReconciliation {
  orphanContainerIds: string[];
  lostAttempts: AttemptSandboxPersistenceRecord[];
  exitedAttempts: AttemptSandboxPersistenceRecord[];
}

/** Reconciles trusted Docker labels with durable attempt records at control-plane startup. */
export class AttemptSandboxReconciler {
  constructor(
    private readonly sandbox: AttemptSandboxPort,
    private readonly repository: AttemptSandboxRepositoryPort,
  ) {}

  async reconcile(input: {
    checkpoint(record: AttemptSandboxPersistenceRecord): Promise<void>;
  }): Promise<AttemptSandboxReconciliation> {
    const managed = await this.sandbox.listManaged();
    const active = this.repository.listActive();
    const managedById = new Map(managed.map(record => [record.containerId, record]));
    const activeByContainer = new Map(active.map(record => [record.containerId, record]));
    const orphanContainerIds: string[] = [];
    const lostAttempts: AttemptSandboxPersistenceRecord[] = [];
    const exitedAttempts: AttemptSandboxPersistenceRecord[] = [];

    for (const container of managed) {
      if (activeByContainer.has(container.containerId)) continue;
      await this.sandbox.stop(container.containerId);
      await this.sandbox.remove(container.containerId);
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
      await this.sandbox.stop(container.containerId);
      await this.sandbox.remove(container.containerId);
      this.repository.update(record.attemptId, {
        status: 'removed', cleanupStatus: 'removed', updatedAt: new Date().toISOString(),
      });
    }
    return { orphanContainerIds, lostAttempts, exitedAttempts };
  }
}
