import {
  type Preference,
  type PreferenceScope,
  type PreferenceStatus,
} from '../core/types.js';
import type { PreferenceRepo } from '../storage/preference-repo.js';
import { generatePreferenceId } from '../utils/id.js';

export class MemoryEngine {
  constructor(private prefRepo: PreferenceRepo) {}

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

}
