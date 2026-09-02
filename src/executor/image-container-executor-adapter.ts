import type { RuntimePrivateConfigurationBinding } from '../configuration/types.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { ExecutorResult } from '../core/types.js';
import {
  AttemptModelGatewayServer,
  type AttemptModelGatewayBinding,
} from '../execution/attempt-model-gateway.js';
import {
  DEFAULT_ATTEMPT_EXECUTION_LIMITS,
  type AttemptExecutionBackend,
} from '../execution/attempt-execution-backend.js';
import type { ExecutorAdapter, ExecutorInput, ExecutorProbeResult } from './adapter.js';
import { normalizeExecutorFailure } from './error-utils.js';
import { buildImagePrompt } from './image-api-executor-adapter.js';

const IMAGE_RUNNER_PATH = '/opt/metaclaw/image-api-cli.js';
const IMAGE_GATEWAY_BYTES = 64 * 1024 * 1024;

export interface ImageContainerExecutorAdapterDependencies {
  agentClassId: string;
  authorizedBinding: AuthorizedExecutorBinding;
  runtimeBinding: RuntimePrivateConfigurationBinding;
  imageRef: string;
  backend: AttemptExecutionBackend;
  createGateway?: (options: {
    upstreamBaseUrl: string;
    upstreamApiKey: string;
    advertisedHost: string;
    maxRequestBytes: number;
    maxResponseBytes: number;
  }) => {
    start(): Promise<AttemptModelGatewayBinding>;
    close(): Promise<void>;
  };
}

export class ImageContainerExecutorAdapter implements ExecutorAdapter {
  readonly name: string;
  readonly supportsContinuation = false;
  private readonly authorizedBinding: AuthorizedExecutorBinding;
  private readonly runtimeBinding: RuntimePrivateConfigurationBinding;
  private readonly imageRef: string;
  private readonly backend: AttemptExecutionBackend;
  private readonly createGateway: NonNullable<ImageContainerExecutorAdapterDependencies['createGateway']>;
  private readonly activeContainers = new Map<string, string>();

  constructor(dependencies: ImageContainerExecutorAdapterDependencies) {
    this.name = dependencies.agentClassId;
    this.authorizedBinding = dependencies.authorizedBinding;
    this.runtimeBinding = dependencies.runtimeBinding;
    this.imageRef = dependencies.imageRef;
    this.backend = dependencies.backend;
    this.createGateway = dependencies.createGateway ?? (options => new AttemptModelGatewayServer(options));
  }

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const startedAt = Date.now();
    const binding = input.executionBinding;
    if (!binding) return failure('execution binding is required', 'execution_binding_missing', startedAt);
    const capabilities = input.context.currentSubtask.requiredCapabilities;
    const operation = capabilities.includes('image-editing')
      ? 'editing'
      : capabilities.includes('image-generation')
        ? 'generation'
        : null;
    if (!operation) return failure('image capability is required', 'image_capability_missing', startedAt);
    const environment = this.runtimeBinding.environment ?? {};
    const baseUrl = environment.OPENAI_BASE_URL?.trim();
    const apiKey = environment.OPENAI_API_KEY?.trim();
    const modelId = environment.OPENAI_MODEL?.trim();
    if (!baseUrl || !apiKey || !modelId) {
      return failure('authorized image provider environment is incomplete', 'image_provider_binding_missing', startedAt);
    }
    const gateway = this.createGateway({
      upstreamBaseUrl: baseUrl,
      upstreamApiKey: apiKey,
      advertisedHost: process.env.METACLAW_CONTROL_HOST ?? 'metaclaw-control',
      maxRequestBytes: IMAGE_GATEWAY_BYTES,
      maxResponseBytes: IMAGE_GATEWAY_BYTES,
    });
    let containerId: string | null = null;
    try {
      const gatewayBinding = await gateway.start();
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
        command: 'node',
        args: [IMAGE_RUNNER_PATH],
        environment: {
          METACLAW_IMAGE_OPERATION: operation,
          METACLAW_IMAGE_WORKSPACE_PATH: '/workspace',
          METACLAW_INPUTS_PATH: '/inputs',
          METACLAW_ATTEMPT_ID: binding.attemptId,
          METACLAW_SUBTASK_ID: binding.subtaskId,
          METACLAW_IMAGE_BASE_URL: gatewayBinding.baseUrl,
          METACLAW_IMAGE_API_KEY: gatewayBinding.apiKey,
          METACLAW_IMAGE_MODEL: modelId,
          METACLAW_IMAGE_PROMPT: buildImagePrompt(input),
        },
        mounts: [
          { source: binding.workspacePath, target: '/workspace', mode: 'rw' },
          { source: binding.inputsPath, target: '/inputs', mode: 'ro' },
        ],
        controlNetwork: binding.controlNetwork,
        egressMode: 'disabled',
        limits: DEFAULT_ATTEMPT_EXECUTION_LIMITS,
      });
      containerId = record.containerId;
      this.activeContainers.set(binding.attemptId, containerId);
      binding.onExecutionCreated?.(containerId);
      input.onProgress?.({ kind: 'status', text: 'image container execution started' });
      await this.backend.start(containerId);
      const exitCode = await this.backend.wait(containerId);
      const logs = await this.backend.logs(containerId);
      const parsed = parseRunnerOutput(logs);
      await this.backend.remove(containerId);
      this.activeContainers.delete(binding.attemptId);
      if (parsed.success && exitCode === 0) {
        return {
          success: true,
          output: parsed.output,
          exitCode,
          durationMs: Date.now() - startedAt,
        };
      }
      const error = parsed.success
        ? `image runner exited with code ${exitCode}`
        : parsed.error;
      return {
        success: false,
        output: parsed.output,
        error,
        failure: normalizeExecutorFailure(error),
        exitCode,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (containerId) {
        await this.backend.stop(containerId).catch(() => undefined);
        await this.backend.remove(containerId).catch(() => undefined);
      }
      return {
        success: false,
        output: '',
        error: message,
        failure: normalizeExecutorFailure(message),
        exitCode: 1,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      this.activeContainers.delete(binding.attemptId);
      await gateway.close().catch(() => undefined);
    }
  }

  async probe(): Promise<ExecutorProbeResult> {
    try {
      if (!this.imageRef.trim()) throw new Error('image executor image reference is required');
      await this.backend.resolveImage(this.imageRef);
      return { available: true, failure: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { available: false, failure: normalizeExecutorFailure(message) };
    }
  }

  abort(attemptId?: string): void {
    const ids = attemptId
      ? [this.activeContainers.get(attemptId)].filter((value): value is string => Boolean(value))
      : [...this.activeContainers.values()];
    for (const id of ids) void this.backend.stop(id).catch(() => undefined);
  }
}

function parseRunnerOutput(logs: string):
  | { success: true; output: string }
  | { success: false; output: string; error: string } {
  const events = logs.split(/\r?\n/u).flatMap(line => {
    try {
      const event = JSON.parse(line) as unknown;
      return event && typeof event === 'object' && !Array.isArray(event)
        ? [event as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
  const result = events.find(event => event.type === 'result');
  if (result?.success === true && typeof result.output === 'string') {
    return { success: true, output: result.output };
  }
  return {
    success: false,
    output: typeof result?.output === 'string' ? result.output : '',
    error: typeof result?.error === 'string'
      ? result.error
      : 'image runner exited without a result',
  };
}

function failure(message: string, code: string, startedAt: number): ExecutorResult {
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
