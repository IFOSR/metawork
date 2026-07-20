// Defines the shared executor adapter contract, inputs, progress events, and skill governance result types.
import type { ExecutorResult } from '../core/types.js';
import type { SubtaskExecutionContext } from '../execution/subtask-execution-context.js';
import type { ParsedSkillUsageEvent } from './skill-usage-event-parser.js';

export interface ExecutorSkillGovernanceTarget {
  skillName: string;
  skillVersion: string | null;
}

export interface ExecutorInput {
  context: SubtaskExecutionContext;
  onProgress?: (event: ExecutorProgressEvent) => void;
}

export interface ExecutorProgressEvent {
  kind: 'status' | 'log' | 'skill';
  text: string;
  skillEvent?: ParsedSkillUsageEvent;
}

export interface ExecutorAdapter {
  readonly name: string;
  execute(input: ExecutorInput): Promise<ExecutorResult>;
  executeResponseOnly?(input: { prompt: string; maxBytes: number }): Promise<ExecutorResult>;
  installSkill?(pkg: import('./skill-package-builder.js').ExecutorSkillPackage): Promise<ExecutorSkillInstallResult>;
  updateSkill?(pkg: import('./skill-package-builder.js').ExecutorSkillPackage): Promise<ExecutorSkillInstallResult>;
  disableSkill?(target: ExecutorSkillGovernanceTarget): Promise<ExecutorSkillInstallResult>;
  deprecateSkill?(target: ExecutorSkillGovernanceTarget): Promise<ExecutorSkillInstallResult>;
  isAvailable(): Promise<boolean>;
  abort(): void;
}

export interface ExecutorSkillInstallResult {
  ok: boolean;
  executorName: string;
  installedSkillName?: string;
  installedVersion?: string;
  message: string;
  errorCode?: string;
}
