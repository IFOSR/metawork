/**
 * Manager turn over Pi RPC (ADR-0055 D6, target contract design §1).
 *
 * One turn: render the Runtime-owned turn input into a single prompt, run the
 * upstream Pi agent, and read the proposal back from the
 * `submit_manager_proposal` tool call. Usage comes from the authoritative
 * `message_end` records so metering never estimates what the provider reported.
 *
 * The Manager cannot reach storage, the Kernel, the scheduler or publication:
 * this module only sends a prompt and reads records.
 */
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MANAGER_DEFAULT_TURN_TIMEOUT_MS, ManagerHostError, type ManagerProposal, type ManagerTurnInput, type ManagerUsageEvent } from './protocol.js';
import { PiRpcClient, type PiRpcEvent } from './rpc-client.js';
import { createHash, randomUUID } from 'node:crypto';

export const MANAGER_PROPOSAL_TOOL = 'submit_manager_proposal';

export interface ManagerAgentOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  readonly cwd: string;
  /** Account-owned Pi dialogue storage. Permission judgments never use it. */
  readonly sessionDir?: string;
  readonly turnTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly onDiagnostic?: (line: string) => void;
}

export interface ManagerPlanOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Report each provider call immediately, including turns that later fail. */
  onUsage?: (usage: ManagerUsageEvent) => void;
}

