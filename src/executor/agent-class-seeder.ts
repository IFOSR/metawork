// Seeds built-in AgentClass profiles without treating command probes as static metadata.
import { isDeepStrictEqual } from 'node:util';
import type { AgentClass } from '../core/types.js';
import type { AgentClassRepo } from '../storage/agent-class-repo.js';
import type { WorkUnitRepo } from '../storage/work-unit-repo.js';
import {
  getBuiltinExecutorAgentClasses,
  getBuiltinExecutorDefinition,
} from './builtin-executor-catalog.js';

export interface AgentClassSeedInput {
  defaultExecutorName: string;
  availableCommands?: Set<string>;
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

function hasCanonicalStaticFields(existing: AgentClass, canonical: AgentClass): boolean {
  const { createdAt: _existingCreatedAt, updatedAt: _existingUpdatedAt, ...existingStatic } = existing;
  const { createdAt: _canonicalCreatedAt, updatedAt: _canonicalUpdatedAt, ...canonicalStatic } = canonical;
  return isDeepStrictEqual(existingStatic, canonicalStatic);
}

export function seedDefaultAgentClasses(
  agentClassRepo: Pick<AgentClassRepo, 'upsert' | 'findByName'>,
  input: AgentClassSeedInput,
): void {
  const canonicalAgentClasses = getBuiltinExecutorAgentClasses();
  if (
    !getBuiltinExecutorDefinition(input.defaultExecutorName)
    && !agentClassRepo.findByName(input.defaultExecutorName)
  ) {
    throw new Error(
      `Default Executor ${input.defaultExecutorName} is not canonical and has no registered AgentClass. `
      + `Start with ${canonicalAgentClasses.map(agentClass => agentClass.name).join(' or ')}, `
      + 'register the Executor AgentClass, then switch the default configuration.',
    );
  }

  if (!agentClassRepo.findByName('planner')) agentClassRepo.upsert(plannerClass());
  for (const canonical of canonicalAgentClasses) {
    const existing = agentClassRepo.findByName(canonical.name);
    if (!existing || !hasCanonicalStaticFields(existing, canonical)) {
      agentClassRepo.upsert({ ...canonical, createdAt: existing?.createdAt });
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
