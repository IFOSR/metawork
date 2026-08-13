// Provides the configuration-derived Executor AgentClass projection used by
// Runtime and Kernel dispatch facts. Legacy SQLite seeding and the built-in
// catalog are removed; the active configuration revision is the single
// authority for AgentClasses.
import type { AgentClassDefinition } from '../configuration/types.js';

export interface AgentClassServiceDeps {
  agentClasses: Readonly<Record<string, AgentClassDefinition>>;
}

export class AgentClassService {
  private readonly agentClasses: Readonly<Record<string, AgentClassDefinition>>;

  constructor(deps: AgentClassServiceDeps) {
    this.agentClasses = deps.agentClasses;
  }

  listExecutorAgentClassNames(): string[] {
    return Object.entries(this.agentClasses)
      .filter(([, agentClass]) => agentClass.kind === 'executor' && agentClass.enabled)
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right));
  }

  hasExecutorAgentClass(name: string): boolean {
    const agentClass = this.agentClasses[name];
    return Boolean(agentClass && agentClass.kind === 'executor' && agentClass.enabled);
  }
}