export class ManagerAgent {
  private client: PiRpcClient | null = null;
  private clientWorkspaceRoot: string | null = null;
  private readonly shutdown = new AbortController();
  private turnQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ManagerAgentOptions) {}

  get pid(): number | null {
    return this.client?.pid ?? null;
  }

  async plan(
    input: ManagerTurnInput,
    options: ManagerPlanOptions = {},
  ): Promise<ManagerProposal> {
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.shutdown.signal])
      : this.shutdown.signal;
    if (signal.aborted) throw cancelledTurn();
    const work = this.turnQueue.then(() => {
      if (signal.aborted) throw cancelledTurn();
      return this.runPlan(input, { ...options, signal });
    });
    this.turnQueue = work.then(() => undefined, () => undefined);
    // Reject a cancelled queued turn immediately, while retaining its position
    // in the queue until the preceding turn releases the process.
    let detach: () => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => {
      const onAbort = () => reject(cancelledTurn());
      signal.addEventListener('abort', onAbort, { once: true });
      detach = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
    });
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      detach();
    }
  }

  private async runPlan(
    input: ManagerTurnInput,
    options: ManagerPlanOptions = {},
  ): Promise<ManagerProposal> {
    const client = this.ensureClient(input);
    const turnId = `manager-turn-${randomUUID()}`;
    const timeoutMs = options.timeoutMs ?? this.options.turnTimeoutMs ?? MANAGER_DEFAULT_TURN_TIMEOUT_MS;
    const usage: ManagerUsageEvent[] = [];
    let proposal: unknown;
    let assistantReply = '';
    let proposalError: string | null = null;
    /** Provider/agent failure text from the last assistant message. */
    let assistantError: string | null = null;
    let settled = false;
    let failure: ManagerHostError | null = null;
    let finalize: (() => void) | null = null;
    let cleanup: () => void = () => undefined;

    const done = new Promise<void>((resolvePromise, rejectPromise) => {
      finalize = () => resolvePromise();
      const onEvent = (event: PiRpcEvent) => {
        switch (event.type) {
          case 'message_end':
            {
              const reported = collectAssistantFailure(event);
              if (reported) assistantError = reported;
              const message = asRecord(event.message);
              if (proposal !== undefined && message?.role === 'assistant' && message.stopReason === 'stop') {
                assistantReply = extractText(message);
              }
              const count = usage.length;
              collectUsage(event, usage, turnId);
              if (usage.length > count) {
                try { options.onUsage?.(usage[usage.length - 1]!); }
                catch (error) { cleanup(); rejectPromise(error); }
              }
            }
            break;
          case 'turn_end':
            collectProposal(event, value => {
              if (proposal !== undefined) proposalError = 'manager turn submitted multiple proposals';
              else proposal = value;
            }, message => { proposalError = message; });
            break;
          case 'agent_settled':
            settled = true;
            finalize?.();
            break;
          default:
            break;
        }
      };
      const detach = client.onEvent(onEvent);
      const detachFailure = client.onFailure(error => {
        cleanup();
        rejectPromise(error);
      });
      const timer = setTimeout(() => {
        cleanup();
        failure = new ManagerHostError(
          'manager_timeout',
          `manager turn exceeded ${timeoutMs}ms`,
          { retryable: true },
        );
        void client.command({ type: 'abort' }, { timeoutMs: 5_000 }).catch(() => undefined);
        rejectPromise(failure);
      }, timeoutMs);
      timer.unref();
      const onAbort = () => {
        cleanup();
        void client.command({ type: 'abort' }, { timeoutMs: 5_000 }).catch(() => undefined);
        rejectPromise(new ManagerHostError('manager_cancelled', 'manager turn was cancelled', { retryable: true }));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      cleanup = () => {
        detach();
        detachFailure();
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      if (options.signal?.aborted) onAbort();
      const originalFinalize = finalize;
      finalize = () => {
        cleanup();
        originalFinalize?.();
      };
    });
    // Attach a rejection observer immediately.  The RPC prompt can fail and
    // dispose the client before the turn reaches `await done`; without this
    // eager observer that legitimate failure race becomes an unhandled
    // rejection even though the caller is awaiting `plan()`.
    void done.catch(() => undefined);

    try {
      const response = await Promise.race([
        client.command({ type: 'prompt', message: renderTurnPrompt(input) }, { timeoutMs }),
        done.then(() => new Promise<never>(() => undefined)),
      ]);
      if (!response.success) {
        throw new ManagerHostError('manager_invalid_output', `pi rejected the prompt: ${response.error ?? 'unknown'}`, {
          retryable: true,
        });
      }
      await done;
      if (failure) throw failure;
      if (proposalError) {
        throw new ManagerHostError('manager_invalid_output', proposalError);
      }
      if (!settled || proposal === undefined) {
        // A silent failure is undebuggable: Pi/diagnostics carry the provider
        // error (balance, rate limit, model id), so surface the sanitized text
        // instead of a bare "no proposal".
        const detail = assistantError ?? proposalError;
        throw new ManagerHostError(
          'manager_invalid_output',
          detail
            ? `manager turn produced no proposal: ${detail}`
            : 'manager turn produced no proposal',
        );
      }
      return { proposal, usage, assistantReply };
    } catch (error) {
      if (error instanceof ManagerHostError) throw error;
      throw new ManagerHostError('manager_invalid_output', String(error), { cause: error });
    } finally {
      cleanup();
      // Every exit, including an invalid proposal, drops Pi conversation state.
      await this.dispose();
    }
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    await this.dispose();
    await this.turnQueue;
  }

  private async dispose(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientWorkspaceRoot = null;
    await client?.close();
  }

  private ensureClient(input: ManagerTurnInput): PiRpcClient {
    const workspaceRoot = input.workspace.root;
    if (this.client && this.clientWorkspaceRoot !== workspaceRoot) {
      throw new ManagerHostError(
        'manager_invalid_output',
        'Manager cannot serve concurrent turns with different workspace scopes',
        { retryable: true },
      );
    }
    if (!this.client) {
      // The Manager process no longer runs in the Workspace, so validate the
      // scope explicitly instead of relying on the spawn cwd.
      let stats;
      try {
        stats = statSync(workspaceRoot);
      } catch (error) {
        throw new ManagerHostError('manager_spawn_failed', `manager workspace is unavailable: ${workspaceRoot}`, { cause: error });
      }
      if (!stats.isDirectory()) {
        throw new ManagerHostError('manager_spawn_failed', `manager workspace is not a directory: ${workspaceRoot}`);
      }
      this.clientWorkspaceRoot = workspaceRoot;
      let sessionArgs: string[] = [];
      if (this.options.sessionDir) {
        if (input.purpose === 'permission' || input.purpose === 'summary') {
          sessionArgs = ['--no-session'];
        } else {
          // Pi owns history and compaction. Bind an exact native session to the
          // trusted Conversation and Workspace, including across Server restarts.
          const key = createHash('sha256').update(JSON.stringify([input.conversationId, workspaceRoot])).digest('hex');
          const sessionDir = join(this.options.sessionDir, key);
          mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
          const sessionId = `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20, 32)}`;
          sessionArgs = ['--session-dir', sessionDir, '--session-id', sessionId];
        }
      }
      this.client = new PiRpcClient({
        command: this.options.command,
        args: [...this.options.args, ...sessionArgs, '--provider', input.model.providerRef, '--model', input.model.modelId ?? input.model.modelRef],
        // Never spawn inside the user Workspace: Pi would discover that
        // project's AGENTS/skills/extensions and drift into doing work instead
        // of submitting a proposal. The Workspace root is passed through
        // METAWORK_MANAGER_WORKSPACE and the turn prompt instead.
        cwd: this.options.cwd,
        env: { ...(typeof this.options.env === 'function' ? this.options.env() : this.options.env),
          METACLAW_PLANNER_SESSION_ID: input.plannerSessionId ?? input.conversationId,
          METACLAW_PLANNER_CONVERSATION_ID: input.conversationId,
          METACLAW_CONFIGURATION_REVISION: input.configurationRevision,
          METAWORK_PLANNER_ATTACHMENTS_JSON: JSON.stringify(input.attachments ?? []),
          METAWORK_MANAGER_WORKSPACE: workspaceRoot, METAWORK_MANAGER_PURPOSE: input.purpose ?? 'planning' },
        ...(this.options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: this.options.commandTimeoutMs }),
        ...(this.options.onDiagnostic ? { onDiagnostic: this.options.onDiagnostic } : {}),
      });
    }
    return this.client;
  }
}

