import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveMetaWorkPaths } from '../installation/paths.js';
import {
  resolveCurrentRuntimeHome,
  resolveRevisionRuntimeHome,
} from '../configuration/agent-runtime-renderer.js';
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

// A 10 MiB attachment expands to roughly 13.4 MiB when base64 encoded and
// wrapped in the Planner RPC message event. Keep headroom for JSON metadata.
const MAX_RPC_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PROCESSING_CYCLES = 8;
const DEFAULT_MAX_NON_PROPOSAL_TOOL_CALLS = 12;
const DEFAULT_PROGRESS_HEARTBEAT_MS = 30_000;
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

export interface PlannerSupervisorRuntimeBinding {
  configurationRevision: string;
  bindingFingerprint: string;
  provider: string;
  modelId: string;
}

export interface PlannerBindingResolution {
  configurationRevision: string;
  bindingFingerprint: string;
  provider: string;
  modelId: string;
  runtimeEnvironment: Readonly<NodeJS.ProcessEnv>;
}

export interface PlannerProcessController extends PlannerRunner {
  readonly runtimeBinding?: Readonly<PlannerSupervisorRuntimeBinding>;
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
  gatewaySocketPath?: string;
  schemaPath?: string;
  configurationRevision?: string;
  bindingFingerprint?: string;
  generatedRuntimeRoot?: string;
  databasePath?: string;
  configurationRoot?: string;
  runtimeEnvironment?: Readonly<NodeJS.ProcessEnv>;
  expectedModel?: {
    provider: string;
    modelId: string;
  };
  resolvePlannerBinding?: (
    context: PlanningContext,
  ) => Promise<PlannerBindingResolution> | PlannerBindingResolution;
  shutdownGraceMs?: number;
  progressHeartbeatMs?: number;
  maxProcessingCycles?: number;
  maxNonProposalToolCalls?: number;
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
  private activeRuntimeBinding?: Readonly<PlannerSupervisorRuntimeBinding>;
  private currentConfigurationRevision?: string;
  private currentBindingFingerprint?: string;
  private currentExpectedModel?: { provider: string; modelId: string };
  private currentRuntimeEnvironment?: Readonly<NodeJS.ProcessEnv>;
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly closedSessions = new Set<string>();
  private readonly activeProcesses = new Set<ChildProcess>();
  private readonly trackedProcesses = new Map<ChildProcess, TrackedPlannerProcess>();
  private stopping = false;

  constructor(private readonly deps: PlannerProcessSupervisorDeps = {}) {
    this.currentConfigurationRevision = deps.configurationRevision;
    this.currentBindingFingerprint = deps.bindingFingerprint;
    this.currentExpectedModel = deps.expectedModel;
    this.currentRuntimeEnvironment = deps.runtimeEnvironment;
    if (
      deps.configurationRevision
      && deps.bindingFingerprint
      && deps.expectedModel
      && hasCompleteRuntimeEnvironment(deps.runtimeEnvironment, deps.expectedModel)
    ) {
      this.activeRuntimeBinding = Object.freeze({
        configurationRevision: deps.configurationRevision,
        bindingFingerprint: deps.bindingFingerprint,
        provider: deps.expectedModel.provider,
        modelId: deps.expectedModel.modelId,
      });
    }
  }

  get runtimeBinding(): Readonly<PlannerSupervisorRuntimeBinding> | undefined {
    return this.activeRuntimeBinding;
  }

