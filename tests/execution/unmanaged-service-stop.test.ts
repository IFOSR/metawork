import { describe, expect, it } from 'vitest';
import { decideManagedService } from '../../src/execution/managed-service-policy.js';
import type { ControlEvent, ControlSnapshot } from '../../src/control/control-contracts.js';

// The uvicorn on port 8000 was started by an Executor outside Runtime
// ownership (2026-11-11). `service_stop` could only see managed instances and
// failed the Turn with a bare "服务不存在", giving the user no explanation.
const event = {
  schemaVersion: 5,
  configurationRevision: 'revision-test',
  type: 'managed_service_requested',
  operation: 'stop',
  serviceId: 'price-in-service',
  id: 'service_stop_event',
  correlationId: 'task_new',
  causationId: null,
  occurredAt: '2026-11-11T10:31:46.000Z',
  sessionId: 'conversation-1',
  taskId: 'task_new',
  workspaceId: 'workspace_main',
} as unknown as Extract<ControlEvent, { type: 'managed_service_requested' }>;

const snapshot = {
  schemaVersion: 5,
  type: 'service_control',
  task: { id: 'task_new', status: 'running' },
  published: true,
  serviceTaskId: null,
  serviceWorkspaceId: 'workspace_main',
  serviceRevision: null,
} as unknown as Extract<ControlSnapshot, { type: 'service_control' }>;

describe('unmanaged service stop', () => {
  it('names the ownership gap and the two ways out instead of failing silently', () => {
    const decision = decideManagedService(event, snapshot);
    expect(decision.action).toMatchObject({ type: 'reject_request' });
    expect(decision.reason).toContain('没有这个服务的托管记录');
    expect(decision.reason).toContain('进程管理器');
    expect(decision.reason).toContain('命令任务');
  });
});
