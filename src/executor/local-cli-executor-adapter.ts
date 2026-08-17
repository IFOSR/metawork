import { spawn, type ChildProcess } from 'node:child_process';
import type { RuntimePrivateConfigurationBinding } from '../configuration/types.js';
import type { ExecutorResult } from '../core/types.js';
import type { ExecutorAdapter, ExecutorInput, ExecutorProbeResult } from './adapter.js';
import { normalizeExecutorFailure } from './error-utils.js';
import type { HarnessDriver, HarnessLaunchSpec } from './harness-driver.js';
import { safeHostEnvironment } from './harness-driver.js';
import { buildExecutorContextPrompt } from './prompt-builder.js';

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

export interface LocalCliChildProcessInput extends HarnessLaunchSpec {
  attemptId: string;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface LocalCliChildProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface LocalCliChildProcessRunner {
  run(input: LocalCliChildProcessInput): Promise<LocalCliChildProcessResult>;
  abort(attemptId?: string): void;
}

export interface LocalCliExecutorAdapterDependencies {
  agentClassId: string;
  driver: HarnessDriver;
  runtimeBinding: RuntimePrivateConfigurationBinding;
  attemptsRoot: string;
  processRunner?: LocalCliChildProcessRunner;
}

type LocalCliSpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['ignore', 'pipe', 'pipe'];
    detached: boolean;
    windowsHide: boolean;
  },
) => ChildProcess;

export interface SpawnLocalCliChildProcessRunnerDependencies {
  spawnProcess?: LocalCliSpawn;
  hostEnvironment?: NodeJS.ProcessEnv;
}

export class LocalCliExecutorAdapter implements ExecutorAdapter {
  readonly name: string;
  readonly supportsContinuation = false;
  private readonly driver: HarnessDriver;
  private readonly runtimeBinding: RuntimePrivateConfigurationBinding;
  private readonly attemptsRoot: string;
  private readonly processRunner: LocalCliChildProcessRunner;

  constructor(dependencies: LocalCliExecutorAdapterDependencies) {
    this.name = dependencies.agentClassId;
    this.driver = dependencies.driver;
    this.runtimeBinding = dependencies.runtimeBinding;
    this.attemptsRoot = dependencies.attemptsRoot;
    this.processRunner = dependencies.processRunner ?? new SpawnLocalCliChildProcessRunner();
  }

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const startedAt = Date.now();
    const executionBinding = input.executionBinding;
    if (!executionBinding) {
      return configurationFailure(
        'execution binding is required',
        'execution_binding_missing',
        startedAt,
      );
    }

    try {
      const runtimeHome = await this.driver.materializeHome({
        attemptId: executionBinding.attemptId,
        revisionId: this.runtimeBinding.revisionId,
        agentClassId: this.name,
        bindingFingerprint: this.runtimeBinding.bindingFingerprint,
        attemptsRoot: this.attemptsRoot,
        environment: this.runtimeBinding.environment ?? {},
      });
      const launch = this.driver.buildLaunch({
        prompt: buildExecutorContextPrompt(input),
        cwd: executionBinding.workspacePath,
        runtimeHomePath: runtimeHome.homePath,
      });
      let streamedOutput: string | null = null;
      const rawResult = await this.processRunner.run({
        attemptId: executionBinding.attemptId,
        command: launch.command,
        args: [...launch.args],
        cwd: launch.cwd,
        environment: {
          ...this.runtimeBinding.environment,
          ...runtimeHome.environment,
          ...launch.environment,
        },
        onLine: (line, stream) => {
          const resultLine = this.driver.parseResultLine?.({ line, stream });
          if (resultLine !== null && resultLine !== undefined) {
            streamedOutput = resultLine;
          }
          const progress = this.driver.parseProgressLine?.({ line, stream });
          if (progress) input.onProgress?.(progress);
        },
      });
      const result = this.driver.parseResult(streamedOutput === null
        ? rawResult
        : { ...rawResult, streamedOutput });
      const exitCode = rawResult.exitCode ?? (result.success ? 0 : 1);
      if (result.success) {
        return {
          success: true,
          output: result.output,
          exitCode,
          durationMs: Date.now() - startedAt,
        };
      }
      return {
        success: false,
        output: '',
        error: result.error,
        failure: normalizeExecutorFailure(result.error),
        exitCode,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: message,
        failure: normalizeExecutorFailure(message),
        exitCode: 1,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  async probe(): Promise<ExecutorProbeResult> {
    try {
      const result = await this.driver.probe();
      if (result.available) return { available: true, failure: null };
      const summary = result.detail?.trim() || `Harness driver is unavailable: ${this.driver.id}`;
      return {
        available: false,
        failure: normalizeExecutorFailure(summary),
      };
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        failure: normalizeExecutorFailure(summary),
      };
    }
  }

  abort(attemptId?: string): void {
    this.processRunner.abort(attemptId);
  }
}

export class SpawnLocalCliChildProcessRunner implements LocalCliChildProcessRunner {
  private readonly activeProcesses = new Map<string, ChildProcess>();
  private readonly spawnProcess: LocalCliSpawn;
  private readonly hostEnvironment: NodeJS.ProcessEnv;

