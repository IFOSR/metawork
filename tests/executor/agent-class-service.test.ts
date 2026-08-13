import { describe, expect, it } from 'vitest';
import { AgentClassService } from '../../src/executor/agent-class-service.js';
import type { AgentClassDefinition } from '../../src/configuration/types.js';

function executorAgentClass(overrides: Partial<AgentClassDefinition> = {}): AgentClassDefinition {
  return {
    kind: 'executor',
    harnessRef: 'codex-cli',
    modelPolicy: { mode: 'fixed', modelRef: 'engineering-v1' },
    permissionProfileRef: 'workspace-engineering',
    routingCapabilities: ['workspace-engineering'],
    primaryUseCases: [],
    avoidUseCases: [],
    plannerAffordances: [],
    skills: [],
    mcpServers: [],
    plugins: [],
    generatedRuntimeRef: 'codex-cli',
    enabled: true,
    ...overrides,
  };
}

describe('AgentClassService configuration projection', () => {
  it('lists only enabled executor AgentClass names in sorted order', () => {
    const service = new AgentClassService({
      agentClasses: {
        'pi-agent': executorAgentClass(),
        planner: executorAgentClass({ kind: 'planner', harnessRef: 'anyfusion-planner' }),
        'codex-cli': executorAgentClass(),
        disabled: executorAgentClass({ enabled: false }),
      },
    });

    expect(service.listExecutorAgentClassNames()).toEqual(['codex-cli', 'pi-agent']);
  });

  it('reports whether an enabled executor AgentClass exists', () => {
    const service = new AgentClassService({
      agentClasses: {
        'codex-cli': executorAgentClass(),
        disabled: executorAgentClass({ enabled: false }),
        planner: executorAgentClass({ kind: 'planner', harnessRef: 'anyfusion-planner' }),
      },
    });

    expect(service.hasExecutorAgentClass('codex-cli')).toBe(true);
    expect(service.hasExecutorAgentClass('disabled')).toBe(false);
    expect(service.hasExecutorAgentClass('planner')).toBe(false);
    expect(service.hasExecutorAgentClass('missing')).toBe(false);
  });
});
