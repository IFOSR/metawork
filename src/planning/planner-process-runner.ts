import type { PlannerProposalPurpose } from './planner-proposal.js';
import {
  PlannerProcessSupervisor,
  type PlannerProcessSupervisorDeps,
  type PlannerRunner,
} from './planner-process-supervisor.js';
import type { PlanningContext } from './planning-types.js';

export type {
  PlannerRunner,
  PlannerProcessSupervisorDeps as PlannerProcessRunnerDeps,
} from './planner-process-supervisor.js';

/** Compatibility wrapper retained until the Task 10 authority cutover. */
export class PlannerProcessRunner implements PlannerRunner {
  private readonly supervisor: PlannerProcessSupervisor;

  constructor(deps: PlannerProcessSupervisorDeps = {}) {
    this.supervisor = new PlannerProcessSupervisor(deps);
  }

  run(
    prompt: string,
    context: PlanningContext,
    purpose: PlannerProposalPurpose,
  ) {
    return this.supervisor.run(prompt, context, purpose);
  }
}
