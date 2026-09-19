// Provides the configuration-derived Executor AgentClass projection used by
// Runtime and Kernel dispatch facts. Legacy SQLite seeding and the built-in
// catalog are removed; the active configuration revision is the single
// authority for AgentClasses.
import type { AgentClassDefinition } from '../configuration/types.js';

export interface AgentClassServiceDeps {
  agentClasses?: Readonly<Record<string, AgentClassDefinition>>;
  getAgentClasses?: () => Readonly<Record<string, AgentClassDefinition>>;
}

export class AgentClassService {
  private readonly getAgentClasses: () => Readonly<Record<string, AgentClassDefinition>>;

  constructor(deps: AgentClassServiceDeps) {
    if (!deps.getAgentClasses && !deps.agentClasses) throw new Error('AgentClass configuration is required');
    this.getAgentClasses = deps.getAgentClasses ?? (() => deps.agentClasses!);
  }

  listExecutorAgentClassNames(): string[] {
    return Object.entries(this.getAgentClasses())
      .filter(([, agentClass]) => agentClass.kind === 'executor' && agentClass.enabled)
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right));
  }

  hasExecutorAgentClass(name: string): boolean {
    const agentClass = this.getAgentClasses()[name];
    return Boolean(agentClass && agentClass.kind === 'executor' && agentClass.enabled);
  }
}