  async refreshBinding(input: {
    configurationRevision: string;
    bindingFingerprint: string;
    provider: string;
    modelId: string;
    runtimeEnvironment: Readonly<NodeJS.ProcessEnv>;
  }): Promise<void> {
    if (!hasCompleteRuntimeEnvironment(input.runtimeEnvironment, input)) {
      throw new Error(`Planner runtime environment is incomplete for revision ${input.configurationRevision}`);
    }
    await this.terminateProcesses([...this.activeProcesses]);
    this.currentConfigurationRevision = input.configurationRevision;
    this.currentBindingFingerprint = input.bindingFingerprint;
    this.currentExpectedModel = { provider: input.provider, modelId: input.modelId };
    this.currentRuntimeEnvironment = input.runtimeEnvironment;
    this.activeRuntimeBinding = Object.freeze({
      configurationRevision: input.configurationRevision,
      bindingFingerprint: input.bindingFingerprint,
      provider: input.provider,
      modelId: input.modelId,
    });
  }

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
      this.currentConfigurationRevision,
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
    if (this.deps.resolvePlannerBinding) {
      const resolved = await this.deps.resolvePlannerBinding(context);
      if (
        this.currentConfigurationRevision !== resolved.configurationRevision
        || this.currentBindingFingerprint !== resolved.bindingFingerprint
        || this.currentExpectedModel?.provider !== resolved.provider
        || this.currentExpectedModel?.modelId !== resolved.modelId
      ) {
        await this.refreshBinding(resolved);
      }
    }
    const launch = await this.resolveLaunch(
      context.request.sessionId,
      cwdOverride,
      'rpc',
      purpose,
      context.request.source,
      context.configuration?.revisionId ?? this.currentConfigurationRevision,
      context.timeoutMs,
    );
    if (context.configuration?.revisionId && !this.currentExpectedModel) {
      throw new Error(
        `Planner expected model binding is required for configuration revision `
        + context.configuration.revisionId,
      );
    }
    this.assertSessionOpen(context.request.sessionId);
    const sessionPath = join(launch.sessionDir, `${context.request.sessionId}.jsonl`);
    const requestId = `planner-${context.request.sessionId}-${startedAt}`;
    const stateRequestId = `${requestId}-state`;

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
      let modelChecked = this.currentExpectedModel === undefined;
      let pendingResult: PlannerRunResult | null = null;
      let terminalProposalResult: PlannerProposalResult | null = null;
      let submittedPlan: unknown;
      const toolCalls: PlannerToolCallTrace[] = [];
      const toolStarts = new Map<string, Record<string, unknown>>();
      const toolSequences = new Map<string, number>();
      let progressSequence = 0;
      let turn = 0;
      let modelStreamTurn = 0;
      let modelOutputReceived = true;
      let modelWaitingSince = startedAt;
      let nonProposalToolCalls = 0;
      const maxProcessingCycles = positiveIntegerOrDefault(
        this.deps.maxProcessingCycles,
        DEFAULT_MAX_PROCESSING_CYCLES,
      );
      const maxNonProposalToolCalls = positiveIntegerOrDefault(
        this.deps.maxNonProposalToolCalls,
        DEFAULT_MAX_NON_PROPOSAL_TOOL_CALLS,
      );
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
      const heartbeatMs = positiveIntegerOrDefault(
        this.deps.progressHeartbeatMs,
        DEFAULT_PROGRESS_HEARTBEAT_MS,
      );
      const progressHeartbeat = setInterval(() => {
        if (settled || turn === 0 || modelOutputReceived) return;
        reportProgress({
          kind: 'model_waiting',
          turn,
          idleMs: Date.now() - modelWaitingSince,
        });
      }, heartbeatMs);

      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(progressHeartbeat);
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
      const sendPrompt = () => {
        const images = context.images?.map(image => ({
          type: 'image' as const,
          data: image.data,
          mimeType: image.mimeType,
        }));
        proc.stdin?.write(`${JSON.stringify({
          id: requestId,
          type: 'prompt',
          message: prompt,
          ...(images && images.length > 0 ? { images } : {}),
        })}\n`);
      };
      const acceptLine = (line: string) => {
        if (!line.trim()) return;
        if (settled) return;
        let event: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isRecord(parsed)) throw new Error('event must be an object');
          event = parsed;
        } catch (error) {
          fail(new Error(`AnyFusion Planner RPC emitted malformed JSONL: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
        if (
          event.type === 'response'
          && event.id === stateRequestId
          && event.command === 'get_state'
        ) {
          if (event.success !== true) {
            fail(new Error(
              `AnyFusion Planner state check failed: ${truncateText(
                redactSensitiveText(String(event.error ?? 'unknown error')),
                500,
              )}`,
            ));
            return;
          }
          const model = isRecord(event.data) && isRecord(event.data.model)
            ? event.data.model
            : null;
          const actualProvider = typeof model?.provider === 'string' ? model.provider : 'none';
          const actualModelId = typeof model?.id === 'string' ? model.id : 'none';
          const expected = this.currentExpectedModel;
          if (
            !expected
            || actualProvider !== expected.provider
            || actualModelId !== expected.modelId
          ) {
            fail(new Error(
              `Planner model binding mismatch: expected `
              + `${expected?.provider ?? 'unknown'}/${expected?.modelId ?? 'unknown'}, `
              + `received ${actualProvider}/${actualModelId}`,
            ));
            return;
          }
          modelChecked = true;
          sendPrompt();
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
          if (turn > maxProcessingCycles) {
            fail(new Error(
              `Planner did not submit a proposal within ${maxProcessingCycles} processing cycles; `
              + 'stop workspace inspection and decide from authoritative MCP facts.',
            ));
            return;
          }
          modelOutputReceived = false;
          modelWaitingSince = Date.now();
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
          if (event.type === 'message_update') {
            modelOutputReceived = true;
          }
          return;
        }
        if (event.type === 'tool_execution_start') {
          modelOutputReceived = true;
          if (event.toolName !== 'submit_planning_proposal') {
            nonProposalToolCalls += 1;
            if (nonProposalToolCalls > maxNonProposalToolCalls) {
              fail(new Error(
                `Planner did not submit a proposal within ${maxNonProposalToolCalls} `
                + 'non-proposal tool calls; stop querying and submit the bounded decision.',
              ));
              return;
            }
          }
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
            if (proposalResult?.status === 'transport_uncertain') {
              const result: PlannerRunResult = {
                proposalResult,
                submittedPlan,
                toolCalls,
                threadId: sessionPath,
                durationMs: Date.now() - startedAt,
              };
              settled = true;
              cleanup();
              void this.terminateProcess(proc).then(
                () => resolve(result),
                () => resolve(result),
              );
              return;
            }
          }
          return;
        }
        if (event.type === 'agent_end') {
          modelOutputReceived = true;
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
          fail(new Error(modelChecked
            ? 'AnyFusion Planner RPC exited before accepting the prompt'
            : 'AnyFusion Planner RPC exited before reporting its model binding'));
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
      if (this.currentExpectedModel) {
        proc.stdin?.write(`${JSON.stringify({ id: stateRequestId, type: 'get_state' })}\n`);
      } else {
        sendPrompt();
      }
    });
  }

  private async resolveLaunch(
    sessionId: string,
    cwdOverride: string | undefined,
    mode: 'interactive' | 'rpc' | 'probe',
    purpose: PlannerProposalPurpose = 'kernel',
    requestSource = 'session',
    configurationRevision = this.currentConfigurationRevision
      ?? process.env.METACLAW_CONFIGURATION_REVISION,
    rpcTimeoutMs?: number,
  ): Promise<{
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    sessionDir: string;
  }> {
    if (
      this.currentConfigurationRevision
      && configurationRevision
      && configurationRevision !== this.currentConfigurationRevision
    ) {
      throw new Error(
        `Planner supervisor revision mismatch: expected ${this.currentConfigurationRevision}, `
        + `received ${configurationRevision}`,
      );
    }
    const command = this.resolveCommand();
    const cwd = cwdOverride ?? this.deps.cwd ?? process.env.METACLAW_PLANNER_WORKDIR ?? process.cwd();
    const authorizedWorkspace = process.env.ANYFUSION_PLANNER_WORKSPACE ?? realpathOrSelf(cwd);
    const metaWorkPaths = resolveMetaWorkPaths();
    const generatedRuntimeRoot = this.deps.generatedRuntimeRoot
      ?? metaWorkPaths.generatedAgentRuntime;
    const revisionPlannerHome = this.deps.plannerHome
      ? undefined
      : resolveRevisionRuntimeHome(generatedRuntimeRoot, configurationRevision, 'planner');
    if (configurationRevision && !this.deps.plannerHome && !revisionPlannerHome) {
      throw new Error(
        `Planner runtime is unavailable for configuration revision ${configurationRevision}`,
      );
    }
    const plannerHome = this.deps.plannerHome
      ?? revisionPlannerHome
      ?? process.env.METACLAW_PLANNER_HOME
      ?? process.env.ANYFUSION_PLANNER_HOME
      ?? resolveCurrentRuntimeHome(generatedRuntimeRoot, 'planner')
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
        ? withGatewayClient(
          this.deps.interactiveArgs
            ?? parsePlannerArgs(process.env.METACLAW_PLANNER_TUI_ARGS)
            ?? [],
          this.deps.gatewaySocketPath
            ?? process.env.METACLAW_GATEWAY_SOCKET
            ?? this.deps.socketPath
            ?? process.env.METACLAW_PLANNER_HOST_SOCKET
            ?? process.env.METACLAW_PLANNER_TUI_SOCKET
            ?? join(plannerHome, 'gateway.sock'),
          sessionId,
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
        ...this.currentRuntimeEnvironment,
        ANYFUSION_PLANNER_MODE: '1',
        ANYFUSION_PLANNER_HOME: plannerHome,
        ANYFUSION_PLANNER_SESSION_DIR: sessionDir,
        ANYFUSION_PLANNER_SESSION_ID: sessionId,
        METACLAW_PLANNER_SESSION_ID: sessionId,
        ANYFUSION_PLANNER_REQUEST_SOURCE: requestSource,
        ANYFUSION_PLANNER_TURN_PURPOSE: purpose,
        ...(mode === 'rpc' && Number.isFinite(rpcTimeoutMs) && rpcTimeoutMs! > 0
          ? { ANYFUSION_PLANNER_RPC_TIMEOUT_MS: String(Math.floor(rpcTimeoutMs!)) }
          : {}),
        ANYFUSION_BRIDGE_SOCKET: socketPath,
        METACLAW_PLANNER_TUI_SOCKET: socketPath,
        ANYFUSION_PLANNER_SCHEMA_PATH: schemaPath,
        ANYFUSION_PLANNER_WORKSPACE: authorizedWorkspace,
        METACLAW_CONFIGURATION_REVISION: configurationRevision,
        ...(this.deps.databasePath
          ? { METACLAW_DB_PATH: this.deps.databasePath }
          : {}),
        ...(this.deps.configurationRoot
          ? { ANYFUSION_ACCOUNT_CONFIG_ROOT: this.deps.configurationRoot }
          : {}),
        ...buildPlannerMcpLaunchEnv(),
      },
    };
  }

  private resolveCommand(): string {
    // Native launchers provide the pinned command. Direct source-tree starts
    // must use the vendored Planner too; falling back to PATH hides a broken
    // installation behind an opaque ENOENT.
    return this.deps.command
      ?? process.env.METACLAW_PLANNER_COMMAND
      ?? process.env.METACLAW_PLANNER_TUI_COMMAND
      ?? findVendoredPlannerCommand()
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

function findVendoredPlannerCommand(): string | null {
  const relative = join(
    'planner',
    'AnyFusion-Pi',
    'packages',
    'coding-agent',
    'dist',
    'cli.js',
  );
  const candidates = [
    resolve(process.cwd(), relative),
    resolve(dirname(fileURLToPath(import.meta.url)), '../../', relative),
    resolve(dirname(fileURLToPath(import.meta.url)), '../', relative),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
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

function withGatewayClient(args: string[], gatewaySocketPath: string, conversationId: string): string[] {
  const forbidden = new Set([
    '--no-session', '--session', '--session-id', '--session-dir',
    '--continue', '-c', '--resume', '-r',
  ]);
  if (args.some(arg => forbidden.has(arg))) {
    throw new Error('Planner interactive args may not override client-only Conversation identity');
  }
  if (!gatewaySocketPath.trim()) {
    throw new Error('Planner interactive Gateway socket is unavailable');
  }
  return [
    ...args,
    '--gateway-socket',
    gatewaySocketPath,
    '--conversation-id',
    conversationId,
  ];
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

function hasCompleteRuntimeEnvironment(
  environment: Readonly<NodeJS.ProcessEnv> | undefined,
  expectedModel: { provider: string; modelId: string },
): boolean {
  if (!environment) return false;
  const providerKeyVariable = `OPENAI_API_KEY__${expectedModel.provider
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')}`;
  const apiKey = environment.OPENAI_API_KEY?.trim();
  const providerApiKey = environment[providerKeyVariable]?.trim();
  return Boolean(
    environment.OPENAI_BASE_URL?.trim()
    && apiKey
    && providerApiKey
    && apiKey === providerApiKey
    && environment.OPENAI_MODEL === expectedModel.modelId,
  );
}
