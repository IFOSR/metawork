import {
  type Preference,
  type PreferenceScope,
  type PreferenceStatus,
  type Observation,
} from '../core/types.js';
import type { PreferenceRepo } from '../storage/preference-repo.js';
import type { ObservationRepo } from '../storage/observation-repo.js';
import { generatePreferenceId } from '../utils/id.js';

const CONFIRM_THRESHOLD = 3;

export class MemoryEngine {
  constructor(
    private prefRepo: PreferenceRepo,
    private obsRepo: ObservationRepo,
  ) {}

  /**
   * 观察记录：从交互中提取模式
   */
  observe(pattern: string, taskId: string): {
    observation: Observation;
    shouldPromptConfirm: boolean;
  } {
    const observation = this.obsRepo.upsert(pattern, taskId);
    return {
      observation,
      shouldPromptConfirm: observation.occurrenceCount >= CONFIRM_THRESHOLD
        && !observation.promotedToPreferenceId,
    };
  }

  observeCandidate(pattern: string, taskId: string): {
    observation: Observation;
    shouldPromptConfirm: boolean;
  } {
    const observation = this.obsRepo.upsertCandidate(pattern, taskId);
    return {
      observation,
      shouldPromptConfirm: !observation.promotedToPreferenceId,
    };
  }

  /**
   * 用户确认偏好
   */
  confirm(observationId: string, scope: PreferenceScope, subject?: string): Preference {
    // 查找观察记录（通过遍历 candidates）
    const candidates = this.obsRepo.findCandidates();
    const obs = candidates.find(c => c.id === observationId);
    if (!obs) throw new Error(`观察记录不存在或未达到确认阈值: ${observationId}`);

    const now = new Date().toISOString();
    const pref: Preference = {
      id: generatePreferenceId(),
      type: this.inferType(subject),
      scope,
      subject: subject || null,
      content: obs.pattern,
      status: 'confirmed',
      confidence: 0.9,
      occurrenceCount: obs.occurrenceCount,
      sourceTasks: obs.sourceTasks,
      lastUsedAt: null,
      confirmedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.prefRepo.insert(pref);
    this.obsRepo.markPromoted(observationId, pref.id);
    return pref;
  }

  /**
   * 用户拒绝候选偏好
   */
  reject(observationId: string): void {
    // 标记为已处理（promoted_to = 'rejected'）
    this.obsRepo.markPromoted(observationId, 'rejected');
  }

  /**
   * 用户手动添加偏好（跳过三次确认）
   */
  addManual(input: {
    content: string;
    scope: PreferenceScope;
    type: string;
    subject?: string;
  }): Preference {
    const now = new Date().toISOString();
    const pref: Preference = {
      id: generatePreferenceId(),
      type: input.type,
      scope: input.scope,
      subject: input.subject || null,
      content: input.content,
      status: 'confirmed',
      confidence: 1.0,
      occurrenceCount: 1,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.prefRepo.insert(pref);
    return pref;
  }

  /**
   * 偏好 CRUD
   */
  update(prefId: string, changes: Partial<Preference>): Preference {
    this.prefRepo.update(prefId, changes);
    return this.prefRepo.findById(prefId)!;
  }

  recordUsage(prefId: string, taskId: string): Preference {
    this.prefRepo.recordUsage(prefId, taskId);
    return this.prefRepo.findById(prefId)!;
  }

  delete(prefId: string): void {
    this.prefRepo.delete(prefId);
  }

  list(filter?: { scope?: PreferenceScope; status?: PreferenceStatus }): Preference[] {
    if (filter?.scope) return this.prefRepo.findByScope(filter.scope);
    if (filter?.status) return this.prefRepo.findByStatus(filter.status);
    return this.prefRepo.findAll();
  }

  getCandidates(): Observation[] {
    return this.obsRepo.findCandidates();
  }

  /**
   * 推断偏好类型：仅按显式 subject 判定，不在代码侧猜测自然语言语义。
   */
  private inferType(subject?: string): string {
    return subject ? 'contact' : 'domain';
  }
}
