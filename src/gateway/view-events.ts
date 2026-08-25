// Structured Client View Events. CLI, Gateway, and Feishu adapters consume these
// events as typed records instead of parsing display text.
import type { ArtifactProjection } from '../delivery/user-artifact-types.js';

export type ClientViewEvent =
  | TaskStateChanged
  | PlannerStateChanged
  | ExecutorAttemptChanged
  | ConfigurationChanged
  | PermissionRequested
  | ArtifactPublished
  | NoticeRaised;

interface ClientViewEventBase {
  schemaVersion: 1;
  id: string;
  occurredAt: string;
  sessionId: string | null;
}

export interface TaskStateChanged extends ClientViewEventBase {
  type: 'task_state_changed';
  taskId: string;
  from: string;
  to: string;
}

export interface PlannerStateChanged extends ClientViewEventBase {
  type: 'planner_state_changed';
  from: 'idle' | 'running';
  to: 'idle' | 'running';
}

export interface ExecutorAttemptChanged extends ClientViewEventBase {
  type: 'executor_attempt_changed';
  taskId: string;
  subtaskId: string;
  attemptId: string;
  agentClassName: string;
  from: string;
  to: string;
}

export interface ConfigurationChanged extends ClientViewEventBase {
  type: 'configuration_changed';
  fromRevisionId: string | null;
  toRevisionId: string;
}

export interface PermissionRequested extends ClientViewEventBase {
  type: 'permission_requested';
  taskId: string;
  permissionRequestId: string;
  capability: string;
  resource: string;
  operation: string;
}

export interface ArtifactPublished extends ClientViewEventBase {
  type: 'artifact_published';
  taskId: string;
  publicationId: string;
  artifactCount: number;
  /** 受限的用户 artifact projection；历史客户端可以只使用 artifactCount。 */
  artifacts?: ArtifactProjection[];
}

export interface NoticeRaised extends ClientViewEventBase {
  type: 'notice_raised';
  severity: 'info' | 'warning' | 'error';
  text: string;
}

export type ClientViewEventType = ClientViewEvent['type'];

const CLIENT_VIEW_EVENT_TYPES = new Set<ClientViewEventType>([
  'task_state_changed',
  'planner_state_changed',
  'executor_attempt_changed',
  'configuration_changed',
  'permission_requested',
  'artifact_published',
  'notice_raised',
]);

export function isClientViewEvent(value: unknown): value is ClientViewEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && typeof record.type === 'string'
    && CLIENT_VIEW_EVENT_TYPES.has(record.type as ClientViewEventType)
    && typeof record.id === 'string'
    && typeof record.occurredAt === 'string';
}
