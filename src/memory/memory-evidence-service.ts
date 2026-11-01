/**
 * Memory evidence delivery (design §10).
 *
 * Long-term memory reaches an Executor through exactly one channel: the
 * `task_execution_evidence` table. The flow is:
 *
 *   Planner references a memory
 *     -> Runtime re-validates it (account ownership, enabled state)
 *     -> the body is fetched on the host side
 *     -> it is materialized as evidence(kind='long_term_memory')
 *     -> the Executor receives it in `selectedEvidence`
 *
 * The body is never spliced into the prompt. That would create a second,
 * unaudited and unbudgeted context path and break ADR-0038 and ADR-0021.
 *
 * A memory that cannot be materialized is an explicit failure. Empty content is
 * never passed off as evidence.
 */

import type { MemoryService } from './memory-service.js';
import type { MemoryRecallRepo } from '../storage/memory-recall-repo.js';
import type { ContextRef } from '../work-graph/types.js';
import {
  createEvidenceId,
  type TaskExecutionEvidenceRepo,
} from '../execution/execution-evidence-port.js';

export interface MemoryEvidenceOptions {
  /**
   * Resolves the current memory service. A getter (rather than an instance)
   * keeps evidence delivery bound to the live runtime across configuration
   * activations, which rebuild the memory runtime (review P1-1).
   */
  resolveService: () => MemoryService | null;
  evidenceRepo: TaskExecutionEvidenceRepo;
  recallRepo?: Pick<MemoryRecallRepo, 'hasCandidate'>;
  /**
   * Storage cap for one memory body in the evidence catalog. The prompt budget
   * (4k per item, 24k per task) is applied later, when the execution context
   * is built, so that the Executor can still page the rest with the evidence
   * tool.
   */
  maxStoredChars: number;
  logger?: (message: string) => void;
}

export interface MemoryEvidenceResult {
  materialized: string[];
  /** Memory ids that could not be materialized, with the reason. */
  failed: Array<{ memoryId: string; reason: string }>;
}

export class MemoryEvidenceMaterializationError extends Error {
  constructor(readonly code: string, readonly memoryId: string) {
    super(`${code}: ${memoryId}`);
    this.name = 'MemoryEvidenceMaterializationError';
  }
}

/**
 * The narrow seam execution depends on. The Server injects a proxy that resolves
 * the live runtime, so a configuration activation that rebuilds the memory
 * runtime does not leave a stale evidence service behind (review P1-1).
 */
export interface MemoryEvidencePort {
  materialize(input: {
    accountId: string;
    taskId: string;
    conversationId?: string;
    memoryIds: readonly ({ memoryId: string; revision?: string } | string)[];
  }): Promise<MemoryEvidenceResult>;
}

export class MemoryEvidenceService implements MemoryEvidencePort {
  private readonly logger: (message: string) => void;

  constructor(private readonly options: MemoryEvidenceOptions) {
    this.logger = options.logger ?? (() => undefined);
  }

  /** Collect the memory references of one authorized work graph. */
  static collectMemoryRefs(refs: readonly ContextRef[]): Array<{ memoryId: string; revision?: string }> {
    const seen = new Set<string>();
    const memoryIds: Array<{ memoryId: string; revision?: string }> = [];
    for (const ref of refs) {
      if (ref.kind !== 'memory') continue;
      const key = `${ref.memoryId}:${ref.revision ?? 'legacy'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      memoryIds.push({ memoryId: ref.memoryId, ...(ref.revision ? { revision: ref.revision } : {}) });
    }
    return memoryIds;
  }

  /**
   * Materialize every referenced memory into the task evidence catalog.
   * Failures are reported, never silently skipped.
   */
  async materialize(input: {
    accountId: string;
    taskId: string;
    conversationId?: string;
    memoryIds: readonly ({ memoryId: string; revision?: string } | string)[];
  }): Promise<MemoryEvidenceResult> {
    const service = this.options.resolveService();
    if (!service) {
      // Memory is off or degraded. Report it per reference instead of silently
      // dropping the requirement.
      return {
        materialized: [],
        failed: input.memoryIds.map(ref => ({
          memoryId: typeof ref === 'string' ? ref : ref.memoryId,
          reason: 'memory_unavailable',
        })),
      };
    }
    const materialized: string[] = [];
    const failed: Array<{ memoryId: string; reason: string }> = [];
    for (const value of input.memoryIds) {
      const ref = typeof value === 'string' ? { memoryId: value } : value;
      const memoryId = ref.memoryId;
      const evidenceId = createEvidenceId('long_term_memory', ref.revision ? `${memoryId}:${ref.revision}` : memoryId);
      try {
        if (ref.revision && (!input.conversationId || !this.options.recallRepo?.hasCandidate({
          accountId: input.accountId,
          conversationId: input.conversationId,
          memoryId,
          revision: ref.revision,
        }))) {
          failed.push({ memoryId, reason: `memory_not_in_recall_snapshot: ${memoryId}` });
          continue;
        }
        // The binding is re-validated on every delivery: an asset the user
        // disabled after the plan was authorized must not reach an Executor.
        const binding = service.bindingFor({
          accountId: input.accountId,
          memoryId,
        });
        if (!binding) {
          failed.push({ memoryId, reason: `memory_not_authorized: ${memoryId}` });
          continue;
        }
        const asset = await service.materialize({
          accountId: input.accountId,
          memoryId,
          revision: ref.revision,
        });
        const existing = this.options.evidenceRepo.findForTask(input.taskId, evidenceId);
        if (existing && existing.kind === 'long_term_memory') {
          // The row pins the version originally delivered, but every Attempt
          // still re-reads the engine so a changed/deleted asset cannot pass a
          // stale authorization check merely because its evidence row exists.
          materialized.push(evidenceId);
          continue;
        }
        const content = asset.content.slice(0, this.options.maxStoredChars);
        this.options.evidenceRepo.upsert({
          id: evidenceId,
          taskId: input.taskId,
          kind: 'long_term_memory',
          sourceId: `${binding.layer}:${binding.tdaiMemoryId}`,
          title: `${asset.layer ?? binding.layer}: ${asset.title ?? binding.tdaiTitle ?? memoryId}`,
          content,
          exactOnly: false,
          createdAt: asset.createdAt || new Date().toISOString(),
        });
        materialized.push(evidenceId);
      } catch (error) {
        const reason = (error as Error).message;
        failed.push({ memoryId, reason });
        this.logger(`memory evidence unavailable for ${memoryId}: ${reason}`);
      }
    }
    return { materialized, failed };
  }
}
