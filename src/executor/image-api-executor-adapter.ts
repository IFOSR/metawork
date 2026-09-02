import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { ExecutorResult } from '../core/types.js';
import type {
  ExecutorAdapter,
  ExecutorInput,
  ExecutorProbeResult,
} from './adapter.js';
import { normalizeExecutorFailure } from './error-utils.js';
import {
  type ImageApiRunnerInput,
  type ImageApiRunnerResult,
} from './image-api-runner.js';
import type { RuntimePrivateConfigurationBinding } from '../configuration/types.js';
import { ImageApiCliDriver } from './image-api-cli-driver.js';

export type ImageApiRunner = (
  input: ImageApiRunnerInput,
) => Promise<ImageApiRunnerResult>;

export interface ImageApiExecutorAdapterDependencies {
  agentClassId: string;
  authorizedBinding: AuthorizedExecutorBinding;
  runtimeBinding: RuntimePrivateConfigurationBinding;
  runner?: {
    run: ImageApiRunner;
    probe?(): Promise<ExecutorProbeResult>;
  };
}

export class ImageApiExecutorAdapter implements ExecutorAdapter {
  readonly name: string;
  readonly supportsContinuation = false;
  private readonly authorizedBinding: AuthorizedExecutorBinding;
  private readonly runtimeBinding: RuntimePrivateConfigurationBinding;
  private readonly runner: {
    run: ImageApiRunner;
    probe?(): Promise<ExecutorProbeResult>;
    abort?(attemptId?: string): void;
  };
  private readonly controllers = new Map<string, AbortController>();

  constructor(dependencies: ImageApiExecutorAdapterDependencies) {
    this.name = dependencies.agentClassId;
    this.authorizedBinding = dependencies.authorizedBinding;
    this.runtimeBinding = dependencies.runtimeBinding;
    this.runner = dependencies.runner ?? new ImageApiCliDriver();
  }

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const startedAt = Date.now();
    const binding = input.executionBinding;
    if (!binding) return failure('execution binding is required', 'execution_binding_missing', startedAt);
    const capabilities = input.context.currentSubtask.requiredCapabilities.filter(capability =>
      capability === 'image-generation' || capability === 'image-editing',
    );
    if (capabilities.length !== 1) {
      return failure(
        'image adapter requires exactly one image generation or image editing capability',
        'image_capability_missing',
        startedAt,
      );
    }
    const environment = this.runtimeBinding.environment ?? {};
    const baseUrl = environment.OPENAI_BASE_URL?.trim();
    const apiKey = environment.OPENAI_API_KEY?.trim();
    const modelId = environment.OPENAI_MODEL?.trim();
    if (!baseUrl || !apiKey || !modelId) {
      return failure(
        'authorized image provider environment is incomplete',
        'image_provider_binding_missing',
        startedAt,
      );
    }
    const controller = new AbortController();
    this.controllers.set(binding.attemptId, controller);
    try {
      const result = await this.runner.run({
        operation: capabilities[0] === 'image-editing' ? 'editing' : 'generation',
        workspacePath: binding.workspacePath,
        inputsPath: binding.inputsPath,
        attemptId: binding.attemptId,
        subtaskId: binding.subtaskId,
        baseUrl,
        apiKey,
        modelId,
        prompt: buildImagePrompt(input),
        signal: controller.signal,
        onProgress: text => input.onProgress?.({ kind: 'status', text }),
      });
      if (result.success) {
        return {
          success: true,
          output: result.output,
          exitCode: 0,
          durationMs: Date.now() - startedAt,
          diagnostics: {
            providerRef: this.authorizedBinding.providerRef,
            modelId,
            operation: capabilities[0] === 'image-editing' ? 'editing' : 'generation',
            artifactPaths: result.artifactPaths,
          },
        };
      }
      return {
        success: false,
        output: result.output,
        error: result.error,
        failure: normalizeExecutorFailure(result.error),
        exitCode: 1,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: message,
        failure: normalizeExecutorFailure(message, controller.signal.aborted),
        exitCode: 1,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      this.controllers.delete(binding.attemptId);
    }
  }

  async probe(): Promise<ExecutorProbeResult> {
    if (this.runner.probe) return this.runner.probe();
    return { available: true, failure: null };
  }

  abort(attemptId?: string): void {
    const controllers = attemptId
      ? [this.controllers.get(attemptId)].filter((value): value is AbortController => Boolean(value))
      : [...this.controllers.values()];
    for (const controller of controllers) controller.abort();
    this.runner.abort?.(attemptId);
  }
}

export function buildImagePrompt(input: ExecutorInput): string {
  const current = input.context.currentSubtask;
  const operation = current.requiredCapabilities.includes('image-editing')
    ? '图片编辑'
    : '图片生成';
  const acceptance = current.acceptance
    .map(item => item.description.trim())
    .filter(Boolean)
    .join('\n');
  const handoffs = input.context.incomingHandoffs ?? [];
  const evidenceItems = input.context.selectedEvidence ?? [];
  const handoffText = handoffs
    .flatMap(handoff => handoff.items)
    .flatMap(item => item.type === 'text' ? [item.value.trim()] : [])
    .filter(Boolean)
    .join('\n');
  const evidence = evidenceItems
    .map(item => item.content.trim())
    .filter(Boolean)
    .join('\n');
  return sanitizeImagePrompt([
    `操作类型：${operation}`,
    `操作目标：${current.goal.trim()}`,
    acceptance ? `验收要求：\n${acceptance}` : '',
    handoffText ? `上游明确要求：\n${handoffText}` : '',
    evidence ? `必要参考信息：\n${evidence}` : '',
  ].filter(Boolean).join('\n\n')).slice(0, 32 * 1024);
}

function sanitizeImagePrompt(value: string): string {
  return value.replace(/\u0000/gu, '');
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
