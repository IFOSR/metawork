// Seeds built-in AgentClass profiles without treating command probes as static metadata.
import type { AgentClass } from '../core/types.js';
import type { AgentClassRepo } from '../storage/agent-class-repo.js';
import type { WorkUnitRepo } from '../storage/work-unit-repo.js';

export interface AgentClassSeedInput {
  defaultExecutorName: string;
  availableCommands?: Set<string>;
}

function executorClass(defaultExecutorName: string): AgentClass {
  const isPi = defaultExecutorName === 'pi-agent';
  return {
    name: defaultExecutorName,
    kind: 'executor',
    domains: isPi ? ['research', 'web'] : ['software', 'repo', 'terminal', 'code_review'],
    capabilities: isPi
      ? ['current-web-research', 'source-verification', 'citation-handoff']
      : ['workspace-engineering', 'coding', 'tests', 'debugging', 'refactor', 'code_review', 'noninteractive_execution'],
    inputTypes: ['text', 'files'],
    outputTypes: ['code', 'patch', 'markdown', 'review'],
    strengths: isPi
      ? ['current public-web research', 'source verification', 'citation handoff']
      : ['local repository editing', 'test execution', 'bug fixing', 'code review'],
    weaknesses: isPi ? ['repository engineering delivery'] : ['broad business workflow orchestration'],
    primaryUseCases: isPi
      ? ['current public-web research', 'source-backed reports']
      : ['implementation', 'bugfix', 'test execution', 'code review'],
    avoidUseCases: isPi
      ? ['local repository modification and testing']
      : ['current public-web research requiring source-backed delivery'],
    intentAffinity: isPi
      ? { repo_execution: 0.1, technical_reasoning: 0.35, research_workflow: 1, general: 0.25 }
      : { repo_execution: 1, technical_reasoning: 0.45, research_workflow: 0.15, general: 0.35 },
    riskLevel: 'medium',
    historicalSuccess: 0.85,
    harness: 'cli',
    model: null,
    skills: [],
    mcpServers: [],
    plugins: [],
    runtimeCommand: null,
    runtimeArgs: [],
    runtimeCheckCommand: null,
    projectUrl: null,
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
    historicalSuccess: 0.8,
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
  if (!agentClassRepo.findByName('planner')) agentClassRepo.upsert(plannerClass());
  for (const name of new Set(['codex-cli', 'pi-agent', input.defaultExecutorName])) {
    if (!agentClassRepo.findByName(name)) {
      agentClassRepo.upsert(executorClass(name));
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
