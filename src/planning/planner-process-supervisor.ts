import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAnyFusionPaths } from '../installation/paths.js';
import { resolveCurrentRuntimeHome } from '../configuration/agent-runtime-renderer.js';
import { buildEnvFromFile } from '../utils/env-file.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import { truncateText } from '../utils/truncate-text.js';
import type { PlanningContext } from './planning-types.js';
import type { PlannerProposalPurpose, PlannerProposalResult } from './planner-proposal.js';
import type {
  PlannerRunProgress,
  PlannerRunProgressObserver,
  PlannerRunProgressPayload,
} from './planner-progress.js';
import { buildPlannerMcpLaunchEnv } from './planner-mcp-launch-env.js';
import {
  PlannerRunError,
  type PlannerRunResult,
  type PlannerToolCallTrace,
} from './planner-audit-contract.js';

const MAX_RPC_LINE_BYTES = 1024 * 1024;
const SENSITIVE_PROGRESS_FIELD =
  /(?:^|[_-])(secret|token|password|passwd|credential|authorization|private[_-]?key|api[_-]?key|prompt|conversation|content|reasoning|thoughts?|signature)(?:$|[_-])/iu;

export interface PlannerRunner {
  run(
    prompt: string,
    context: PlanningContext,
    purpose: PlannerProposalPurpose,
    onProgress?: PlannerRunProgressObserver,
  ): Promise<PlannerRunResult>;
}

export interface PlannerProcessController extends PlannerRunner {
  stop(): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
}

type SpawnFn = typeof spawn;

export interface PlannerProcessSupervisorDeps {
  command?: string;
  spawn?: SpawnFn;
  plannerHome?: string;
  cwd?: string;
  envFile?: string;
  sessionDir?: string;
  args?: string[];
  interactiveArgs?: string[];
  socketPath?: string;
  schemaPath?: string;
  configurationRevision?: string;
  shutdownGraceMs?: number;
  ensureSessionDir?: (path: string) => Promise<void>;
}

interface TrackedPlannerProcess {
  sessionId: string;
  termination: Promise<void>;
  stopRequested: boolean;
  stopPromise?: Promise<void>;
}

/**
 * Controlled-lifecycle JSONL RPC adapter for non-interactive Planner surfaces.
 * Each run owns one Pi process and one session writer. Runs targeting the same
 * session are serialized so Gateway/Feishu cannot corrupt the Pi session file.
 */
export class PlannerProcessSupervisor implements PlannerProcessController {
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly closedSessions = new Set<string>();
  private readonly activeProcesses = new Set<ChildProcess>();
  private readonly trackedProcesses = new Map<ChildProcess, TrackedPlannerProcess>();
  private stopping = false;

  constructor(private readonly deps: PlannerProcessSupervisorDeps = {}) {}

  async run(
    prompt: string,
    context: PlanningContext,
    purpose: PlannerProposalPurpose,
    onProgress?: PlannerRunProgressObserver,
  ): Promise<PlannerRunResult> {
    return this.runRpcTurn({
      sessionId: context.request.sessionId,
      cwd: this.deps.cwd,
      prompt,
      context,
      purpose,
      onProgress,
    });
  }

  async runRpcTurn(input: {
    sessionId: string;
    cwd?: string;
    prompt: string;
    context: PlanningContext;
    purpose: PlannerProposalPurpose;
    onProgress?: PlannerRunProgressObserver;
  }): Promise<PlannerRunResult> {
    if (input.context.request.sessionId !== input.sessionId) {
      throw new Error('Planner RPC sessionId must match PlanningContext');
    }
    const sessionId = input.sessionId;
    this.assertSessionOpen(sessionId);
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.sessionQueues.set(sessionId, tail);
    await previous.catch(() => undefined);

    try {
      this.assertSessionOpen(sessionId);
      return await this.runRpc(input.prompt, {
        ...input.context,
        request: { ...input.context.request, sessionId: input.sessionId },
      }, input.purpose, input.cwd, input.onProgress);
    } finally {
      release();
      if (this.sessionQueues.get(sessionId) === tail) {
        this.sessionQueues.delete(sessionId);
      }
    }
  }

