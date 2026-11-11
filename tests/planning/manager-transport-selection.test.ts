import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAccountPlannerServices } from '../../src/account/account-planner-services.js';
import { buildManagerPlannerServices } from '../../src/planning/manager-host/session-transport.js';
import { ManagerPlanningAgent } from '../../src/planning/manager-host/manager-planning-agent.js';

// ADR-0055 D6: the vendored Planner and the upstream-Pi Manager are selected in
// exactly one place, and an incomplete upstream configuration fails loudly
// instead of quietly running the other runtime.
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scope() {
  return { workspaceRoot: '/tmp/ws', writable: false, permissionProfileRef: 'engineering' };
}

describe('planner transport wiring', () => {
  it('builds the Manager services without any vendored Planner process', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-transport-'));
    roots.push(root);
    const services = buildManagerPlannerServices({
      runtimeRoot: root,
      resolveScope: scope,
      piCommand: 'pi',
    });
    expect(services.planningAgent).toBeInstanceOf(ManagerPlanningAgent);
    expect('plannerSupervisor' in services).toBe(false);
  });

  it('requires the Manager transport configuration when it is selected', () => {
    vi.stubEnv('METAWORK_MANAGER_TRANSPORT', 'upstream-pi');
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => buildAccountPlannerServices({})).toThrow(/Manager transport/u);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('uses the Manager transport when configuration is supplied', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-transport-'));
    roots.push(root);
    vi.stubEnv('METAWORK_MANAGER_TRANSPORT', 'upstream-pi');
    const services = buildAccountPlannerServices({
      managerTransport: { runtimeRoot: root, resolveScope: scope, piCommand: 'pi' },
    });
    expect(services.planningAgent).toBeInstanceOf(ManagerPlanningAgent);
  });
});
