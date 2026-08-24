/**
 * 账户级 work-unit 认领与执行器恢复刷新服务簇（ADR-0031 第 2 节）。
 *
 * WorkUnitClaimService 与 ExecutorRecoveryRefreshService 是账户作用域服务。
 * ExecutorRecoveryRefreshService 的 onRecovered 回调前向引用
 * KernelExecutionRuntime，这里用可变引用 + bindKernelExecutionRuntime 绑定，
 * 保持与 MetaclawSession 惰性实例字段一致的语义。
 */

import type Database from 'better-sqlite3';
import { WorkUnitClaimService } from '../execution/work-unit-claim-service.js';
import { ExecutorRecoveryRefreshService } from '../execution/executor-recovery-refresh-service.js';
import { KernelExecutorStatusProjector } from '../execution/kernel-executor-status-projector.js';
import type { KernelExecutorStatusRepo } from '../storage/kernel-executor-status-repo.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';
import type { ExecutionRuntime, ExecutorRegistry } from '../execution/execution-runtime.js';
import type { KernelExecutionRuntime } from '../execution/kernel-execution-runtime.js';

export interface AccountCoordinatorServices {
  readonly workUnitClaimService: WorkUnitClaimService;
  readonly executorRecoveryRefreshService: ExecutorRecoveryRefreshService;
  bindKernelExecutionRuntime(runtime: KernelExecutionRuntime): void;
}

export function buildAccountCoordinatorServices(deps: {
  db: Database.Database;
  executionRuntime: ExecutionRuntime;
  executorRegistry: ExecutorRegistry;
  kernelExecutorStatusRepo: KernelExecutorStatusRepo;
  getConfigurationRevision: () => string;
}): AccountCoordinatorServices {
  const kernelExecutorStatusProjector = new KernelExecutorStatusProjector(deps.kernelExecutorStatusRepo);
  let kernelExecutionRuntimeRef: KernelExecutionRuntime | null = null;

  const workUnitClaimService = new WorkUnitClaimService(
    new WorkUnitRepo(deps.db),
    60_000,
    async (binding, mode) => {
      const result = await deps.executionRuntime.probeExecutor(binding);
      if (!result.available && result.failure) {
        kernelExecutorStatusProjector.recordExecutionOutcome({
          agentClassName: binding.agentClassRef,
          configurationRevision: binding.configurationRevision,
          attemptId: `${mode}_probe_${binding.agentClassRef}_${binding.configurationRevision}`,
          outcome: 'failed',
          failure: result.failure,
        });
      }
      return result.available;
    },
  );

  const executorRecoveryRefreshService = new ExecutorRecoveryRefreshService({
    statusRepo: deps.kernelExecutorStatusRepo,
    statusProjector: kernelExecutorStatusProjector,
    getConfigurationRevision: deps.getConfigurationRevision,
    probe: (name, configurationRevision, previousFailure) => {
      const binding = deps.executorRegistry.probeBindingForAgentClass(name, configurationRevision);
      return binding
        ? deps.executionRuntime.probeExecutor(binding, previousFailure)
        : Promise.resolve({
            available: false,
            failure: {
              kind: 'configuration',
              scope: 'agent_class',
              code: 'executor_binding_not_found',
              summary: `No Runtime binding is configured for AgentClass ${name} `
                + `at revision ${configurationRevision}`,
            },
          });
    },
    onRecovered: (name, configurationRevision, checkId) => (
      kernelExecutionRuntimeRef?.executorRecovered(name, configurationRevision, checkId)
    ),
  });

  return {
    workUnitClaimService,
    executorRecoveryRefreshService,
    bindKernelExecutionRuntime: runtime => {
      kernelExecutionRuntimeRef = runtime;
    },
  };
}
