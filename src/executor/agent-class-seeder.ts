// Seeds built-in AgentClass profiles without treating command probes as static metadata.
import type { AgentClass } from '../core/types.js';
import type { AgentClassRepo } from '../storage/agent-class-repo.js';
import type { WorkUnitRepo } from '../storage/work-unit-repo.js';
import {
  getBuiltinExecutorDefinition,
  getBuiltinExecutorDefinitions,
  type BuiltinExecutorDefinition,
} from './builtin-executor-catalog.js';

export interface AgentClassSeedInput {
  defaultExecutorName: string;
  availableCommands?: Set<string>;
}

function agentClassFromDefinition(definition: BuiltinExecutorDefinition): AgentClass {
  return {
    name: definition.name,
    kind: 'executor',
    ...definition.agentClassDefaults,
    capabilities: [...definition.routingCapabilities],
    primaryUseCases: [...definition.primaryUseCases],
    avoidUseCases: [...definition.avoidUseCases],
  };
}

function plannerClass(): AgentClass {
  return {
    name: 'planner',
    kind: 'planner',
    domains: ['planning', 'task_lifecycle', 'dispatch'],
    capabilities: ['intent_recognition', 'work_graph_planning', 'subtask_dispatch', 'human_instruction_handling'],
    inputTypes: ['text', 'task_events', 'work_unit_events'],
    outputTypes: ['work_graph', 'task_events'],
    strengths: ['task decomposition', 'lifecycle coordination', 'resource-aware dispatch'],
    weaknesses: ['executor work is delegated'],
    primaryUseCases: ['plan work graph', 'handle user instruction', 'receive executor report'],
    avoidUseCases: ['direct code implementation', 'artifact mutation'],
    intentAffinity: {},
    riskLevel: 'medium',
    harness: 'in_process',
    model: null,
    skills: ['metaclaw-planner'],
    mcpServers: ['metaclaw_planner'],
    plugins: [],
    runtimeCommand: null,
    runtimeArgs: [],
    runtimeCheckCommand: null,
    projectUrl: null,
  };
}

export function seedDefaultAgentClasses(
  agentClassRepo: Pick<AgentClassRepo, 'upsert' | 'findByName'>,
  input: AgentClassSeedInput,
): void {
  if (
    !getBuiltinExecutorDefinition(input.defaultExecutorName)
    && !agentClassRepo.findByName(input.defaultExecutorName)
  ) {
    throw new Error(
      `Default Executor ${input.defaultExecutorName} is not canonical and has no registered AgentClass. `
      + 'Start with codex-cli or pi-agent, register the Executor AgentClass, then switch the default configuration.',
    );
  }

  if (!agentClassRepo.findByName('planner')) agentClassRepo.upsert(plannerClass());
  for (const definition of getBuiltinExecutorDefinitions()) {
    if (!agentClassRepo.findByName(definition.name)) {
      agentClassRepo.upsert(agentClassFromDefinition(definition));
    }
  }
}

export function seedDefaultWorkUnits(
  workUnitRepo: Pick<WorkUnitRepo, 'upsert' | 'findById'>,
  input: { executorAgentClassName: string },
): void {
  const now = new Date().toISOString();
  if (!workUnitRepo.findById('planner-1')) {
    workUnitRepo.upsert({
      id: 'planner-1',
      agentClassName: 'planner',
      agentClassKind: 'planner',
      state: 'idle',
      claimedTaskId: null,
      claimedSubtaskId: null,
      heartbeatAt: now,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }
}
