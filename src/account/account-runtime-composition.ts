/**
 * AccountRuntime 组合辅助（ADR-0031 第 2、12 节）。
 *
 * 组合根专用：从安装全局依赖 + 配置构造账户的 8 个 runtime-wide 服务簇，
 * 再通过 AccountRuntimeFactory 组装 AccountRuntime。会话级 callbacks 与
 * kernelExecutionServices 由 ConversationSession 通过端口自行构造。
 */

import type Database from 'better-sqlite3';
import type { TaskEngine } from '../task/task-engine.js';
import type { MemoryEngine } from '../memory/memory-engine.js';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { ContextRecaller } from '../memory/context-recaller.js';
import type { NotificationService } from '../notifications/types.js';
import type { StagedLegacyConfiguration } from '../configuration/staged-legacy-configuration.js';
import type { RuntimePrivateConfigurationBinding } from '../configuration/index.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { RevisionedAgentBinding } from '../core/authorized-executor-binding.js';
import type { PlanningAgent } from '../planning/planning-agent.js';
import type { PlannerProcessController } from '../planning/planner-process-supervisor.js';
import type { AttemptExecutionBackend } from '../execution/attempt-execution-backend.js';
import type { ProbeCommandRunner } from '../executor/harness-driver.js';
import { buildAccountKernelServices } from './account-kernel-services.js';
import { buildAccountRepositories } from './account-repositories.js';
import { buildAccountWorkspaceServices } from './account-workspace-services.js';
import { buildAccountTaskServices } from './account-task-services.js';
import { buildAccountExecutionServices } from './account-execution-services.js';
import { buildAccountCoordinatorServices } from './account-coordinator-services.js';
import { buildAccountRuntimeExecutionServices } from './account-runtime-execution-services.js';
import { buildAccountPlannerServices } from './account-planner-services.js';
import type { AccountKernelCoordinator } from './account-kernel-coordinator.js';
import { AccountRuntimeFactory } from './account-runtime-factory.js';
import { AccountRuntime } from './account-runtime.js';
import type { ConversationRuntimePort } from './account-runtime-ports.js';

export interface AccountRuntimeComposition {
  readonly accountRuntime: AccountRuntime;
  readonly runtimePort: ConversationRuntimePort;
}

export function buildAccountRuntimeComposition(deps: {
  accountId: string;
  db: Database.Database;
  taskEngine: TaskEngine;
  memoryEngine: MemoryEngine;
  orchestration: OrchestrationEngine;
  contextRecaller: ContextRecaller;
  notifier: NotificationService;
  workspaceRoot: string;
  sourceRoot: string;
  sessionId: string;
  stagedConfiguration: StagedLegacyConfiguration;
  plannerBinding: RevisionedAgentBinding;
  plannerBindingFingerprint: string;
  getRuntimeBinding(
    binding: AuthorizedExecutorBinding,
  ): Promise<RuntimePrivateConfigurationBinding> | RuntimePrivateConfigurationBinding;
  probeCommand?: ProbeCommandRunner;
  attemptExecutionBackend?: AttemptExecutionBackend;
  plannerSupervisor?: PlannerProcessController;
  planningAgent?: PlanningAgent;
  getConfigurationRevision(): string;
  buildKernelCoordinator(accountId: string): AccountKernelCoordinator;
  recoverDurableStartup(accountId: string): Promise<void>;
}): AccountRuntimeComposition {
  const kernelServices = buildAccountKernelServices(deps.db);
  const repositories = buildAccountRepositories(deps.db);
  const workspaceServices = buildAccountWorkspaceServices(deps.db, deps.workspaceRoot);
  const taskServices = buildAccountTaskServices({
    taskEngine: deps.taskEngine,
    agentClasses: deps.stagedConfiguration.snapshot.config.agentClasses,
    attemptExecutionBackend: deps.attemptExecutionBackend,
  });
  const executionServices = buildAccountExecutionServices({
    stagedConfiguration: deps.stagedConfiguration,
    getRuntimeBinding: deps.getRuntimeBinding,
    probeCommand: deps.probeCommand,
    attemptExecutionBackend: taskServices.attemptExecutionBackend,
    attemptExecutionRepository: workspaceServices.attemptExecutionRepository,
  });
  const coordinatorServices = buildAccountCoordinatorServices({
    db: deps.db,
    executionRuntime: executionServices.executionRuntime,
    executorRegistry: executionServices.executorRegistry,
    kernelExecutorStatusRepo: repositories.kernelExecutorStatusRepo,
    getConfigurationRevision: deps.getConfigurationRevision,
  });
  const runtimeExecutionServices = buildAccountRuntimeExecutionServices({
    db: deps.db,
    sessionId: deps.sessionId,
    sourceRoot: deps.sourceRoot,
    taskRuntimeService: taskServices.taskRuntimeService,
    subtaskRepo: repositories.subtaskRepo,
    taskEventRepo: repositories.taskEventRepo,
    workGraphRevisionRepo: repositories.workGraphRevisionRepo,
    workUnitClaimService: coordinatorServices.workUnitClaimService,
    executionRuntime: executionServices.executionRuntime,
    agentClassService: taskServices.agentClassService,
    workspaceStore: workspaceServices.workspaceStore,
    attemptExecutionBackend: taskServices.attemptExecutionBackend,
    permissionRepository: workspaceServices.permissionRepository,
    kernelWorkflowRepo: kernelServices.kernelWorkflowRepo,
    workspaceRepository: workspaceServices.workspaceRepository,
    attemptExecutionRepository: workspaceServices.attemptExecutionRepository,
  });
  const plannerServices = buildAccountPlannerServices({
    db: deps.db,
    memoryEngine: deps.memoryEngine,
    contextRecaller: deps.contextRecaller,
    plannerBinding: deps.plannerBinding,
    plannerBindingFingerprint: deps.plannerBindingFingerprint,
    plannerSupervisor: deps.plannerSupervisor,
    planningAgent: deps.planningAgent,
  });

  const factory = new AccountRuntimeFactory({
    buildKernelCoordinator: deps.buildKernelCoordinator,
    buildKernelServices: () => kernelServices,
    buildRepositories: () => repositories,
    buildWorkspaceServices: () => workspaceServices,
    buildExecutionServices: () => executionServices,
    buildPlannerServices: () => plannerServices,
    buildTaskServices: () => taskServices,
    buildCoordinatorServices: () => coordinatorServices,
    buildRuntimeExecutionServices: () => runtimeExecutionServices,
    recoverDurableStartup: deps.recoverDurableStartup,
  });
  const accountRuntime = factory.create(deps.accountId);

  return {
    accountRuntime,
    runtimePort: accountRuntime.getConversationPort(),
  };
}
