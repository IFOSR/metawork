import type Database from 'better-sqlite3';
import type { AgentClass } from '../../src/core/types.js';
import { AgentClassRepo } from '../../src/storage/agent-class-repo.js';
import { builtinCodexAgentClass, builtinPiAgentClass } from './builtin-agent-classes.js';

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

// Seeds the SQLite agent_classes table with the canonical fixture AgentClasses
// that the removed built-in catalog used to provide. Production authority is the
// configuration projection; these fixtures only back SQLite-read tests.
export function seedAgentClasses(db: Database.Database): void {
  const repo = new AgentClassRepo(db);
  for (const agentClass of [plannerClass(), builtinCodexAgentClass(), builtinPiAgentClass()]) {
    repo.upsert(agentClass);
  }
}
