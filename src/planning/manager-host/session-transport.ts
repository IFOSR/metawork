/**
 * Planner service bundle for the upstream-Pi Manager transport (ADR-0055 D6).
 *
 * The session keeps its existing shape: one `PlanningAgent` per account plus an
 * optional Planner process controller. With the Manager transport there is no
 * vendored Planner process at all, so `plannerSupervisor` is null and every
 * planning turn goes through the packaged upstream Pi.
 */
import { resolve } from 'node:path';
import type { PlanningContext } from '../planning-types.js';
import type { AccountPlannerServices } from '../../account/account-planner-services.js';
import type { ManagerTurnScope } from './manager-planning-agent.js';
import { composeManagerPlanningAgent, type ManagerAgentCompositionInput } from './composition.js';

export interface ManagerTransportInput {
  /** Runtime root that owns the Manager home. */
  readonly runtimeRoot: string;
  /** Conversation → Workspace/permission resolution, owned by composition. */
  readonly resolveScope: (context: PlanningContext) => ManagerTurnScope | Promise<ManagerTurnScope>;
  readonly piCommand?: string;
  readonly explicitEnv?: Readonly<Record<string, string>>;
  readonly moduleRoot?: string;
  readonly turnTimeoutMs?: number;
  readonly onDiagnostic?: (line: string) => void;
  readonly providerConfig?: ManagerAgentCompositionInput['providerConfig'];
  readonly mcpEnv?: ManagerAgentCompositionInput['mcpEnv'];
  readonly resolvePermissionContext?: ManagerAgentCompositionInput['resolvePermissionContext'];
  readonly beforeModelCall?: ManagerAgentCompositionInput['beforeModelCall'];
}

export interface ManagerTransportServices extends AccountPlannerServices {
  readonly close?: () => Promise<void>;
}

export function buildManagerPlannerServices(input: ManagerTransportInput): ManagerTransportServices {
  const composed = composeManagerPlanningAgent({
    runtimeRoot: resolve(input.runtimeRoot),
    ...(input.piCommand === undefined ? {} : { piCommand: input.piCommand }),
    ...(input.explicitEnv === undefined ? {} : { explicitEnv: input.explicitEnv }),
    ...(input.moduleRoot === undefined ? {} : { moduleRoot: input.moduleRoot }),
    ...(input.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: input.turnTimeoutMs }),
    ...(input.onDiagnostic === undefined ? {} : { onDiagnostic: input.onDiagnostic }),
    resolveScope: input.resolveScope,
    providerConfig: input.providerConfig,
    mcpEnv: input.mcpEnv,
    resolvePermissionContext: input.resolvePermissionContext,
    beforeModelCall: input.beforeModelCall,
  });
  return {
    planningAgent: composed.planningAgent,
    managerPermissionJudge: composed.managerPermissionJudge,
    close: () => composed.planningAgent.close(),
  };
}
