import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { RuntimePrivateConfigurationBinding } from '../configuration/types.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { ExecutorResult } from '../core/types.js';
import type { ExecutorAdapter, ExecutorInput, ExecutorProbeResult } from './adapter.js';
import { normalizeExecutorFailure } from './error-utils.js';
import type { HarnessDriver, HarnessLaunchSpec } from './harness-driver.js';
import { safeHostEnvironment } from './harness-driver.js';
import { buildExecutorContextPrompt } from './prompt-builder.js';
import type { ExecutorAffordanceId } from '../routing/types.js';

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const DEFAULT_EXECUTOR_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;

export interface LocalCliChildProcessInput extends HarnessLaunchSpec {
  attemptId: string;
  idleTimeoutMs?: number;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  onRawChunk?: (chunk: Buffer | string, stream: 'stdout' | 'stderr') => void;
}

export interface LocalCliChildProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  diagnostics?: LocalCliProcessDiagnostics;
}

export interface LocalCliProcessDiagnostics {
  startedAt: string;
  completedAt: string;
  lastStdoutAt: string | null;
  lastStderrAt: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  terminationSource: 'process_exit' | 'process_error' | 'idle_watchdog' | 'abort';
  sigtermSentAt: string | null;
  sigkillSentAt: string | null;
  exitCode: number | null;
}

export interface LocalCliChildProcessRunner {
  run(input: LocalCliChildProcessInput): Promise<LocalCliChildProcessResult>;
  abort(attemptId?: string): void;
}

export interface LocalCliExecutorAdapterDependencies {
  agentClassId: string;
  driver: HarnessDriver;
  runtimeBinding: RuntimePrivateConfigurationBinding;
  authorizedBinding: AuthorizedExecutorBinding;
  modelId: string;
  executorAffordances?: readonly ExecutorAffordanceId[];
  attemptsRoot: string;
  idleTimeoutMs?: number;
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
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  terminationGraceMs?: number;
}

export class LocalCliExecutorAdapter implements ExecutorAdapter {
  readonly name: string;
  readonly supportsContinuation = false;
  private readonly driver: HarnessDriver;
  private readonly runtimeBinding: RuntimePrivateConfigurationBinding;
  private readonly authorizedBinding: AuthorizedExecutorBinding;
  private readonly modelId: string;
  private readonly executorAffordances?: readonly ExecutorAffordanceId[];
  private readonly attemptsRoot: string;
  private readonly idleTimeoutMs: number;
  private readonly processRunner: LocalCliChildProcessRunner;

