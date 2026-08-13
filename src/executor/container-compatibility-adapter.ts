import type { RuntimePrivateConfigurationBinding } from '../configuration/types.js';
import type { ExecutorResult } from '../core/types.js';
import {
  DEFAULT_ATTEMPT_EXECUTION_LIMITS,
  type AttemptExecutionBackend,
} from '../execution/attempt-execution-backend.js';
import type { AttemptExecutionRepositoryPort } from '../execution/repositories.js';
import type { ExecutorAdapter, ExecutorInput, ExecutorProbeResult } from './adapter.js';
import { normalizeExecutorFailure } from './error-utils.js';
import type { HarnessDriver } from './harness-driver.js';
import { buildExecutorContextPrompt } from './prompt-builder.js';

export interface ContainerCompatibilityAdapterDependencies {
  agentClassId: string;
  driver: HarnessDriver;
  runtimeBinding: RuntimePrivateConfigurationBinding;
  attemptsRoot: string;
  imageRef: string;
  backend: AttemptExecutionBackend;
  repository?: AttemptExecutionRepositoryPort;
  runtimeEnvironment?: Record<string, string>;
  egressMode?: 'disabled' | 'proxy';
  nestedSandbox?: 'codex-workspace-write';
}

export class ContainerCompatibilityAdapter implements ExecutorAdapter {
  readonly name: string;
  readonly supportsContinuation = false;
  private readonly driver: HarnessDriver;
  private readonly runtimeBinding: RuntimePrivateConfigurationBinding;
  private readonly attemptsRoot: string;
  private readonly imageRef: string;
  private readonly backend: AttemptExecutionBackend;
  private readonly repository?: AttemptExecutionRepositoryPort;
  private readonly runtimeEnvironment: Record<string, string>;
  private readonly egressMode: 'disabled' | 'proxy';
  private readonly nestedSandbox?: 'codex-workspace-write';
  private readonly activeContainers = new Map<string, string>();

  constructor(dependencies: ContainerCompatibilityAdapterDependencies) {
    this.name = dependencies.agentClassId;
    this.driver = dependencies.driver;
    this.runtimeBinding = dependencies.runtimeBinding;
    this.attemptsRoot = dependencies.attemptsRoot;
    this.imageRef = dependencies.imageRef;
    this.backend = dependencies.backend;
    this.repository = dependencies.repository;
    this.runtimeEnvironment = { ...dependencies.runtimeEnvironment };
    this.egressMode = dependencies.egressMode ?? 'disabled';
    this.nestedSandbox = dependencies.nestedSandbox;
  }

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const startedAt = Date.now();
    const binding = input.executionBinding;
    if (!binding) {
      return configurationFailure(
        'execution binding is required',
        'execution_binding_missing',
        startedAt,
      );
    }

