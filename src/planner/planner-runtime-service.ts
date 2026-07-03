import type { ExecutionPlan } from '../session/session-helpers.js';
import type { AgentClass, Task } from '../core/types.js';
import type { IntentDecisionV2 } from '../core/intent-orchestrator.js';
import { IntentRecognitionSkill, type PlannerIntentOutcome } from './intent-recognition-skill.js';
import { PlannerRoutingSkill, type WorkGraphPlan } from './planner-routing-skill.js';

export interface PlannerRuntimeResult {
  intent: PlannerIntentOutcome;
  workGraph: WorkGraphPlan | null;
}

export class PlannerRuntimeService {
  constructor(
    private readonly intentSkill = new IntentRecognitionSkill(),
    private readonly routingSkill = new PlannerRoutingSkill(),
  ) {}

  plan(input: {
    task: Task;
    userPrompt: string;
    taskExecutionPlan: ExecutionPlan;
    intentDecision?: IntentDecisionV2 | null;
    agentClasses: AgentClass[];
    resources: string[];
    recalledTaskIds?: string[];
  }): PlannerRuntimeResult {
    const intent = this.intentSkill.recognize({
      userPrompt: input.userPrompt,
      intentDecision: input.intentDecision,
    });

    if (intent.action !== 'plan_work_graph') {
      return {
        intent,
        workGraph: null,
      };
    }

    const workGraph = this.routingSkill.plan(input);

    return {
      intent,
      workGraph,
    };
  }
}
