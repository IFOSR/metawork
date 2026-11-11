/**
 * 账户级 Planner 服务簇（ADR-0031 第 2 节，ADR-0055 D6）。
 *
 * 一个账户一个 PlanningAgent，多个 Conversation 通过各自的 sessionId 复用它。
 * 当前实现是 Manager 传输：MetaWork 启动打包的上游 Pi 进程，不再有 vendored
 * Planner 进程，因此这里没有 supervisor。
 */

import type { PlanningAgent } from '../planning/planning-agent.js';
import { resolvePlanningTransport } from '../planning/manager-host/transport-selection.js';
import {
  buildManagerPlannerServices,
  type ManagerTransportInput,
} from '../planning/manager-host/session-transport.js';

/** Fails loudly: used only where a test never plans. */
const unavailablePlanningAgent: PlanningAgent = {
  plan: async () => { throw new Error('planning agent: this test does not plan'); },
  submit: async () => { throw new Error('planning agent: this test does not plan'); },
} as unknown as PlanningAgent;

export interface AccountPlannerServices {
  readonly planningAgent: PlanningAgent;
  readonly managerPermissionJudge?: import('../resource/manager-permission-judge.js').ManagerPermissionJudge;
}

export function buildAccountPlannerServices(deps: {
  /** Explicitly injected agent (tests, embedded composition). */
  planningAgent?: PlanningAgent;
  /** Manager transport configuration; required when no agent is injected. */
  managerTransport?: ManagerTransportInput;
  /** Present only when a caller deliberately runs the legacy vendored Planner. */
  legacyPlanningAgent?: PlanningAgent;
}): AccountPlannerServices {
  if (deps.planningAgent) return { planningAgent: deps.planningAgent };
  const transport = resolvePlanningTransport(process.env);
  if (transport === 'vendored-planner') {
    if (!deps.legacyPlanningAgent) {
      throw new Error(
        'METAWORK_MANAGER_TRANSPORT=vendored-planner requires an injected legacy planning agent; '
        + 'the vendored Planner runtime is removed',
      );
    }
    return { planningAgent: deps.legacyPlanningAgent };
  }
  if (!deps.managerTransport) {
    // Test suites that never plan only need a placeholder account service. It is
    // deliberately unavailable rather than silent: a test that plans by accident
    // fails with this message instead of running an unconfigured runtime.
    if (process.env.NODE_ENV === 'test') return { planningAgent: unavailablePlanningAgent };
    throw new Error(
      'planning requires a Manager transport (runtime root plus the Conversation Workspace resolver)',
    );
  }
  return buildManagerPlannerServices(deps.managerTransport);
}
