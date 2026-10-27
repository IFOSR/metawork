export { localServiceSpecificationRevision } from '../core/local-service-revision.js';

export interface LocalServiceSpecification {
  serviceId: string;
  taskId: string;
  command: string;
  args: string[];
  directory?: string;
  environmentReferences: Record<string, string>;
  host: '127.0.0.1' | '::1';
  port: number;
  healthPath: string;
  startupTimeoutMs: number;
  restartPolicy: 'explicit';
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

export type LocalServiceState = 'starting' | 'healthy' | 'unhealthy' | 'stopped' | 'failed';
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
export interface LocalServiceView {
  serviceId: string;
  taskId: string;
  state: LocalServiceState;
  url: string;
  message: string | null;
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
  serviceId: string;
  operation: LocalServiceOperation;
  phase: 'stopping' | 'starting' | 'completed';
  initialToken: string | null;
  result: LocalServiceView | null;
  error: string | null;
}