  constructor(dependencies: LocalCliExecutorAdapterDependencies) {
    this.name = dependencies.agentClassId;
    this.driver = dependencies.driver;
    this.runtimeBinding = dependencies.runtimeBinding;
    this.authorizedBinding = dependencies.authorizedBinding;
    this.modelId = dependencies.modelId;
    this.executorAffordances = dependencies.executorAffordances;
    this.attemptsRoot = dependencies.attemptsRoot;
    this.idleTimeoutMs = dependencies.idleTimeoutMs ?? DEFAULT_EXECUTOR_IDLE_TIMEOUT_MS;
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
        ...(this.executorAffordances
          ? { executorAffordances: this.executorAffordances }
          : {}),
      });
      const launch = this.driver.buildLaunch({
        prompt: buildExecutorContextPrompt(input),
        cwd: executionBinding.workspacePath,
        runtimeHomePath: runtimeHome.homePath,
        executionTarget: 'host',
        providerRef: this.authorizedBinding.providerRef,
        modelId: this.modelId,
        ...(input.context.currentSubtask.requiredCapabilities.length > 0
          ? { requiredCapabilities: input.context.currentSubtask.requiredCapabilities }
          : {}),
      });
      let streamedOutput: string | null = null;
      const streamTracker = this.driver.createResultStreamTracker?.();
      const rawResult = await this.processRunner.run({
        attemptId: executionBinding.attemptId,
        command: launch.command,
        args: [...launch.args],
        cwd: launch.cwd,
        idleTimeoutMs: this.idleTimeoutMs,
        environment: {
          ...this.runtimeBinding.environment,
          ...runtimeHome.environment,
          ...launch.environment,
          METACLAW_EVIDENCE_MCP_URL: input.context.evidenceTools.binding?.mcpUrl ?? '',
          METACLAW_EVIDENCE_JSON_URL: input.context.evidenceTools.binding?.jsonUrl ?? '',
          METACLAW_EVIDENCE_TOKEN: input.context.evidenceTools.binding?.bearerToken ?? '',
          METACLAW_INPUTS_PATH: executionBinding.inputsPath,
          METACLAW_IMAGE_OPERATION: input.context.currentSubtask.requiredCapabilities.includes('image-editing')
            ? 'editing'
            : 'generation',
        },
        onLine: (line, stream) => {
          streamTracker?.observe({ line, stream });
          const resultLine = this.driver.parseResultLine?.({ line, stream });
          if (resultLine !== null && resultLine !== undefined) {
            streamedOutput = resultLine;
          }
          const progress = this.driver.parseProgressLine?.({ line, stream });
          if (progress) input.onProgress?.(progress);
        },
        onRawChunk: (chunk, stream) => input.onRawOutput?.(Buffer.from(chunk), stream),
      });
      const streamSnapshot = streamTracker?.snapshot();
      if (streamSnapshot?.output) streamedOutput = streamSnapshot.output;
      const parsedResult = this.driver.parseResult(streamedOutput === null
        ? rawResult
        : { ...rawResult, streamedOutput });
      const result = streamSnapshot?.provisional && parsedResult.success
        ? {
            success: false as const,
            output: streamSnapshot.output ?? '',
            error: 'Harness adapter assistant response stream ended before completion',
          }
        : parsedResult;
      const exitCode = rawResult.exitCode ?? (result.success ? 0 : 1);
      const diagnostics = {
        providerRef: this.authorizedBinding.providerRef,
        modelId: this.modelId,
        process: rawResult.diagnostics ?? null,
        harness: streamSnapshot?.diagnostics ?? null,
        provisionalOutput: streamSnapshot?.provisional ?? false,
      };
      if (result.success) {
        return {
          success: true,
          output: result.output,
          exitCode,
          durationMs: Date.now() - startedAt,
          diagnostics,
        };
      }
      return {
        success: false,
        output: result.output,
        error: result.error,
        failure: normalizeExecutorFailure(result.error),
        exitCode,
        durationMs: Date.now() - startedAt,
        diagnostics,
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

  async executeResponseOnly(input: {
    attemptId?: string;
    prompt: string;
    maxBytes: number;
  }): Promise<ExecutorResult> {
    const startedAt = Date.now();
    if (!this.driver.supportsResponseOnly) {
      return configurationFailure(
        'Harness driver does not support response-only correction',
        'response_only_unsupported',
        startedAt,
      );
    }

    const attemptId = input.attemptId ?? `response-only-${randomUUID()}`;
    try {
      const runtimeHome = await this.driver.materializeHome({
        attemptId,
        revisionId: this.runtimeBinding.revisionId,
        agentClassId: this.name,
        bindingFingerprint: this.runtimeBinding.bindingFingerprint,
        attemptsRoot: this.attemptsRoot,
        environment: this.runtimeBinding.environment ?? {},
      });
      const launch = this.driver.buildLaunch({
        prompt: input.prompt,
        cwd: runtimeHome.homePath,
        runtimeHomePath: runtimeHome.homePath,
        executionTarget: 'host',
        providerRef: this.authorizedBinding.providerRef,
        modelId: this.modelId,
        responseOnly: true,
      });
      const rawResult = await this.processRunner.run({
        attemptId,
        command: launch.command,
        args: [...launch.args],
        cwd: launch.cwd,
        idleTimeoutMs: this.idleTimeoutMs,
        environment: {
          ...this.runtimeBinding.environment,
          ...runtimeHome.environment,
          ...launch.environment,
        },
      });
      const parsed = this.driver.parseResult(rawResult);
      const exitCode = rawResult.exitCode ?? (parsed.success ? 0 : 1);
      if (Buffer.byteLength(parsed.output, 'utf8') > input.maxBytes) {
        const message = `response-only correction exceeded ${input.maxBytes} bytes`;
        return {
          success: false,
          output: '',
          error: message,
          failure: normalizeExecutorFailure(message),
          exitCode,
          durationMs: Date.now() - startedAt,
        };
      }
      return {
        ...parsed,
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
  private readonly activeProcesses = new Map<string, {
    child: ChildProcess;
    abort(): void;
  }>();
  private readonly spawnProcess: LocalCliSpawn;
  private readonly hostEnvironment: NodeJS.ProcessEnv;
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly terminationGraceMs: number;

  constructor(dependencies: SpawnLocalCliChildProcessRunnerDependencies = {}) {
    this.spawnProcess = dependencies.spawnProcess ?? spawn;
    this.hostEnvironment = dependencies.hostEnvironment ?? process.env;
    this.signalProcess = dependencies.signalProcess ?? process.kill;
    this.terminationGraceMs = dependencies.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
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
      const startedAt = new Date().toISOString();
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let lastStdoutAt: string | null = null;
      let lastStderrAt: string | null = null;
      let stdoutLineBuffer = '';
      let stderrLineBuffer = '';
      let settled = false;
      let timedOut = false;
      let terminationSource: LocalCliProcessDiagnostics['terminationSource'] = 'process_exit';
      let sigtermSentAt: string | null = null;
      let sigkillSentAt: string | null = null;
      let idleTimer: NodeJS.Timeout | null = null;
      let forceKillTimer: NodeJS.Timeout | null = null;
      const signalChild = (signal: NodeJS.Signals) => {
        const pid = child.pid;
        if (!pid) return;
        try {
          this.signalProcess(process.platform === 'win32' ? pid : -pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      };
      const clearWatchdogs = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        idleTimer = null;
        forceKillTimer = null;
      };
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearWatchdogs();
        if (stdoutLineBuffer.trim()) input.onLine?.(stdoutLineBuffer, 'stdout');
        if (stderrLineBuffer.trim()) input.onLine?.(stderrLineBuffer, 'stderr');
        if (this.activeProcesses.get(input.attemptId)?.child === child) {
          this.activeProcesses.delete(input.attemptId);
        }
        resolve({
          exitCode,
          stdout: decodeBoundedCapture(stdout),
          stderr: decodeBoundedCapture(stderr),
          diagnostics: {
            startedAt,
            completedAt: new Date().toISOString(),
            lastStdoutAt,
            lastStderrAt,
            stdoutBytes,
            stderrBytes,
            terminationSource,
            sigtermSentAt,
            sigkillSentAt,
            exitCode,
          },
        });
      };
      const expireIdleWatchdog = () => {
        if (settled || timedOut) return;
        timedOut = true;
        terminationSource = 'idle_watchdog';
        const diagnostic = 'executor idle timeout\n';
        stderr = appendBoundedTail(stderr, diagnostic);
        stderrLineBuffer = emitCompleteLines(
          stderrLineBuffer,
          diagnostic,
          line => input.onLine?.(line, 'stderr'),
        );
        sigtermSentAt = new Date().toISOString();
        signalChild('SIGTERM');
        forceKillTimer = setTimeout(() => {
          sigkillSentAt = new Date().toISOString();
          signalChild('SIGKILL');
          finish(null);
        }, this.terminationGraceMs);
        forceKillTimer.unref();
      };
      const resetIdleWatchdog = () => {
        const timeoutMs = input.idleTimeoutMs;
        if (
          settled
          || timedOut
          || timeoutMs === undefined
          || !Number.isFinite(timeoutMs)
          || timeoutMs <= 0
        ) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(expireIdleWatchdog, timeoutMs);
        idleTimer.unref();
      };
      const appendStdout = (chunk: Buffer | string) => {
        resetIdleWatchdog();
        stdoutBytes += Buffer.byteLength(chunk);
        lastStdoutAt = new Date().toISOString();
        input.onRawChunk?.(chunk, 'stdout');
        stdout = appendBoundedTail(stdout, chunk);
        stdoutLineBuffer = emitCompleteLines(
          stdoutLineBuffer,
          chunk,
          line => input.onLine?.(line, 'stdout'),
        );
      };
      const appendStderr = (chunk: Buffer | string) => {
        resetIdleWatchdog();
        stderrBytes += Buffer.byteLength(chunk);
        lastStderrAt = new Date().toISOString();
        input.onRawChunk?.(chunk, 'stderr');
        stderr = appendBoundedTail(stderr, chunk);
        stderrLineBuffer = emitCompleteLines(
          stderrLineBuffer,
          chunk,
          line => input.onLine?.(line, 'stderr'),
        );
      };

      child.stdout?.on('data', appendStdout);
      child.stderr?.on('data', appendStderr);
      child.once('error', error => {
        terminationSource = 'process_error';
        appendStderr(error instanceof Error ? error.message : String(error));
        finish(null);
      });
      child.once('exit', code => finish(code));
      this.activeProcesses.set(input.attemptId, {
        child,
        abort: () => {
          if (settled) return;
          terminationSource = 'abort';
          sigtermSentAt = new Date().toISOString();
          signalChild('SIGTERM');
        },
      });
      resetIdleWatchdog();
    });
  }

  abort(attemptId?: string): void {
    const processes = attemptId
      ? [this.activeProcesses.get(attemptId)].filter(
          (entry): entry is { child: ChildProcess; abort(): void } => Boolean(entry),
        )
      : [...this.activeProcesses.values()];
    for (const activeProcess of processes) activeProcess.abort();
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
