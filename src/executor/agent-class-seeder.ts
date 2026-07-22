// Seeds built-in AgentClass profiles without treating command probes as static metadata.
import { isDeepStrictEqual } from 'node:util';
import type { AgentClass } from '../core/types.js';
import type { AgentClassRepo } from '../storage/agent-class-repo.js';
import type { WorkUnitRepo } from '../storage/work-unit-repo.js';
import { getBuiltinExecutorAgentClasses } from './builtin-executor-catalog.js';

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
    executionImageRef: null,
    resolvedImageId: null,
    permissionProfileId: null,
    projectUrl: null,
  };
}

function unclassifiedExecutorClass(name: string): AgentClass {
  return {
    name,
    kind: 'executor',
    domains: [],
    capabilities: [],
    inputTypes: ['text'],
    outputTypes: ['markdown'],
    strengths: [],
    weaknesses: [],
    primaryUseCases: [],
    avoidUseCases: [],
    intentAffinity: {},
    riskLevel: 'medium',
    harness: 'cli',
    model: null,
    skills: [],
    mcpServers: [],
    plugins: [],
    runtimeCommand: null,
    runtimeArgs: [],
    runtimeCheckCommand: null,
    executionImageRef: null,
    resolvedImageId: null,
    permissionProfileId: null,
    projectUrl: null,
  };
}

function hasCanonicalStaticFields(existing: AgentClass, canonical: AgentClass): boolean {
  const {
    createdAt: _existingCreatedAt,
    updatedAt: _existingUpdatedAt,
    resolvedImageId: _existingResolvedImageId,
    ...existingStatic
  } = existing;
  const {
    createdAt: _canonicalCreatedAt,
    updatedAt: _canonicalUpdatedAt,
    resolvedImageId: _canonicalResolvedImageId,
    ...canonicalStatic
  } = canonical;
  return isDeepStrictEqual(existingStatic, canonicalStatic);
}

export function seedDefaultAgentClasses(
  agentClassRepo: Pick<AgentClassRepo, 'upsert' | 'findByName'>,
  input: AgentClassSeedInput,
): void {
  const canonicalAgentClasses = getBuiltinExecutorAgentClasses();

  if (!agentClassRepo.findByName('planner')) agentClassRepo.upsert(plannerClass());
  for (const canonical of canonicalAgentClasses) {
    const existing = agentClassRepo.findByName(canonical.name);
    if (!existing || !hasCanonicalStaticFields(existing, canonical)) {
      agentClassRepo.upsert({
        ...canonical,
        resolvedImageId: existing?.executionImageRef === canonical.executionImageRef
          ? existing.resolvedImageId
          : null,
        createdAt: existing?.createdAt,
      });
    }
  }
  if (!agentClassRepo.findByName(input.defaultExecutorName)) {
    agentClassRepo.upsert(unclassifiedExecutorClass(input.defaultExecutorName));
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
      claimedAttemptId: null,
      heartbeatAt: now,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }
}
