/**
 * 账户级执行器注册与运行时服务簇（ADR-0031 第 2 节）。
 *
 * ExecutorRegistry 与 ExecutionRuntime 是账户作用域的 runtime-wide 服务，
 * 按账户构造一次。会话通过 AccountRuntime 共享它们。
 */

import {
  buildRuntimeConfigurationView,
  type RuntimePrivateConfigurationBinding,
} from '../configuration/index.js';
import type { StagedLegacyConfiguration } from '../configuration/staged-legacy-configuration.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { AttemptExecutionBackend } from '../execution/attempt-execution-backend.js';
import { ExecutionRuntime, ExecutorRegistry } from '../execution/execution-runtime.js';
import type { SqliteAttemptExecutionRepository } from '../storage/attempt-execution-backend-repo.js';
import { HarnessDriverRegistry } from '../executor/harness-driver-registry.js';
import { resolveExecutorTool } from '../utils/executor-tool-path.js';
import { PiCliDriver } from '../executor/pi-cli-driver.js';
import type { ProbeCommandRunner } from '../executor/harness-driver.js';
import { DurableNativeProcessRunner } from '../executor/durable-native-process-runner.js';
import { LocalCliExecutorAdapter } from '../executor/local-cli-executor-adapter.js';
import { ImageApiExecutorAdapter } from '../executor/image-api-executor-adapter.js';
import { PiCompositeExecutorAdapter } from '../executor/pi-composite-executor-adapter.js';

export type RuntimeBindingResolver = (
  binding: AuthorizedExecutorBinding,
) => Promise<RuntimePrivateConfigurationBinding> | RuntimePrivateConfigurationBinding;

export interface AccountExecutionServices {
  readonly executorRegistry: ExecutorRegistry;
  readonly executionRuntime: ExecutionRuntime;
}

export function buildAccountExecutionServices(deps: {
  stagedConfiguration: StagedLegacyConfiguration;
  getRuntimeBinding: RuntimeBindingResolver;
  getRuntimeConfiguration?: (
    revisionId: string,
  ) => ReturnType<typeof buildRuntimeConfigurationView> | null;
  getActiveRuntimeConfiguration?: () => ReturnType<typeof buildRuntimeConfigurationView>;
  probeCommand?: ProbeCommandRunner;
  attemptExecutionBackend: AttemptExecutionBackend;
  attemptExecutionRepository: SqliteAttemptExecutionRepository;
  attemptsRoot: string;
  generatedRuntimeRoot?: string;
}): AccountExecutionServices {
  const initialRuntimeConfiguration = buildRuntimeConfigurationView(deps.stagedConfiguration.snapshot);
  const getRuntimeConfiguration = deps.getRuntimeConfiguration
    ?? (revisionId => revisionId === initialRuntimeConfiguration.revisionId
      ? initialRuntimeConfiguration
      : null);
  const getActiveRuntimeConfiguration = deps.getActiveRuntimeConfiguration
    ?? (() => initialRuntimeConfiguration);
  const attemptsRoot = deps.attemptsRoot;
  const driverRegistry = new HarnessDriverRegistry();

  const registerLocalDriver = (driver: PiCliDriver) => {
    driverRegistry.register(driver, input => {
      if ((deps.attemptExecutionBackend.kind && deps.attemptExecutionBackend.kind !== 'native')
        || (deps.attemptExecutionBackend.pathMode && deps.attemptExecutionBackend.pathMode !== 'native')
        || input.driver.id !== 'pi-cli') {
        throw new Error('MetaWork requires the native bundled Pi Executor runtime');
      }
      const command = resolveExecutorTool(input.harness.transport === 'local-cli' ? input.harness.command : 'pi');
      const piDriver = new PiCliDriver({ command, probeCommand, generatedRuntimeRoot: deps.generatedRuntimeRoot });
      const piAdapter = new LocalCliExecutorAdapter({
        agentClassId: input.authorizedBinding.agentClassRef,
        driver: piDriver,
        runtimeBinding: input.runtimeBinding,
        authorizedBinding: input.authorizedBinding,
        modelId: input.configuration.models[input.authorizedBinding.modelRef]!.modelId,
        executorAffordances: input.agentClass.plannerAffordances,
        attemptsRoot,
        processRunner: new DurableNativeProcessRunner(deps.attemptExecutionBackend, deps.attemptExecutionRepository),
        idleTimeoutMs: input.configuration.runtimePolicy.executorIdleTimeoutMs,
      });
      const imageAdapter = new ImageApiExecutorAdapter({
        agentClassId: input.authorizedBinding.agentClassRef,
        authorizedBinding: input.authorizedBinding,
        runtimeBinding: input.runtimeBinding,
      });
      return new PiCompositeExecutorAdapter({ piAdapter, imageAdapter });
    });
  };

  const probeCommand = deps.probeCommand ?? (process.env.NODE_ENV === 'test'
    ? async () => ({ code: 0, stdout: 'test-harness', stderr: '' })
    : undefined);
  registerLocalDriver(new PiCliDriver({
    probeCommand,
    generatedRuntimeRoot: deps.generatedRuntimeRoot,
  }));

  const executorRegistry = new ExecutorRegistry({
    driverRegistry,
    getRuntimeConfiguration,
    getActiveRuntimeConfiguration,
    getRuntimeBinding: deps.getRuntimeBinding,
  });
  const executionRuntime = new ExecutionRuntime(executorRegistry);

  return { executorRegistry, executionRuntime };
}
