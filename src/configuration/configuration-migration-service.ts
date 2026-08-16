import { createHash } from 'node:crypto';
import { dump } from 'js-yaml';
import { FileConfigurationRepository } from './file-configuration-repository.js';
import { assertSecretReference, type SecretStore } from './secret-store.js';
import {
  LegacyConfigurationReader,
  type LegacyConfigurationInventory,
  type LegacyConflict,
} from './legacy-configuration-reader.js';

export interface ConfigurationMigrationReport extends LegacyConfigurationInventory {
  candidateHash: string;
  staged: boolean;
}

export class ConfigurationMigrationService {
  constructor(
    private readonly reader: LegacyConfigurationReader,
    private readonly repository?: FileConfigurationRepository,
    private readonly secretStore?: SecretStore,
  ) {}

  async dryRun(): Promise<ConfigurationMigrationReport> {
    const inventory = await this.reader.read();
    const candidateHash = createHash('sha256')
      .update(stableJson(inventory.candidate))
      .digest('hex');
    return { ...inventory, candidateHash, staged: false };
  }

  async stageCandidate(report: ConfigurationMigrationReport): Promise<{
    revisionId: string;
    candidateHash: string;
  }> {
    if (!this.repository) throw new Error('configuration migration staging repository is required');
    const errors = report.conflicts.filter(conflict => conflict.severity === 'error');
    if (errors.length > 0) {
      throw new Error(`cannot stage legacy configuration with ${errors.length} errors`);
    }
    const revisionId = `import-${report.candidateHash.slice(0, 24)}`;
    await this.repository.initialize();
    if (this.secretStore) {
      await this.importSecrets(report.secretImportPlan);
    }
    await this.repository.writeRevision({
      revisionId,
      contentHash: report.candidateHash,
      files: {
        'config.yaml': dump(report.candidate, { noRefs: true, sortKeys: true, lineWidth: -1 }),
        'migration-report.json': `${JSON.stringify({
          sourceHashes: report.sourceHashes,
          secretImportPlan: report.secretImportPlan.map(item => ({
            reference: item.reference,
            sourcePath: item.sourcePath,
            sourceKey: item.sourceKey,
            valueSha256: item.valueSha256,
          })),
          conflicts: report.conflicts,
          dirtyRepositories: report.dirtyRepositories,
        }, null, 2)}\n`,
      },
    });
    return { revisionId, candidateHash: report.candidateHash };
  }

  private async importSecrets(
    plan: LegacyConfigurationInventory['secretImportPlan'],
  ): Promise<void> {
    if (!this.secretStore) return;
    for (const item of plan) {
      if (!item.value) continue; // external-secret 无实际值
      assertSecretReference(item.reference);
      try {
        await this.secretStore.get(item.reference);
        continue; // 已存在，幂等跳过
      } catch {
        // 不存在，写入
      }
      await this.secretStore.put(item.reference, item.value);
    }
  }
}

export function isMigrationBlockingConflict(conflict: LegacyConflict): boolean {
  return conflict.severity === 'error';
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(',')}}`;
}
