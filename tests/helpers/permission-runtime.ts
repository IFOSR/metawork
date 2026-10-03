import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { KernelDecisionRepo } from '../../src/storage/kernel-decision-repo.js';
import { SqlitePermissionRepository } from '../../src/storage/permission-repo.js';
import { createSqliteAccountPermissionService } from '../../src/account/sqlite-account-permission-service.js';
import { ControlKernel, type KernelEvent } from '../../src/kernel/control-kernel.js';
import type { NormalizedCapabilityRequest } from '../../src/resource/index.js';

// Use the real workflow, Kernel and transactional repositories. Backend launch is
// deliberately absent: permission continuation must be durable without any client.
export function permissionFixture() {
  const db = new Database(':memory:');
  runMigrations(db);
  db.pragma('foreign_keys = OFF');
  const store = new KernelWorkflowRepo(db);
  const permissions = new SqlitePermissionRepository(db);
  const now = new Date().toISOString();
  const request: NormalizedCapabilityRequest = {
    id: 'request', fingerprint: 'fingerprint', taskId: 'task', generationId: 'generation',
    subtaskId: 'subtask', attemptId: 'attempt', agentClassName: 'codex-cli',
    permissionProfileId: 'workspace-engineering', capability: 'network_target',
    resource: 'https://example.com/data', partition: {
      kind: 'external_object', provider: 'https', account: 'public', collection: 'example.com', objectId: '/data',
    }, operation: 'GET', reason: 'public source', suggestedScope: 'attempt', distinctRequestOrdinal: 1,
  };
  permissions.createRequest(request, now);
  permissions.escalate(request.id, 'escalation', 'approval required', now);
  const event: Extract<KernelEvent, { type: 'permission_resolution_received' }> = {
    schemaVersion: 5, configurationRevision: 'revision', id: 'permission_resolution_request',
    type: 'permission_resolution_received', correlationId: request.id, causationId: null,
    sessionId: 'session', taskId: 'task', subtaskId: 'subtask', attemptId: 'attempt',
    occurredAt: now, requestId: request.id, resolution: 'approve', source: 'button', plannerPlanId: null,
  };
  const createService = () => createSqliteAccountPermissionService({
    kernelServices: { kernelWorkflowRepo: store, kernelDecisionRepo: new KernelDecisionRepo(db), controlKernel: new ControlKernel() },
    runtimeExecutionServices: { dispatchItemRepo: { find: () => ({ configurationRevision: 'revision', taskId: 'task', generationId: 'generation' }) } },
    taskServices: { taskRuntimeService: { findTask: () => ({ id: 'task', status: 'blocked', resources: [] }) },
      attemptExecutionBackend: { inspect: async () => null } },
    workspaceServices: { permissionRepository: permissions, attemptExecutionRepository: { find: () => null } },
    repositories: { workGraphRevisionRepo: { findActive: () => ({ generationId: 'generation' }) } },
  } as never);
  return { db, store, event, request, permissions, createService };
}
