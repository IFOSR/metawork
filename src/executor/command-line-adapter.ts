// Implements common child-process execution, progress parsing, timeout, and abort behavior for CLI executors.
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import type { ExecutorAdapter, ExecutorInput } from './adapter.js';
import type { ExecutorResult } from '../core/types.js';
import { buildExecutorContextPrompt } from './prompt-builder.js';
import { formatExecutorError, formatExecutorProgress, normalizeExecutorFailure } from './error-utils.js';

export interface CommandLineExecution {
  args: string[];
  captureStdout: boolean;
  readFinalOutput(stdout: string): string;
  cleanup(): void;
}

/** Base class for command-line executor adapters that run prompts through a child process. */
export abstract class CommandLineExecutorAdapter implements ExecutorAdapter {
  abstract readonly name: string;
  private readonly activeProcesses = new Map<string, {
    process: ChildProcess | null;
    abortRequested: boolean;
  }>();

  constructor(protected config: { command: string; timeout: number; maxDuration?: number; workspaceRoot?: string }) {}

  protected abstract buildSpawnArgs(prompt: string, input?: ExecutorInput): string[];

  protected prepareExecution(prompt: string, input?: ExecutorInput): CommandLineExecution {
    return {
      args: this.buildSpawnArgs(prompt, input),
      captureStdout: true,
      readFinalOutput: (stdout) => stdout.trim(),
      cleanup: () => undefined,
    };
  }

  protected buildSpawnEnv(_input?: ExecutorInput): NodeJS.ProcessEnv {
    return process.env;
  }

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const contextPrompt = this.buildContextPrompt(input);
    const startTime = Date.now();
    const attemptId = input.context.identity.attemptId;
    if (this.activeProcesses.has(attemptId)) {
      return {
        success: false,
        output: '',
        error: `attempt is already active: ${attemptId}`,
        failure: normalizeExecutorFailure(`attempt is already active: ${attemptId}`),
        exitCode: 1,
        durationMs: 0,
      };
    }
    const active = { process: null as ChildProcess | null, abortRequested: false };
    this.activeProcesses.set(attemptId, active);
    let execution: CommandLineExecution;

    try {
      execution = this.prepareExecution(contextPrompt, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activeProcesses.delete(attemptId);
      return {
        success: false,
        output: '',
        error: formatExecutorError(message) ?? message,
        failure: normalizeExecutorFailure(message),
        exitCode: 1,
        durationMs: Date.now() - startTime,
      };
    }

    return new Promise((resolve) => {
      input.onProgress?.({ kind: 'status', text: `已启动 ${this.name} 执行器` });
      let stdout = '';
      let stderr = '';
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let idleTimer: NodeJS.Timeout | null = null;
      let forceKillTimer: NodeJS.Timeout | null = null;
      let timeoutReason: 'idle' | null = null;
      let completed = false;

      const clearTimers = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
      };

      const complete = (result: ExecutorResult) => {
        if (completed) {
          return;
        }
        completed = true;
        clearTimers();
        try {
          execution.cleanup();
        } catch {
          // Cleanup is best effort and must not replace the execution result.
        }
        this.activeProcesses.delete(attemptId);
        resolve(result);
      };

      try {
        active.process = spawn(this.config.command, execution.args, {
          cwd: this.config.workspaceRoot ?? process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: this.buildSpawnEnv(input),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        complete({
          success: false,
          output: '',
          error: formatExecutorError(message) ?? message,
          failure: normalizeExecutorFailure(message),
          exitCode: 1,
          durationMs: Date.now() - startTime,
        });
        return;
      }

      const idleTimeoutMs = Math.max(this.config.timeout, 1) * 1000;

      const terminateForIdleTimeout = () => {
        if (!active.process || active.abortRequested || timeoutReason) {
          return;
        }
        timeoutReason = 'idle';
        active.process.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
          active.process?.kill('SIGKILL');
        }, 5_000);
      };

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(terminateForIdleTimeout, idleTimeoutMs);
      };

      resetIdleTimer();

      active.process.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (execution.captureStdout) {
          stdout += text;
        }
        resetIdleTimer();
        stdoutBuffer = this.emitProgressLines(stdoutBuffer + text, input);
      });
      active.process.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        resetIdleTimer();
        stderrBuffer = this.emitProgressLines(stderrBuffer + text, input);
      });

      active.process.on('close', (code) => {
        this.flushProgressBuffer(stdoutBuffer, input);
        this.flushProgressBuffer(stderrBuffer, input);
        const interrupted = active.abortRequested;
        let success = !interrupted && !timeoutReason && code === 0;
        let output = '';
        let error = success
          ? undefined
          : interrupted
            ? 'execution interrupted'
            : timeoutReason === 'idle'
              ? 'executor idle timeout'
              : formatExecutorError(stderr);

        if (success) {
          try {
            output = execution.readFinalOutput(stdout);
          } catch (readError) {
            success = false;
            const message = readError instanceof Error ? readError.message : String(readError);
            error = formatExecutorError(message) ?? message;
          }
        }

        complete({
          success,
          output,
          error,
          failure: success ? undefined : normalizeExecutorFailure(
            interrupted ? 'execution interrupted' : timeoutReason === 'idle' ? 'executor idle timeout' : stderr,
            interrupted,
          ),
          exitCode: code ?? 1,
          durationMs: Date.now() - startTime,
          interrupted,
        });
      });

      active.process.on('error', (err) => {
        complete({
          success: false,
          output: '',
          error: formatExecutorError(err.message) ?? err.message,
          failure: normalizeExecutorFailure(err.message),
          exitCode: 1,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }

  protected buildContextPrompt(input: ExecutorInput): string {
    return buildExecutorContextPrompt(input);
  }

  protected observeOutputLine(_line: string, _input: ExecutorInput): void {}

  async isAvailable(): Promise<boolean> {
    try {
      const result = spawnSync('which', [this.config.command]);
      return result.status === 0;
    } catch {
      return false;
    }
  }

  abort(attemptId?: string): void {
    const targets = attemptId
      ? [this.activeProcesses.get(attemptId)].filter((item): item is {
          process: ChildProcess | null;
          abortRequested: boolean;
        } => Boolean(item))
      : [...this.activeProcesses.values()];
    for (const target of targets) {
      target.abortRequested = true;
      target.process?.kill('SIGTERM');
    }
  }

  private emitProgressLines(buffer: string, input: ExecutorInput): string {
    const lines = buffer.split(/\r?\n/);
    const pending = lines.pop() ?? '';

    for (const line of lines) {
      this.observeOutputLine(line, input);
      const progress = formatExecutorProgress(line);
      if (progress) {
        input.onProgress?.({ kind: 'log', text: progress });
      }
    }

    return pending;
  }

  private flushProgressBuffer(buffer: string, input: ExecutorInput): void {
    this.observeOutputLine(buffer, input);
    const progress = formatExecutorProgress(buffer);
    if (progress) {
      input.onProgress?.({ kind: 'log', text: progress });
    }
  }
}
