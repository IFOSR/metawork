import type { AgentClass, Task } from '../core/types.js';
import type { TaskSummary } from '../core/llm-bridge.js';
import { RuleHintsProvider } from '../core/rule-hints-provider.js';
import type { PlanningContext } from './planning-types.js';

export interface PlanningContextBuilderDeps {
  listTasks(): Task[];
  listAgentClasses(): AgentClass[];
  defaultExecutorName: string;
  getFocusContext(): PlanningContext['currentFocus'];
  getTimeoutMs(): number;
  cwd?: string;
}

export class PlanningContextBuilder {
  constructor(private readonly deps: PlanningContextBuilderDeps) {}

  build(input: {
    userInput: string;
    suppressSafetyGuardHints?: boolean;
  }): PlanningContext {
    const hints = new RuleHintsProvider(this.deps.cwd ?? process.cwd()).collect(input.userInput);
    return {
      userInput: input.userInput,
      recentTasks: buildRecentTaskSummaries(this.deps.listTasks()),
      agentClasses: this.deps.listAgentClasses(),
      defaultExecutorName: this.deps.defaultExecutorName,
      currentFocus: this.deps.getFocusContext(),
      hints: input.suppressSafetyGuardHints
        ? hints.filter(hint => hint.source !== 'safety_guard')
        : hints,
      allowDurableTask: true,
      allowFileModification: true,
      timeoutMs: this.deps.getTimeoutMs(),
    };
  }
}

function buildRecentTaskSummaries(tasks: Task[]): TaskSummary[] {
  return tasks.map(task => ({
    id: task.id,
    title: task.title,
    goal: task.goal,
    summary: task.summary,
    status: task.status,
  }));
}