    try {
      this.requireContainerBackend();
      if (!this.imageRef.trim()) throw new Error('container image reference is required');

      const runtimeHome = await this.driver.materializeHome({
        attemptId: binding.attemptId,
        revisionId: this.runtimeBinding.revisionId,
        agentClassId: this.name,
        bindingFingerprint: this.runtimeBinding.bindingFingerprint,
        attemptsRoot: this.attemptsRoot,
      });
      const launch = this.driver.buildLaunch({
        prompt: buildExecutorContextPrompt(containerExecutorInput(input)),
        cwd: '/workspace',
        runtimeHomePath: '/runtime-home',
      });
      const resolvedImageId = await this.backend.resolveImage(this.imageRef);
      const record = await this.backend.create({
        attemptId: binding.attemptId,
        taskId: binding.taskId,
        generationId: binding.generationId,
        subtaskId: binding.subtaskId,
        workUnitId: binding.workUnitId,
        leaseToken: binding.leaseToken,
        idempotencyKey: binding.idempotencyKey,
        imageRef: this.imageRef,
        resolvedImageId,
        command: launch.command,
        args: [...launch.args],
        environment: {
          ...this.runtimeBinding.environment,
          ...this.runtimeEnvironment,
          ...launch.environment,
          METACLAW_ATTEMPT_ID: binding.attemptId,
          METACLAW_CAPABILITY_MCP_URL: binding.capabilityBinding?.mcpUrl ?? '',
          METACLAW_CAPABILITY_URL: binding.capabilityBinding?.jsonUrl ?? '',
          METACLAW_CAPABILITY_USE_URL: binding.capabilityBinding?.useUrl ?? '',
          METACLAW_CAPABILITY_TOKEN: binding.capabilityBinding?.bearerToken ?? '',
          METACLAW_EVIDENCE_MCP_URL: input.context.evidenceTools.binding?.mcpUrl ?? '',
          METACLAW_EVIDENCE_JSON_URL: input.context.evidenceTools.binding?.jsonUrl ?? '',
          METACLAW_EVIDENCE_TOKEN: input.context.evidenceTools.binding?.bearerToken ?? '',
          ...(this.egressMode === 'proxy' ? {
            HTTP_PROXY: 'http://metaclaw-egress:8080',
            HTTPS_PROXY: 'http://metaclaw-egress:8080',
            NO_PROXY: 'metaclaw-control',
          } : {}),
        },
        mounts: [
          { source: runtimeHome.homePath, target: '/runtime-home', mode: 'rw' },
          { source: binding.workspacePath, target: '/workspace', mode: 'rw' },
          { source: binding.sourcePath, target: '/source', mode: 'ro' },
          { source: binding.inputsPath, target: '/inputs', mode: 'ro' },
          { source: binding.handoffsPath, target: '/handoffs', mode: 'ro' },
          ...(binding.gitMetadataPath
            ? [{ source: binding.gitMetadataPath, target: '/workspace/.git', mode: 'ro' as const }]
            : []),
        ],
        controlNetwork: binding.controlNetwork,
        egressMode: this.egressMode,
        nestedSandbox: this.nestedSandbox,
        limits: DEFAULT_ATTEMPT_EXECUTION_LIMITS,
      });

      const createdAt = new Date().toISOString();
      this.repository?.create({
        attemptId: binding.attemptId,
        taskId: binding.taskId,
        generationId: binding.generationId,
        subtaskId: binding.subtaskId,
        workUnitId: binding.workUnitId,
        workspaceId: binding.workspaceId,
        containerId: record.containerId,
        imageRef: this.imageRef,
        imageId: record.imageId,
        status: 'created',
        leaseToken: binding.leaseToken,
        labels: record.labels,
        exitCode: null,
        resultCollectedAt: null,
        cleanupStatus: null,
        cleanupError: null,
        createdAt,
        updatedAt: createdAt,
      });
      this.activeContainers.set(binding.attemptId, record.containerId);
      binding.onExecutionCreated?.(record.containerId);
      input.onProgress?.({
        kind: 'status',
        text: `container execution ${record.containerId.slice(0, 12)} started`,
      });

      await this.backend.start(record.containerId);
      this.repository?.update(binding.attemptId, {
        status: 'running',
        updatedAt: new Date().toISOString(),
      });
      const exitCode = await this.backend.wait(record.containerId);
      const logs = await this.backend.logs(record.containerId);
      this.repository?.update(binding.attemptId, {
        status: 'exited',
        exitCode,
        resultCollectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const parsed = this.driver.parseResult({
        exitCode,
        stdout: logs,
        stderr: logs,
      });

      await this.backend.remove(record.containerId);
      this.repository?.update(binding.attemptId, {
        status: 'removed',
        cleanupStatus: 'removed',
        updatedAt: new Date().toISOString(),
      });
      this.activeContainers.delete(binding.attemptId);

      if (parsed.success) {
        return {
          success: true,
          output: restoreWorkspacePath(parsed.output, binding.workspacePath),
          exitCode,
          durationMs: Date.now() - startedAt,
        };
      }
      return {
        success: false,
        output: '',
        error: parsed.error,
        failure: normalizeExecutorFailure(parsed.error),
        exitCode,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.cleanupFailedAttempt(binding.attemptId, message);
      return configurationFailure(
        message,
        'execution_backend_configuration_failure',
        startedAt,
      );
    }
  }

  async probe(): Promise<ExecutorProbeResult> {
    try {
      this.requireContainerBackend();
      if (!this.imageRef.trim()) throw new Error('container image reference is required');
      const harness = await this.driver.probe();
      if (!harness.available) {
        return {
          available: false,
          failure: normalizeExecutorFailure(
            harness.detail?.trim() || `Harness driver is unavailable: ${this.driver.id}`,
          ),
        };
      }
      await this.backend.resolveImage(this.imageRef);
      return { available: true, failure: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        failure: normalizeExecutorFailure(message),
      };
    }
  }

  abort(attemptId?: string): void {
    const containerIds = attemptId
      ? [this.activeContainers.get(attemptId)].filter((id): id is string => Boolean(id))
      : [...this.activeContainers.values()];
    for (const containerId of containerIds) {
      void this.backend.stop(containerId).catch(() => undefined);
    }
  }

  private requireContainerBackend(): void {
    if (
      (this.backend.kind && this.backend.kind !== 'container')
      || (this.backend.pathMode && this.backend.pathMode !== 'container')
    ) {
      throw new Error('ContainerCompatibilityAdapter requires a container execution backend');
    }
  }

  private async cleanupFailedAttempt(attemptId: string, failure: string): Promise<void> {
    const containerId = this.activeContainers.get(attemptId);
    let cleanupError: string | null = null;
    if (containerId) {
      try {
        await this.backend.stop(containerId);
        await this.backend.remove(containerId);
        this.repository?.update(attemptId, {
          status: 'removed',
          cleanupStatus: 'removed',
          cleanupError: null,
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!containerId || cleanupError) {
      this.repository?.update(attemptId, {
        cleanupStatus: 'failed',
        cleanupError: cleanupError ?? failure,
        updatedAt: new Date().toISOString(),
      });
    }
    this.activeContainers.delete(attemptId);
  }
}

function containerExecutorInput(input: ExecutorInput): ExecutorInput {
  const binding = input.executionBinding!;
  return {
    ...input,
    context: {
      ...input.context,
      workspaceContext: {
        ...input.context.workspaceContext,
        workingDirectory: '/workspace',
        targetPaths: input.context.workspaceContext.targetPaths.map(target => (
          containerPath(target, binding.workspacePath)
        )),
      },
    },
  };
}

function containerPath(path: string, workspacePath: string): string {
  if (
    path !== workspacePath
    && !path.startsWith(`${workspacePath}/`)
    && !path.startsWith(`${workspacePath}\\`)
  ) {
    return path;
  }
  return `/workspace${path.slice(workspacePath.length).replaceAll('\\', '/')}`;
}

function restoreWorkspacePath(output: string, workspacePath: string): string {
  const runtimeWorkspacePath = workspacePath.replaceAll('\\', '/');
  return output.replaceAll(
    /\/workspace(?=\/|[\s`"')\]}]|$)/gu,
    runtimeWorkspacePath,
  );
}

function configurationFailure(
  message: string,
  code: string,
  startedAt: number,
): ExecutorResult {
  return {
    success: false,
    output: '',
    error: message,
    failure: {
      kind: 'configuration',
      scope: 'agent_class',
      code,
      summary: message,
    },
    exitCode: 1,
    durationMs: Date.now() - startedAt,
  };
}