/** The Runtime owns context rendering; the Manager never queries storage. */
export function renderTurnPrompt(input: ManagerTurnInput): string {
  const sections = [
    `# MetaWork Manager turn`,
    `conversation: ${input.conversationId}`,
    ...(input.taskId ? [`task: ${input.taskId}`] : []),
    ...(input.generationId ? [`generation: ${input.generationId}`] : []),
    `workspace: ${input.workspace.root}`,
    // One positive, execution-side fact. The Manager's own tool surface stays
    // read-only in its extension, but that is never a Workspace property: the
    // Executor writes in the Conversation Git worktree and the Runtime merges
    // the result back. Rendering a 只读/可写 label here made the Manager refuse
    // or ask the user for write permission (2026-11-11).
    'execution writes: the Executor commits in this Conversation\'s Git worktree and the Runtime merges the result back into the Workspace; declare file work with workspaceEffect/fileOutputs and workspaceIntent.',
    `permission profile: ${input.permissionProfileRef}`,
    `configuration revision: ${input.configurationRevision}`,
    `active tools: ${input.tools.join(', ') || '(none)'}`,
    '',
    '## Goal',
    input.goal,
  ];
  if (input.context.length > 0) {
    sections.push('', '## Context');
    for (const [index, entry] of input.context.entries()) {
      sections.push(`### ${index + 1}`, entry);
    }
  }
  sections.push(
    '',
    'Finish by calling ' + MANAGER_PROPOSAL_TOOL + ' exactly once with the complete '
      + (input.purpose === 'permission' ? 'permission verdict.'
        : input.purpose === 'summary' ? 'final answer.' : 'plan.'),
    'Never edit files, run privileged commands, authorize work or publish changes.',
  );
  return sections.join('\n');
}

/** Extracts a bounded, secret-free reason from a failed assistant message. */
function collectAssistantFailure(event: PiRpcEvent): string | null {
  const message = asRecord(event.message);
  if (!message || message.role !== 'assistant') return null;
  const stop = typeof message.stopReason === 'string' ? message.stopReason : null;
  const raw = typeof message.errorMessage === 'string' && message.errorMessage.trim()
    ? message.errorMessage.trim()
    : null;
  if (!raw && stop !== 'error' && stop !== 'aborted') return null;
  const reason = raw ?? (stop === 'aborted' ? 'assistant turn aborted' : 'assistant turn failed');
  return reason.replace(/\s+/gu, ' ').slice(0, 300);
}

function collectUsage(event: PiRpcEvent, usage: ManagerUsageEvent[], turnId: string): void {
  const message = asRecord(event.message);
  if (!message || message.role !== 'assistant') return;
  const record = asRecord(message.usage);
  const rawCallId = typeof message.id === 'string' && message.id ? message.id : `call-${usage.length + 1}`;
  const callId = `${turnId}:${rawCallId}`;
  if (usage.some(item => item.callId === callId)) return;
  const read = (key: string): number | null => {
    const value = record?.[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  // An explicitly malformed cache count makes the full input unknown.
  const invalidCache = ['cacheRead', 'cacheWrite'].some(key =>
    record && Object.hasOwn(record, key) && read(key) === null);
  const inputTokens = invalidCache ? null : read('input');
  const outputTokens = read('output');
  usage.push({
    occurredAtUtc: new Date().toISOString(),
    providerResponseId: typeof message.id === 'string' ? message.id : null,
    callId,
    providerRef: typeof message.provider === 'string' ? message.provider : 'unknown',
    modelRef: typeof message.model === 'string' ? message.model : 'unknown',
    inputTokens,
    outputTokens,
    cacheReadTokens: read('cacheRead'),
    cacheWriteTokens: read('cacheWrite'),
    reasoningTokens: read('reasoning'),
    source: inputTokens === null && outputTokens === null ? 'unavailable' : 'reported',
  });
}

function collectProposal(
  event: PiRpcEvent,
  accept: (proposal: unknown) => void,
  reject: (message: string) => void,
): void {
  const results = Array.isArray(event.toolResults) ? event.toolResults : [];
  for (const result of results) {
    const record = asRecord(result);
    if (!record) continue;
    const toolName = typeof record.toolName === 'string'
      ? record.toolName
      : typeof record.name === 'string' ? record.name : null;
    if (toolName !== MANAGER_PROPOSAL_TOOL) continue;
    if (record.isError === true) {
      reject(`manager proposal tool failed: ${extractText(record) || 'unknown error'}`);
      return;
    }
    // Pi tool results carry `details` (what the tool returned) and no arguments,
    // so the extension puts the proposal there. The argument shapes remain
    // supported for streaming records that echo the call.
    const details = asRecord(record.details);
    const args = asRecord(record.args) ?? asRecord(record.input) ?? asRecord(record.arguments);
    const candidate = details?.proposal ?? args?.proposal ?? args?.plan ?? args;
    if (candidate === undefined) {
      reject('manager proposal tool returned no proposal');
      return;
    }
    accept(candidate);
    return;
  }
}

function extractText(record: Record<string, unknown>): string {
  const content = record.content;
  if (!Array.isArray(content)) return '';
  return content
    .map(entry => {
      const block = asRecord(entry);
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .join(' ')
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cancelledTurn(): ManagerHostError {
  return new ManagerHostError('manager_cancelled', 'manager turn was cancelled', { retryable: true });
}
