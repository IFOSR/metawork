/**
 * Manager host protocol (ADR-0055 D6/D8, target contract design §1).
 *
 * The Manager runs as an isolated upstream-Pi process owned by MetaWork. Only
 * three request kinds cross the boundary: a planning turn, an explicit cancel,
 * and a liveness probe. Everything else — storage, scheduling, admission,
 * publication — stays in the Runtime, so this protocol deliberately carries no
 * side effects beyond "produce a proposal".
 *
 * Messages are single-line JSON, versioned, bounded, and correlated by
 * `requestId`. A malformed or oversized answer is a protocol failure, never a
 * partial proposal.
 */

export const MANAGER_HOST_PROTOCOL_VERSION = 1;

/** Per-message cap for both directions; a bigger message is a protocol failure. */
export const MANAGER_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Default bound for one planning turn. */
export const MANAGER_DEFAULT_TURN_TIMEOUT_MS = 180_000;

export type ManagerHostErrorCode =
  | 'manager_protocol_mismatch'
  | 'manager_invalid_output'
  | 'manager_response_too_large'
  | 'manager_timeout'
  | 'manager_cancelled'
  | 'manager_process_exit'
  | 'manager_spawn_failed'
  | 'manager_not_running'
  | 'manager_unknown_request';

export class ManagerHostError extends Error {
  readonly code: ManagerHostErrorCode;
  readonly retryable: boolean;
  readonly requestId: string | null;

  constructor(
    code: ManagerHostErrorCode,
    message: string,
    options: { retryable?: boolean; requestId?: string | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ManagerHostError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId ?? null;
  }
}

/** What the Manager is allowed to know about a turn. No credentials, no secrets. */
export interface ManagerTurnInput {
  purpose?: 'planning' | 'permission' | 'summary';
  readonly conversationId: string;
  readonly plannerSessionId?: string;
  readonly attachments?: readonly import('../planning-types.js').PlannerAttachmentView[];
  readonly taskId: string | null;
  readonly generationId: string | null;
  readonly goal: string;
  /** Ordered conversation context already rendered by the Runtime. */
  readonly context: readonly string[];
  /**
   * The Runtime-owned Workspace root. It carries no access mode: the Manager's
   * own read-only tool surface is an operational constraint of its extension,
   * never a fact about what the Task may do in the Workspace.
   */
  readonly workspace: { readonly root: string };
  readonly permissionProfileRef: string;
  readonly configurationRevision: string;
  readonly model: { readonly providerRef: string; readonly modelRef: string; readonly modelId?: string };
  readonly tools: readonly string[];
}

export interface ManagerProposal {
  /** Raw proposal body; semantic validation happens in the existing Plan path. */
  readonly proposal: unknown;
  /** Native Pi final assistant text, separate from the strict proposal schema. */
  readonly assistantReply?: string;
  /** Model calls the Manager reported for this turn. */
  readonly usage: readonly ManagerUsageEvent[];
}

export interface ManagerUsageEvent {
  readonly occurredAtUtc?: string;
  readonly providerResponseId?: string | null;
  readonly callId: string;
  readonly providerRef: string;
  readonly modelRef: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly reasoningTokens?: number | null;
  readonly source: 'reported' | 'unavailable';
}

export type ManagerHostRequest =
  | {
    readonly type: 'plan';
    readonly protocolVersion: number;
    readonly requestId: string;
    readonly input: ManagerTurnInput;
  }
  | {
    readonly type: 'cancel';
    readonly protocolVersion: number;
    readonly requestId: string;
    readonly targetRequestId: string;
  }
  | {
    readonly type: 'ping';
    readonly protocolVersion: number;
    readonly requestId: string;
  };

export type ManagerHostResponse =
  | {
    readonly type: 'planned';
    readonly protocolVersion: number;
    readonly requestId: string;
    readonly proposal: unknown;
    readonly usage?: readonly ManagerUsageEvent[];
  }
  | {
    readonly type: 'pong';
    readonly protocolVersion: number;
    readonly requestId: string;
  }
  | {
    readonly type: 'error';
    readonly protocolVersion: number;
    readonly requestId: string;
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };

export function encodeManagerRequest(request: ManagerHostRequest): string {
  const line = `${JSON.stringify(request)}\n`;
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MANAGER_MAX_MESSAGE_BYTES) {
    throw new ManagerHostError(
      'manager_response_too_large',
      `manager request exceeds ${MANAGER_MAX_MESSAGE_BYTES} bytes (${bytes})`,
      { requestId: request.requestId },
    );
  }
  return line;
}

