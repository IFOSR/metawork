import type { PlanningAgentPlan, PlanningContext } from './planning-types.js';

export interface PlanningAgent {
  plan(context: PlanningContext): Promise<PlanningAgentPlan>;
}
