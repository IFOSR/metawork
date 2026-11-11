import type { NormalizedCapabilityRequest } from './types.js';

/** Manager supplies a semantic verdict; Permission Service owns its scope and application. */
export interface ManagerPermissionJudge {
  judge(request: NormalizedCapabilityRequest, options?: { signal?: AbortSignal }): Promise<ManagerPermissionVerdict>;
}

export interface ManagerPermissionVerdict {
  verdict: 'grant' | 'deny' | 'escalate';
  reason: string;
  grantedScope?: NormalizedCapabilityRequest['suggestedScope'];
}