  async startInteractive(input: {
    sessionId: string;
    cwd: string;
    configurationRevision?: string;
  }): Promise<void> {
    this.assertSessionOpen(input.sessionId);
    const launch = await this.resolveLaunch(
      input.sessionId,
      input.cwd,
      'interactive',
      'kernel',
      'session',
      input.configurationRevision,
    );
    this.assertSessionOpen(input.sessionId);
    const child = (this.deps.spawn ?? spawn)(launch.command, launch.args, {
      cwd: launch.cwd,
      stdio: 'inherit',
      env: launch.env,
    });
    const tracked = this.trackProcess(child, input.sessionId);
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if ((result.code !== null && result.code !== 0)
      || (result.signal !== null && !tracked.stopRequested)) {
      throw new Error(
        `AnyFusion Planner interactive process exited with ${result.code ?? 'unknown'} (${result.signal ?? 'no signal'})`,
      );
    }
  }

  async probe(): Promise<{ available: boolean; detail: string }> {
    const launch = await this.resolveLaunch(
      'probe',
      this.deps.cwd,
      'probe',
      'kernel',
      'session',
      this.deps.configurationRevision,
    );
    this.assertSessionOpen('probe');
    const child = (this.deps.spawn ?? spawn)(launch.command, ['--version'], {
      cwd: launch.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: launch.env,
    });
    this.trackProcess(child, 'probe');
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', exitCode => resolve(exitCode));
    });
    return code === 0
      ? { available: true, detail: stdout.trim() }
      : { available: false, detail: redactSensitiveText(stderr.trim() || `exit ${code ?? 'unknown'}`) };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.terminateProcesses([...this.activeProcesses]);
  }

  async stopSession(sessionId: string): Promise<void> {
    this.closedSessions.add(sessionId);
    await this.terminateProcesses(
      [...this.activeProcesses].filter(child => this.trackedProcesses.get(child)?.sessionId === sessionId),
    );
  }

  private async runRpc(
    prompt: string,
    context: PlanningContext,
    purpose: PlannerProposalPurpose,
    cwdOverride?: string,
    onProgress?: PlannerRunProgressObserver,
  ): Promise<PlannerRunResult> {
    const startedAt = Date.now();
    const launch = await this.resolveLaunch(
      context.request.sessionId,
      cwdOverride,
      'rpc',
      purpose,
      context.request.source,
      context.configuration?.revisionId ?? this.deps.configurationRevision,
    );
    this.assertSessionOpen(context.request.sessionId);
    const sessionPath = join(launch.sessionDir, `${context.request.sessionId}.jsonl`);
    const requestId = `planner-${context.request.sessionId}-${startedAt}`;

    return new Promise((resolve, reject) => {
      const proc = (this.deps.spawn ?? spawn)(launch.command, launch.args, {
        cwd: launch.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: launch.env,
      });
      this.trackProcess(proc, context.request.sessionId);
      let stdoutBuffer = '';
      let stderr = '';
      let settled = false;
      let promptAccepted = false;
      let pendingResult: PlannerRunResult | null = null;
      let terminalProposalResult: PlannerProposalResult | null = null;
      let submittedPlan: unknown;
      const toolCalls: PlannerToolCallTrace[] = [];
      const toolStarts = new Map<string, Record<string, unknown>>();
      const toolSequences = new Map<string, number>();
      let progressSequence = 0;
      let turn = 0;
      let modelStreamTurn = 0;
      const reportProgress = (progress: PlannerRunProgressPayload) => {
        if (!onProgress) return;
        progressSequence += 1;
        try {
          onProgress({
            ...progress,
            sequence: progressSequence,
            elapsedMs: Date.now() - startedAt,
          } as PlannerRunProgress);
        } catch {
          // Presentation observers cannot affect Planner execution.
        }
      };
      reportProgress({ kind: 'process_started' });

      const timer = setTimeout(() => {
        fail(new Error(`AnyFusion Planner RPC timed out after ${context.timeoutMs}ms`));
      }, context.timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        proc.stdout?.removeAllListeners();
        proc.stderr?.removeAllListeners();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        const plannerError = error instanceof PlannerRunError
          ? error
          : new PlannerRunError(error.message, {
            toolCalls: [...toolCalls],
            threadId: sessionPath,
            durationMs: Date.now() - startedAt,
            cause: error,
          });
        void this.terminateProcess(proc).then(
          () => reject(plannerError),
          () => reject(plannerError),
        );
      };
      const acceptLine = (line: string) => {
        if (!line.trim()) return;
        let event: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isRecord(parsed)) throw new Error('event must be an object');
          event = parsed;
        } catch (error) {
          fail(new Error(`AnyFusion Planner RPC emitted malformed JSONL: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
        if (event.type === 'response' && event.id === requestId && event.command === 'prompt') {
          if (event.success !== true) {
            fail(new Error(`AnyFusion Planner rejected the prompt: ${truncateText(redactSensitiveText(String(event.error ?? "unknown error")), 500)}`));
            return;
          }
          promptAccepted = true;
          reportProgress({ kind: 'prompt_accepted' });
          return;
        }
        if (event.type === 'agent_start') {
          reportProgress({ kind: 'agent_started' });
          return;
        }
        if (event.type === 'turn_start') {
          turn += 1;
          reportProgress({ kind: 'turn_started', turn });
          return;
        }
        if (
          (event.type === 'message_start' && isAssistantMessage(event.message))
          || event.type === 'message_update'
        ) {
          if (turn > modelStreamTurn) {
            modelStreamTurn = turn;
            reportProgress({ kind: 'model_stream_started', turn });
          }
          return;
        }
        if (event.type === 'tool_execution_start') {
          const toolCallId = String(event.toolCallId ?? toolStarts.size + 1);
          toolStarts.set(toolCallId, event);
          const toolSequence = toolSequences.size + 1;
          toolSequences.set(toolCallId, toolSequence);
          reportProgress({
            kind: 'tool_started',
            toolSequence,
            toolName: String(event.toolName ?? 'unknown'),
            argumentFields: recordFields(event.args),
          });
          if (event.toolName === 'submit_planning_proposal' && isRecord(event.args)) {
            submittedPlan = event.args.plan;
          }
          return;
        }
        if (event.type === 'tool_execution_end') {
          const toolCallId = String(event.toolCallId ?? toolCalls.length + 1);
          const start = toolStarts.get(toolCallId);
          const toolName = String(event.toolName ?? start?.toolName ?? 'unknown');
          const toolSequence = toolSequences.get(toolCallId) ?? toolCalls.length + 1;
          toolCalls.push({
            sequence: toolCalls.length + 1,
            toolName,
            status: event.isError === true ? 'failed' : 'completed',
            argumentsSummary: summarizeValue(start?.args),
            resultSummary: summarizeValue(event.result),
          });
          reportProgress({
            kind: 'tool_completed',
            toolSequence,
            toolName,
            argumentFields: recordFields(start?.args),
            resultFields: recordFields(event.result),
            status: event.isError === true ? 'failed' : 'completed',
          });
          if (toolName === 'submit_planning_proposal') {
            const proposalResult = extractPlannerProposalResult(event.result);
            if (proposalResult) terminalProposalResult = proposalResult;
          }
          return;
        }
        if (event.type === 'agent_end') {
          if (terminalProposalResult) {
            reportProgress({ kind: 'agent_completed' });
            pendingResult = {
              proposalResult: terminalProposalResult,
              submittedPlan,
              toolCalls,
              threadId: sessionPath,
              durationMs: Date.now() - startedAt,
            };
            proc.stdin?.end();
            return;
          }
          const modelError = extractPlannerModelError(event);
          if (modelError) {
            fail(new Error(
              `AnyFusion Planner model failed: ${truncateText(redactSensitiveText(modelError), 500)}`,
            ));
            return;
          }
          fail(new Error('AnyFusion Planner RPC completed without a submit_planning_proposal tool result'));
        }
      };

      proc.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return;
        stdoutBuffer += chunk.toString();
        let newline = stdoutBuffer.indexOf('\n');
        while (newline >= 0 && !settled) {
          const line = stdoutBuffer.slice(0, newline).replace(/\r$/u, '');
          if (Buffer.byteLength(line, 'utf8') > MAX_RPC_LINE_BYTES) {
            fail(new Error(`AnyFusion Planner RPC exceeded the ${MAX_RPC_LINE_BYTES}-byte JSONL limit`));
            return;
          }
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          acceptLine(line);
          newline = stdoutBuffer.indexOf('\n');
        }
        if (Buffer.byteLength(stdoutBuffer, 'utf8') > MAX_RPC_LINE_BYTES) {
          fail(new Error(`AnyFusion Planner RPC exceeded the ${MAX_RPC_LINE_BYTES}-byte JSONL limit`));
        }
      });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.on('error', (error) => fail(error));
      proc.on('close', (code, signal) => {
        if (settled) return;
        if (stdoutBuffer.trim()) acceptLine(stdoutBuffer.replace(/\r$/u, ''));
        if (settled) return;
        if (code !== 0) {
          fail(new Error(
            `AnyFusion Planner RPC exited with ${code ?? 'unknown'} (${signal ?? 'no signal'}): ${truncateText(redactSensitiveText(stderr), 500)}`,
          ));
          return;
        }
        if (!promptAccepted) {
          fail(new Error('AnyFusion Planner RPC exited before accepting the prompt'));
          return;
        }
        if (!pendingResult) {
          fail(new Error('AnyFusion Planner RPC exited before completing the turn'));
          return;
        }
        settled = true;
        cleanup();
        resolve(pendingResult);
      });

      proc.stdin?.on('error', error => fail(error));
      proc.stdin?.write(`${JSON.stringify({ id: requestId, type: 'prompt', message: prompt })}\n`);
    });
  }

  private async resolveLaunch(
    sessionId: string,
    cwdOverride: string | undefined,
    mode: 'interactive' | 'rpc' | 'probe',
    purpose: PlannerProposalPurpose = 'kernel',
    requestSource = 'session',
    configurationRevision = this.deps.configurationRevision
      ?? process.env.METACLAW_CONFIGURATION_REVISION,
  ): Promise<{
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    sessionDir: string;
  }> {
    const command = this.resolveCommand();
    const cwd = cwdOverride ?? this.deps.cwd ?? process.env.METACLAW_PLANNER_WORKDIR ?? process.cwd();
    const authorizedWorkspace = process.env.ANYFUSION_PLANNER_WORKSPACE ?? realpathOrSelf(cwd);
    const plannerHome = this.deps.plannerHome
      ?? process.env.METACLAW_PLANNER_HOME
      ?? process.env.ANYFUSION_PLANNER_HOME
      ?? resolveCurrentRuntimeHome(resolveAnyFusionPaths().generatedAgentRuntime, 'planner')
      ?? join(process.env.METACLAW_HOME ?? tmpdir(), 'anyfusion-planner');
    const sessionDir = this.deps.sessionDir
      ?? process.env.METACLAW_PLANNER_SESSION_DIR
      ?? join(plannerHome, 'sessions');
    const sessionPath = join(sessionDir, `${sessionId}.jsonl`);
    await (this.deps.ensureSessionDir ?? (path => mkdir(path, { recursive: true }).then(() => undefined)))(sessionDir);
    const args = mode === 'rpc'
      ? this.deps.args
        ?? parsePlannerArgs(process.env.METACLAW_PLANNER_ARGS)
        ?? [
          '--mode', 'rpc',
          '--offline',
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-themes',
          '--session', sessionPath,
        ]
      : mode === 'interactive'
        ? withInteractiveSession(
          this.deps.interactiveArgs
            ?? parsePlannerArgs(process.env.METACLAW_PLANNER_TUI_ARGS)
            ?? [],
          join(sessionDir, `${sessionId}.interactive.jsonl`),
        )
        : [];
    const env = buildEnvFromFile(this.deps.envFile ?? process.env.METACLAW_PLANNER_ENV_FILE);
    const socketPath = this.deps.socketPath
      ?? process.env.METACLAW_PLANNER_HOST_SOCKET
      ?? process.env.METACLAW_PLANNER_TUI_SOCKET;
    const schemaPath = this.deps.schemaPath
      ?? process.env.ANYFUSION_PLANNER_SCHEMA_PATH
      ?? process.env.METACLAW_PLANNER_SCHEMA_PATH;
    return {
      command,
      args,
      cwd,
      sessionDir,
      env: {
        ...env,
        ANYFUSION_PLANNER_MODE: '1',
        ANYFUSION_PLANNER_HOME: plannerHome,
        ANYFUSION_PLANNER_SESSION_DIR: sessionDir,
        ANYFUSION_PLANNER_SESSION_ID: sessionId,
        METACLAW_PLANNER_SESSION_ID: sessionId,
        ANYFUSION_PLANNER_REQUEST_SOURCE: requestSource,
        ANYFUSION_PLANNER_TURN_PURPOSE: purpose,
        ANYFUSION_BRIDGE_SOCKET: socketPath,
        METACLAW_PLANNER_TUI_SOCKET: socketPath,
        ANYFUSION_PLANNER_SCHEMA_PATH: schemaPath,
        ANYFUSION_PLANNER_WORKSPACE: authorizedWorkspace,
        METACLAW_CONFIGURATION_REVISION: configurationRevision,
        ...buildPlannerMcpLaunchEnv(),
      },
    };
  }

  private resolveCommand(): string {
    // Task 10 removes these compatibility fallbacks after release activation
    // provides the pinned Planner command directly.
    return this.deps.command
      ?? process.env.METACLAW_PLANNER_COMMAND
      ?? process.env.METACLAW_PLANNER_TUI_COMMAND
      ?? 'anyfusion-planner';
  }

  private assertSessionOpen(sessionId: string): void {
    if (this.stopping) {
      throw new Error('AnyFusion Planner supervisor is stopping');
    }
    if (this.closedSessions.has(sessionId)) {
      throw new Error(`AnyFusion Planner session is closed: ${sessionId}`);
    }
  }

  private trackProcess(child: ChildProcess, sessionId: string): TrackedPlannerProcess {
    this.activeProcesses.add(child);
    let finish!: () => void;
    let completed = false;
    const termination = new Promise<void>(resolve => { finish = resolve; });
    const tracked: TrackedPlannerProcess = {
      sessionId,
      termination,
      stopRequested: false,
    };
    const complete = () => {
      if (completed) return;
      completed = true;
      this.activeProcesses.delete(child);
      this.trackedProcesses.delete(child);
      finish();
    };
    child.once('exit', complete);
    child.once('close', complete);
    child.once('error', complete);
    this.trackedProcesses.set(child, tracked);
    return tracked;
  }

  private async terminateProcesses(processes: ChildProcess[]): Promise<void> {
    await Promise.all(processes.map(child => this.terminateProcess(child)));
  }

  private async terminateProcess(child: ChildProcess): Promise<void> {
    const tracked = this.trackedProcesses.get(child);
    if (!tracked) return;
    tracked.stopPromise ??= (async () => {
      tracked.stopRequested = true;
      child.kill('SIGTERM');
      const graceMs = this.deps.shutdownGraceMs ?? 5_000;
      let graceTimer: NodeJS.Timeout | null = null;
      const terminatedDuringGrace = await Promise.race([
        tracked.termination.then(() => true),
        new Promise<boolean>(resolve => {
          graceTimer = setTimeout(() => resolve(false), graceMs);
        }),
      ]);
      if (graceTimer) clearTimeout(graceTimer);
      if (terminatedDuringGrace) return;

      child.kill('SIGKILL');
      const terminatedAfterKill = await Promise.race([
        tracked.termination.then(() => true),
        new Promise<boolean>(resolve => {
          graceTimer = setTimeout(() => resolve(false), Math.min(graceMs, 1_000));
        }),
      ]);
      if (graceTimer) clearTimeout(graceTimer);
      if (!terminatedAfterKill) {
        this.closedSessions.add(tracked.sessionId);
        throw new Error(`AnyFusion Planner process for session ${tracked.sessionId} did not exit after SIGKILL`);
      }
    })();
    await tracked.stopPromise;
  }
}

let defaultPlannerProcessSupervisor: PlannerProcessSupervisor | null = null;

export function getDefaultPlannerProcessSupervisor(): PlannerProcessSupervisor {
  defaultPlannerProcessSupervisor ??= new PlannerProcessSupervisor();
  return defaultPlannerProcessSupervisor;
}

function parsePlannerArgs(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new Error('METACLAW_PLANNER_ARGS must be a JSON string array');
  }
  return parsed;
}

function withInteractiveSession(args: string[], sessionPath: string): string[] {
  const forbidden = new Set([
    '--no-session', '--session', '--session-id', '--session-dir',
    '--continue', '-c', '--resume', '-r',
  ]);
  if (args.some(arg => forbidden.has(arg))) {
    throw new Error('Planner interactive args may not override the supervisor-owned session file');
  }
  return [...args, '--session', sessionPath];
}

function extractPlannerProposalResult(value: unknown): PlannerProposalResult | null {
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.details) ? value.details : value;
  if (candidate.status === 'accepted'
    && typeof candidate.turnId === 'string'
    && typeof candidate.submissionId === 'string'
    && typeof candidate.planId === 'string'
    && typeof candidate.outcome === 'string'
    && typeof candidate.displayText === 'string') {
    return candidate as unknown as PlannerProposalResult;
  }
  if (candidate.status === 'rejected' || candidate.status === 'conflict' || candidate.status === 'transport_uncertain') {
    return candidate as unknown as PlannerProposalResult;
  }
  return null;
}

function extractPlannerModelError(event: Record<string, unknown>): string | null {
  if (!Array.isArray(event.messages)) return null;
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index];
    if (!isRecord(message) || message.role !== 'assistant') continue;
    if (typeof message.errorMessage === 'string' && message.errorMessage.trim()) {
      return message.errorMessage;
    }
  }
  return null;
}

function summarizeValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    if (Array.isArray(value)) return { count: value.length };
    return value === undefined ? {} : { value: truncateText(String(value), 160) };
  }
  const summary: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 12)) {
    if (/secret|token|key|content|conversation|prompt/iu.test(key)) continue;
    if (typeof raw === 'string') summary[key] = truncateText(raw, 160);
    else if (typeof raw === 'number' || typeof raw === 'boolean' || raw === null) summary[key] = raw;
    else if (Array.isArray(raw)) summary[key] = { count: raw.length };
    else if (isRecord(raw)) summary[key] = { keys: Object.keys(raw).slice(0, 8) };
  }
  return summary;
}

function isAssistantMessage(value: unknown): boolean {
  return isRecord(value) && value.role === 'assistant';
}

function recordFields(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value)
    .filter(key => {
      const normalized = key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2');
      return !SENSITIVE_PROGRESS_FIELD.test(normalized);
    })
    .sort()
    .slice(0, 20);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The Planner bootstrap compares against its physical cwd, so resolve symlinks. */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