  constructor(dependencies: SpawnLocalCliChildProcessRunnerDependencies = {}) {
    this.spawnProcess = dependencies.spawnProcess ?? spawn;
    this.hostEnvironment = dependencies.hostEnvironment ?? process.env;
  }

  run(input: LocalCliChildProcessInput): Promise<LocalCliChildProcessResult> {
    if (this.activeProcesses.has(input.attemptId)) {
      return Promise.reject(new Error(`local CLI attempt is already running: ${input.attemptId}`));
    }

    return new Promise(resolve => {
      const child = this.spawnProcess(input.command, input.args, {
        cwd: input.cwd,
        env: {
          ...safeHostEnvironment(this.hostEnvironment),
          ...input.environment,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      this.activeProcesses.set(input.attemptId, child);
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let stdoutLineBuffer = '';
      let stderrLineBuffer = '';
      let settled = false;
      const appendStdout = (chunk: Buffer | string) => {
        stdout = appendBoundedTail(stdout, chunk);
        stdoutLineBuffer = emitCompleteLines(
          stdoutLineBuffer,
          chunk,
          line => input.onLine?.(line, 'stdout'),
        );
      };
      const appendStderr = (chunk: Buffer | string) => {
        stderr = appendBoundedTail(stderr, chunk);
        stderrLineBuffer = emitCompleteLines(
          stderrLineBuffer,
          chunk,
          line => input.onLine?.(line, 'stderr'),
        );
      };
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        if (stdoutLineBuffer.trim()) input.onLine?.(stdoutLineBuffer, 'stdout');
        if (stderrLineBuffer.trim()) input.onLine?.(stderrLineBuffer, 'stderr');
        if (this.activeProcesses.get(input.attemptId) === child) {
          this.activeProcesses.delete(input.attemptId);
        }
        resolve({
          exitCode,
          stdout: decodeBoundedCapture(stdout),
          stderr: decodeBoundedCapture(stderr),
        });
      };

      child.stdout?.on('data', appendStdout);
      child.stderr?.on('data', appendStderr);
      child.once('error', error => {
        appendStderr(error instanceof Error ? error.message : String(error));
        finish(null);
      });
      child.once('exit', code => finish(code));
    });
  }

  abort(attemptId?: string): void {
    const processes = attemptId
      ? [this.activeProcesses.get(attemptId)].filter((child): child is ChildProcess => Boolean(child))
      : [...this.activeProcesses.values()];
    for (const child of processes) {
      const pid = child.pid;
      if (!pid) continue;
      try {
        if (process.platform === 'win32') child.kill('SIGTERM');
        else process.kill(-pid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
}

function appendBoundedTail(current: Buffer, chunk: Buffer | string): Buffer {
  const incoming = Buffer.from(chunk);
  if (incoming.length >= MAX_CAPTURE_BYTES) {
    return incoming.subarray(incoming.length - MAX_CAPTURE_BYTES);
  }
  const retainedBytes = MAX_CAPTURE_BYTES - incoming.length;
  const retained = current.length > retainedBytes
    ? current.subarray(current.length - retainedBytes)
    : current;
  return Buffer.concat([retained, incoming]);
}

function decodeBoundedCapture(value: Buffer): string {
  let start = 0;
  while (start < value.length && (value[start]! & 0xc0) === 0x80) start += 1;
  return value.subarray(start).toString('utf8');
}

function emitCompleteLines(
  current: string,
  chunk: Buffer | string,
  emit: (line: string) => void,
): string {
  const combined = current + Buffer.from(chunk).toString('utf8');
  const lines = combined.split(/\r?\n/u);
  const remainder = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim()) emit(line);
  }
  return remainder;
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
