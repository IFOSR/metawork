export { localServiceSpecificationRevision } from '../core/local-service-revision.js';

/**
 * Where a launch contract came from. A manifest is the user's/Executor's explicit
 * declaration; a discovered contract is the Runtime's reading of the delivered
 * project (package scripts, entry files). Both are launch contracts and both
 * carry a revision, so a later explicit manifest is a *different* contract that
 * needs an explicit update authorization instead of silently replacing the
 * running one (2026-10-28 transparent execution §optional service specification).
 */
export type LocalServiceSpecificationOrigin = 'manifest' | 'discovered';

export interface LocalServiceSpecification {
  serviceId: string;
  taskId: string;
  command: string;
  args: string[];
  directory?: string;
  environmentReferences: Record<string, string>;
  host: '127.0.0.1' | '::1';
  /**
   * Loopback port passed to the process as `PORT`. `null` means the contract
   * declares no port; the Runtime then records the process without an HTTP
   * address instead of inventing one.
   */
  port: number | null;
  /**
   * HTTP health path. `null` means the contract declares no health check: the
   * process being alive is the only available fact, and the service state is
   * `running`, never a fabricated `healthy`.
   */
  healthPath: string | null;
  startupTimeoutMs: number;
  restartPolicy: 'explicit';
  /** Defaults to `'manifest'` for specifications persisted before this field. */
  origin: LocalServiceSpecificationOrigin;
}

/**
 * Kernel-visible identity of one service specification. A launch is authorized
 * for exactly one revision: rewriting `.metawork-service.json` (or any part of
 * the command/port/health contract) produces a different revision and therefore
 * cannot be launched under the old authorization.
 */
// Keep the historical Task-domain signature while the implementation lives in
// the pure Core module so Kernel policy does not depend on Task runtime code.
export type { LocalServiceRevisionInput } from '../core/local-service-revision.js';

export type LocalServiceState =
  | 'starting'
  | 'healthy'
  | 'unhealthy'
  | 'stopped'
  | 'failed'
  /**
   * The process is alive but the contract declares no health check. This is not
   * `healthy`: nothing verified an HTTP endpoint.
   */
  | 'running';

/** True when the service is usable for the current operation. */
export function isServiceReadyState(state: LocalServiceState | string | null | undefined): boolean {
  return state === 'healthy' || state === 'running';
}

export interface LocalServiceRecord {
  accountId: string;
  /** Workspace the service belongs to; identity is (account, workspace, service). */
  workspaceId: string | null;
  /** Revision stored at authorization time; the running spec must equal it. */
  specificationRevision: string;
  specification: LocalServiceSpecification;
  state: LocalServiceState;
  processId: number | null;
  processToken: string | null;
  healthMessage: string | null;
  updatedAt: string;
}
export interface LocalServiceStore {
  /** Service identity is (account, workspace, service), not the service id alone. */
  findInWorkspace?(workspaceId: string, serviceId: string): LocalServiceRecord | null;
  /** Authorized revision for a service, or null when it was never started. */
  findAuthorizedRevision?(accountId: string, taskId: string, serviceId: string): string | null;
  find(serviceId: string): LocalServiceRecord | null;
  list(): LocalServiceRecord[];
  save(record: LocalServiceRecord, options?: { allowSpecificationChange?: boolean }): void;
  findOperation(decisionId: string): LocalServiceEffect | null;
  saveOperation(effect: LocalServiceEffect): void;
}
/** Target project of this run, as resolved from durable facts. */
export interface LocalServiceTargetView {
  /** Workspace-relative project directory; `''` is the Workspace root. */
  targetPath: string;
  /** Where the launch contract came from. */
  source: LocalServiceSpecificationOrigin;
}

export interface LocalServiceView {
  serviceId: string;
  taskId: string;
  state: LocalServiceState;
  /** HTTP address when the contract declares a port; `''` otherwise. */
  url: string;
  message: string | null;
  /** Resolved target project; absent on historical records. */
  target?: LocalServiceTargetView | null;
}

/**
 * Bounded, secret-free service observation. `specificationRevision` identifies
 * the specification this observation belongs to, so a stale record can never
 * be mistaken for the current Task's service.
 */
export interface LocalServiceDiagnostics {
  workspaceId: string | null;
  specificationRevision: string;
  processId: number | null;
  /** The observed process for this specification is no longer running. */
  exitObserved: boolean;
  /** Redacted tail of this service's log, bounded for a recovery packet. */
  logTail: string | null;
  /** Last HTTP status seen by the health check, when it answered at all. */
  healthStatus: number | null;
  /** An agent can plausibly repair this failure inside the same Workspace. */
  retryable: boolean;
}

/**
 * Runtime-only observation of one service specification.
 *
 * It is deliberately not part of `LocalServiceView`: the public view is served
 * to clients and must not carry process identity (see `managed-local-service`
 * tests). Historical service facts and the current specification stay separate
 * here: a previous `failed` record is diagnosis input, never a blocker for the
 * current Task (2026-10-27 realignment §4.3).
 */
export interface LocalServiceObservation {
  view: LocalServiceView;
  diagnostics: LocalServiceDiagnostics;
}

/**
 * `update` is the only way to authorize a *different* specification revision for
 * an existing service. Without it a rewritten manifest can never be launched.
 */
export type LocalServiceOperation = 'start' | 'stop' | 'restart' | 'update';

/** Runtime effect checkpoint, subordinate to an already-authorized Kernel decision. */
export interface LocalServiceEffect {
  decisionId: string;
  /** Conversation Turn that requested this operation, when user initiated. */
  turnId?: string | null;
  serviceId: string;
  operation: LocalServiceOperation;
  phase: 'stopping' | 'starting' | 'completed';
  initialToken: string | null;
  result: LocalServiceView | null;
  error: string | null;
}
