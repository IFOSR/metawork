import { describe, expect, it } from 'vitest';
import {
  ControlKernel,
  type KernelEvent,
  type KernelSnapshot,
} from '../../src/kernel/control-kernel.js';
import { localServiceSpecificationRevision } from '../../src/core/local-service-revision.js';
import type { LocalServiceSpecification } from '../../src/task/local-service.js';

const specification: LocalServiceSpecification = {
  serviceId: 'backend',
  taskId: 'task_new',
  command: 'node',
  args: ['server.mjs'],
  environmentReferences: {},
  host: '127.0.0.1',
  port: 8811,
  healthPath: '/health',
  startupTimeoutMs: 2000,
  restartPolicy: 'explicit',
};
const revision = localServiceSpecificationRevision(specification);

function event(overrides: Partial<Extract<KernelEvent, { type: 'managed_service_requested' }>> = {}) {
  return {
    schemaVersion: 5,
    configurationRevision: 'revision-test',
    type: 'managed_service_requested',
    operation: 'start',
    serviceId: 'backend',
    specification: { ...specification },
    workspaceId: 'workspace_1',
    specificationRevision: revision,
    id: 'service_event_1',
    correlationId: 'task_new',
    causationId: null,
    occurredAt: new Date().toISOString(),
    sessionId: 'session_1',
    taskId: 'task_new',
    ...overrides,
  } as Extract<KernelEvent, { type: 'managed_service_requested' }>;
}

function snapshot(overrides: Partial<Extract<KernelSnapshot, { type: 'service_control' }>> = {}) {
  return {
    schemaVersion: 5,
    type: 'service_control',
    task: { id: 'task_new', status: 'running' as const },
    published: true,
    serviceTaskId: 'task_old',
    serviceWorkspaceId: 'workspace_1',
    serviceRevision: revision,
    ...overrides,
  } as KernelSnapshot;
}

describe('managed service ownership handover', () => {
  it('lets the current Task take over an identical specification from an earlier Task', () => {
    const decision = new ControlKernel().decide(event(), snapshot());
    expect(decision).toMatchObject({
      action: { type: 'control_managed_service', taskId: 'task_new', serviceId: 'backend', operation: 'start' },
    });
  });

  it('refuses a registration that belongs to another Workspace', () => {
    const decision = new ControlKernel().decide(
      event(),
      snapshot({ serviceWorkspaceId: 'workspace_2' }),
    );
    expect(decision.action).toMatchObject({ type: 'reject_request' });
    expect(decision.reason).toContain('服务不属于该 Workspace');
  });

  it('refuses a different launch specification without an explicit update', () => {
    const decision = new ControlKernel().decide(
      event(),
      snapshot({ serviceRevision: 'service_revision_other' }),
    );
    expect(decision.action).toMatchObject({ type: 'reject_request' });
    expect(decision.reason).toContain('服务规格 revision 与已授权 revision 不一致');
  });

  it('still requires the Workspace and revision facts before a handover', () => {
    const decision = new ControlKernel().decide(event({ workspaceId: undefined }), snapshot());
    expect(decision.action).toMatchObject({ type: 'reject_request' });
    expect(decision.reason).toContain('服务归属不匹配');
  });
});
