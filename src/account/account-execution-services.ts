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
import { CodexCliDriver } from '../executor/codex-cli-driver.js';
import { PiCliDriver } from '../executor/pi-cli-driver.js';
import type { ProbeCommandRunner } from '../executor/harness-driver.js';
import { LocalCliExecutorAdapter } from '../executor/local-cli-executor-adapter.js';
import { ContainerCompatibilityAdapter } from '../executor/container-compatibility-adapter.js';

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
  probeCommand?: ProbeCommandRunner;
  attemptExecutionBackend: AttemptExecutionBackend;
  attemptExecutionRepository: SqliteAttemptExecutionRepository;
  attemptsRoot: string;
}): AccountExecutionServices {
  const runtimeConfiguration = buildRuntimeConfigurationView(deps.stagedConfiguration.snapshot);
  const attemptsRoot = deps.attemptsRoot;
  const driverRegistry = new HarnessDriverRegistry();

  const registerLocalDriver = (driver: CodexCliDriver | PiCliDriver) => {
    driverRegistry.register(driver, input => {
      if ((deps.attemptExecutionBackend.kind ?? 'container') === 'worktree') {
        return new LocalCliExecutorAdapter({
          agentClassId: input.authorizedBinding.agentClassRef,
          driver: input.driver,
          runtimeBinding: input.runtimeBinding,
          attemptsRoot,
        });
      }
      return new ContainerCompatibilityAdapter({
        agentClassId: input.authorizedBinding.agentClassRef,
        driver: input.driver,
        runtimeBinding: input.runtimeBinding,
        attemptsRoot,
        imageRef: containerCompatibilityImage(input.driver.id),
        backend: deps.attemptExecutionBackend,
        repository: deps.attemptExecutionRepository,
        egressMode: input.authorizedBinding.permissionProfileRef === 'public-web-research'
          ? 'proxy'
          : 'disabled',
        nestedSandbox: input.driver.id === 'codex-cli'
          ? 'codex-workspace-write'
          : undefined,
      });
    });
  };

  const probeCommand = deps.probeCommand ?? (process.env.NODE_ENV === 'test'
    ? async () => ({ code: 0, stdout: 'test-harness', stderr: '' })
    : undefined);
  registerLocalDriver(new CodexCliDriver({ probeCommand }));
  registerLocalDriver(new PiCliDriver({ probeCommand }));

  const executorRegistry = new ExecutorRegistry({
    driverRegistry,
    getRuntimeConfiguration: revisionId => (
      revisionId === runtimeConfiguration.revisionId
        ? runtimeConfiguration
        : null
    ),
    getActiveRuntimeConfiguration: () => runtimeConfiguration,
    getRuntimeBinding: deps.getRuntimeBinding,
  });
  const executionRuntime = new ExecutionRuntime(executorRegistry);

  return { executorRegistry, executionRuntime };
}

/** Maps a legacy local-CLI harness driver to its retained Docker image for container compatibility. */
function containerCompatibilityImage(driverId: string): string {
  const legacyContainerImages: Record<string, string> = {
    'codex-cli': 'metaclaw-executor-codex:phase5',
    'pi-cli': 'metaclaw-executor-pi:phase5',
  };
  const image = legacyContainerImages[driverId];
  if (!image) {
    throw new Error(`No container compatibility image for harness driver: ${driverId}`);
  }
  return image;
}
