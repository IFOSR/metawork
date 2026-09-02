import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMetaWorkPaths } from '../installation/paths.js';
import type {
  LocalCliChildProcessRunner,
} from './local-cli-executor-adapter.js';
import { SpawnLocalCliChildProcessRunner } from './local-cli-executor-adapter.js';
import type {
  ImageApiRunnerInput,
  ImageApiRunnerResult,
} from './image-api-runner.js';

export interface ImageApiCliCommand {
  command: string;
  args: readonly string[];
}

export class ImageApiCliDriver {
  private readonly command: ImageApiCliCommand;
  private readonly processRunner: LocalCliChildProcessRunner;
  private readonly idleTimeoutMs: number;

  constructor(dependencies: {
    command?: ImageApiCliCommand;
    processRunner?: LocalCliChildProcessRunner;
    idleTimeoutMs?: number;
  } = {}) {
    this.command = dependencies.command ?? resolveImageApiCliCommand();
    this.processRunner = dependencies.processRunner ?? new SpawnLocalCliChildProcessRunner();
    this.idleTimeoutMs = dependencies.idleTimeoutMs ?? 300_000;
  }

  async run(input: ImageApiRunnerInput): Promise<ImageApiRunnerResult> {
    let terminal: ImageApiRunnerResult | null = null;
    const abort = () => this.processRunner.abort(input.attemptId);
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await this.processRunner.run({
        attemptId: input.attemptId,
        command: this.command.command,
        args: [...this.command.args],
        cwd: input.workspacePath,
        idleTimeoutMs: this.idleTimeoutMs,
        environment: {
          METACLAW_IMAGE_OPERATION: input.operation,
          METACLAW_IMAGE_WORKSPACE_PATH: input.workspacePath,
          METACLAW_INPUTS_PATH: input.inputsPath ?? '',
          METACLAW_ATTEMPT_ID: input.attemptId,
          METACLAW_SUBTASK_ID: input.subtaskId,
          METACLAW_IMAGE_BASE_URL: input.baseUrl,
          METACLAW_IMAGE_API_KEY: input.apiKey,
          METACLAW_IMAGE_MODEL: input.modelId,
          METACLAW_IMAGE_PROMPT: input.prompt,
        },
        onLine: (line, stream) => {
          if (stream !== 'stdout') return;
          const event = parseEvent(line);
          if (!event) return;
          if (event.type === 'status' && typeof event.text === 'string') {
            input.onProgress?.(event.text);
            return;
          }
          if (event.type === 'result') terminal = parseTerminalResult(event);
        },
      });
      const finalResult = terminal as ImageApiRunnerResult | null;
      if (finalResult && result.exitCode === 0) return finalResult;
      if (finalResult?.success === false) return finalResult;
      return {
        success: false,
        output: '',
        error: result.stderr.trim()
          || `MetaWork image runner exited without a result (code ${result.exitCode ?? 'unknown'})`,
      };
    } finally {
      input.signal?.removeEventListener('abort', abort);
    }
  }

  abort(attemptId?: string): void {
    this.processRunner.abort(attemptId);
  }

  async probe(): Promise<{ available: boolean; failure: null }> {
    return { available: existsSync(resolveCommandFile(this.command)), failure: null };
  }
}

function parseEvent(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseTerminalResult(event: Record<string, unknown>): ImageApiRunnerResult | null {
  if (event.success === true && typeof event.output === 'string' && Array.isArray(event.artifactPaths)) {
    return {
      success: true,
      output: event.output,
      artifactPaths: event.artifactPaths.filter(
        (path): path is string => typeof path === 'string',
      ),
    };
  }
  if (event.success === false && typeof event.error === 'string') {
    return {
      success: false,
      output: typeof event.output === 'string' ? event.output : '',
      error: event.error,
    };
  }
  return null;
}

function resolveImageApiCliCommand(): ImageApiCliCommand {
  const configured = process.env.METAWORK_IMAGE_API_RUNNER_COMMAND?.trim();
  if (configured) {
    return isAbsolute(configured) && configured.endsWith('.js')
      ? { command: process.execPath, args: [configured] }
      : { command: configured, args: [] };
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(resolveMetaWorkPaths().appCurrent, 'dist', 'image-api-cli.js'),
    join(moduleDirectory, 'image-api-cli.js'),
    join(moduleDirectory, '..', 'image-api-cli.js'),
    join(process.cwd(), 'dist', 'image-api-cli.js'),
  ];
  const entrypoint = candidates.find(path => existsSync(path)) ?? candidates[0]!;
  return { command: process.execPath, args: [entrypoint] };
}

function resolveCommandFile(command: ImageApiCliCommand): string {
  return command.command === process.execPath && command.args[0]
    ? command.args[0]
    : command.command;
}