/**
 * Parses one response line. Every failure mode maps to a distinct code so the
 * caller can decide between retry, re-route and surfacing the fault.
 */
export function parseManagerResponse(line: string): ManagerHostResponse {
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MANAGER_MAX_MESSAGE_BYTES) {
    throw new ManagerHostError(
      'manager_response_too_large',
      `manager response exceeds ${MANAGER_MAX_MESSAGE_BYTES} bytes (${bytes})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ManagerHostError('manager_invalid_output', `manager response is not JSON: ${truncate(line)}`);
  }
  if (!isRecord(parsed)) {
    throw new ManagerHostError('manager_invalid_output', 'manager response must be a JSON object');
  }
  const version = parsed.protocolVersion;
  if (version !== MANAGER_HOST_PROTOCOL_VERSION) {
    throw new ManagerHostError(
      'manager_protocol_mismatch',
      `manager protocol mismatch: expected ${MANAGER_HOST_PROTOCOL_VERSION}, got ${String(version)}`,
      { requestId: typeof parsed.requestId === 'string' ? parsed.requestId : null },
    );
  }
  const requestId = parsed.requestId;
  if (typeof requestId !== 'string' || !requestId) {
    throw new ManagerHostError('manager_invalid_output', 'manager response is missing a requestId');
  }
  switch (parsed.type) {
    case 'planned':
      if (!('proposal' in parsed)) {
        throw new ManagerHostError('manager_invalid_output', 'planned response is missing a proposal', { requestId });
      }
      return {
        type: 'planned',
        protocolVersion: MANAGER_HOST_PROTOCOL_VERSION,
        requestId,
        proposal: parsed.proposal,
        ...(Array.isArray(parsed.usage) ? { usage: parsed.usage.map(normalizeUsage) } : {}),
      };
    case 'pong':
      return { type: 'pong', protocolVersion: MANAGER_HOST_PROTOCOL_VERSION, requestId };
    case 'error':
      return {
        type: 'error',
        protocolVersion: MANAGER_HOST_PROTOCOL_VERSION,
        requestId,
        code: typeof parsed.code === 'string' ? parsed.code : 'manager_invalid_output',
        message: typeof parsed.message === 'string' ? parsed.message : 'manager reported an error',
        retryable: parsed.retryable === true,
      };
    default:
      throw new ManagerHostError(
        'manager_invalid_output',
        `unknown manager response type: ${String(parsed.type)}`,
        { requestId },
      );
  }
}

function normalizeUsage(value: unknown): ManagerUsageEvent {
  const record = isRecord(value) ? value : {};
  const tokens = (input: unknown): number | null =>
    typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : null;
  const inputTokens = tokens(record.inputTokens);
  const outputTokens = tokens(record.outputTokens);
  return {
    occurredAtUtc: typeof record.occurredAtUtc === 'string' && Number.isFinite(Date.parse(record.occurredAtUtc))
      ? new Date(record.occurredAtUtc).toISOString() : undefined,
    providerResponseId: typeof record.providerResponseId === 'string' ? record.providerResponseId : null,
    callId: typeof record.callId === 'string' && record.callId ? record.callId : 'manager-call',
    providerRef: typeof record.providerRef === 'string' ? record.providerRef : 'unknown',
    modelRef: typeof record.modelRef === 'string' ? record.modelRef : 'unknown',
    inputTokens,
    outputTokens,
    cacheReadTokens: tokens(record.cacheReadTokens),
    cacheWriteTokens: tokens(record.cacheWriteTokens),
    reasoningTokens: tokens(record.reasoningTokens),
    source: inputTokens === null && outputTokens === null ? 'unavailable' : 'reported',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string): string {
  return value.length <= 200 ? value : `${value.slice(0, 200)}…`;
}
