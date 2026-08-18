/**
 * 账户级 Planner 服务簇（ADR-0031 第 2 节）。
 *
 * Planner 进程（plannerSupervisor）、PlanningAgent 与 MemoryContextService 是
 * 账户级服务：一个账户一个 Planner 进程，多个 Conversation 通过各自的
 * sessionId 复用同一 PlanningAgent。按账户构造一次。
 */

import type Database from 'better-sqlite3';
import type { MemoryEngine } from '../memory/memory-engine.js';
import type { ContextRecaller } from '../memory/context-recaller.js';
import { MemoryContextService } from '../memory/memory-context-service.js';
import type { PlanningAgent } from '../planning/planning-agent.js';
import { createDefaultPlanningAgent } from '../planning/anyfusion-planning-agent.js';
import {
  getDefaultPlannerProcessSupervisor,
  type PlannerProcessController,
} from '../planning/planner-process-supervisor.js';
import { PlannerRunRepo } from '../storage/planner-run-repo.js';
import type { RevisionedAgentBinding } from '../core/authorized-executor-binding.js';

export interface AccountPlannerServices {
  readonly memoryContextService: MemoryContextService;
  readonly plannerSupervisor: PlannerProcessController | null;
  readonly planningAgent: PlanningAgent;
}

export function buildAccountPlannerServices(deps: {
  db: Database.Database;
  memoryEngine: MemoryEngine;
  contextRecaller: ContextRecaller;
  plannerBinding: RevisionedAgentBinding;
  plannerBindingFingerprint: string;
  plannerSupervisor?: PlannerProcessController;
  planningAgent?: PlanningAgent;
}): AccountPlannerServices {
  const memoryContextService = new MemoryContextService({
    memoryEngine: deps.memoryEngine,
    contextRecaller: deps.contextRecaller,
  });

  const plannerSupervisor = deps.plannerSupervisor
    ?? (deps.planningAgent ? null : getDefaultPlannerProcessSupervisor());

  const planningAgent = deps.planningAgent ?? createDefaultPlanningAgent({
    runner: plannerSupervisor!,
    audit: new PlannerRunRepo(deps.db),
    resolvePlannerAuditBinding: async configurationRevision => {
      if (configurationRevision !== deps.plannerBinding.configurationRevision) {
        throw new Error(`Planner audit binding revision is unavailable: ${configurationRevision}`);
      }
      return {
        plannerBinding: deps.plannerBinding,
        plannerBindingFingerprint: deps.plannerBindingFingerprint,
      };
    },
  });

  return { memoryContextService, plannerSupervisor, planningAgent };
}
