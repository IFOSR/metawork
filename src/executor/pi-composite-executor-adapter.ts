import type { ExecutorResult } from '../core/types.js';
import type {
  ExecutorAdapter,
  ExecutorInput,
  ExecutorProbeResult,
} from './adapter.js';
import { kernelFailure } from '../core/kernel-failure.js';

export interface PiCompositeExecutorAdapterDependencies {
  piAdapter: ExecutorAdapter;
  imageAdapter: ExecutorAdapter;
}

export class PiCompositeExecutorAdapter implements ExecutorAdapter {
  readonly name: string;
  readonly supportsContinuation: boolean;
  private readonly piAdapter: ExecutorAdapter;
  private readonly imageAdapter: ExecutorAdapter;

  constructor(dependencies: PiCompositeExecutorAdapterDependencies) {
    this.name = dependencies.piAdapter.name;
    this.supportsContinuation = Boolean(dependencies.piAdapter.supportsContinuation);
    this.piAdapter = dependencies.piAdapter;
    this.imageAdapter = dependencies.imageAdapter;
  }

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const capabilities = input.context.currentSubtask.requiredCapabilities;
    const hasGeneration = capabilities.includes('image-generation');
    const hasEditing = capabilities.includes('image-editing');
    if (hasGeneration && hasEditing) {
      return {
        success: false,
        output: '',
        error: 'a subtask cannot request both image generation and image editing',
        failure: kernelFailure({
          kind: 'configuration',
          scope: 'attempt',
          code: 'image_operation_ambiguous',
          summary: 'a subtask cannot request both image generation and image editing',
        }),
        exitCode: 1,
        durationMs: 0,
      };
    }
    return (hasGeneration || hasEditing)
      ? this.imageAdapter.execute(input)
      : this.piAdapter.execute(input);
  }

  executeResponseOnly(input: {
    attemptId?: string;
    prompt: string;
    maxBytes: number;
  }): Promise<ExecutorResult> {
    if (!this.piAdapter.executeResponseOnly) {
      return Promise.resolve({
        success: false,
        output: '',
        error: 'Pi adapter does not support response-only correction',
        failure: kernelFailure({
          kind: 'configuration',
          scope: 'agent_class',
          code: 'response_only_unsupported',
          summary: 'Pi adapter does not support response-only correction',
        }),
        exitCode: 1,
        durationMs: 0,
      });
    }
    return this.piAdapter.executeResponseOnly(input);
  }

  async probe(): Promise<ExecutorProbeResult> {
    const [pi, image] = await Promise.all([this.piAdapter.probe(), this.imageAdapter.probe()]);
    if (pi.available && image.available) return { available: true, failure: null };
    return {
      available: false,
      failure: pi.failure ?? image.failure ?? kernelFailure({
        kind: 'adapter',
        scope: 'agent_class',
        code: 'pi_composite_probe_failed',
        summary: 'Pi composite executor probe failed',
      }),
    };
  }

  abort(attemptId?: string): void {
    this.piAdapter.abort(attemptId);
    this.imageAdapter.abort(attemptId);
  }
}
