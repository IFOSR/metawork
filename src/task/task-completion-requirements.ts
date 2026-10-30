/**
 * Completion requirement compilation (2026-10-22 Task state simplification §3.4).
 *
 * The requirement list says which work the authorized graph must finish before
 * the Task can be `succeeded`. It is persisted with the Work Graph revision so a
 * re-plan produces a new snapshot and the old requirements stay auditable. It is
 * **not** an operation state table: each requirement is satisfied by durable
 * evidence (a certified/accepted result, a delivery checkpoint, a service
 * handover), never by a Subtask label alone.
 */

import type { CompletionRequirementSpec } from './task-state-facts.js';

export interface CompletionRequirementSubtask {
  readonly id: string;
  readonly title: string;
  readonly deliveryKind?: 'edit' | 'report';
  readonly fileOutputs?: readonly string[];
}

/**
 * Compiles the requirement list. Current graph nodes are all required work; this
 * round deliberately does not extend the protocol with optional branches.
 */
export function compileCompletionRequirements(input: {
  readonly subtasks: readonly CompletionRequirementSubtask[];
  /** A published public project needs durable file delivery per subtask. */
  readonly publicProject: boolean;
  readonly conversationGit?: boolean;
  /** The user explicitly asked to start a local service after publish. */
  readonly startServiceAfterPublish: boolean;
  readonly serviceId?: string | null;
}): CompletionRequirementSpec[] {
  const requirements: CompletionRequirementSpec[] = [];
  for (const subtask of input.subtasks) {
    requirements.push({
      key: `execution:${subtask.id}`,
      kind: 'execution',
      label: subtask.title,
      subtaskId: subtask.id,
      serviceId: null,
    });
    const deliversFiles = input.publicProject
      || (subtask.fileOutputs?.length ?? 0) > 0;
    if (deliversFiles) {
      requirements.push({
        key: `delivery:${subtask.id}`,
        kind: 'delivery',
        label: `${subtask.title} 的文件交付`,
        subtaskId: subtask.id,
        serviceId: null,
      });
    }
    if (subtask.deliveryKind === 'report') {
      requirements.push({
        key: `safety_report:${subtask.id}`,
        kind: 'safety_report',
        label: `${subtask.title} 的安全报告交付`,
        subtaskId: subtask.id,
        serviceId: null,
      });
    }
  }
  if(input.conversationGit)requirements.push({key:'workspace_delivery',kind:'workspace_delivery',label:'合并并写回 Workspace',subtaskId:null,serviceId:null});
  if (input.startServiceAfterPublish) {
    requirements.push({
      key: 'service',
      kind: 'service',
      label: '启动并接管本地服务',
      subtaskId: null,
      serviceId: input.serviceId ?? null,
    });
  }
  return requirements;
}

/** Parses a persisted requirement snapshot defensively. */
export function parseCompletionRequirements(value: unknown): CompletionRequirementSpec[] {
  if (!Array.isArray(value)) return [];
  const parsed: CompletionRequirementSpec[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const source = entry as Record<string, unknown>;
    if (
      typeof source.key !== 'string'
      || typeof source.kind !== 'string'
      || typeof source.label !== 'string'
    ) continue;
    parsed.push({
      key: source.key,
      kind: source.kind as CompletionRequirementSpec['kind'],
      label: source.label,
      subtaskId: typeof source.subtaskId === 'string' ? source.subtaskId : null,
      serviceId: typeof source.serviceId === 'string' ? source.serviceId : null,
    });
  }
  return parsed;
}
