import type { TaskStateReconcilerReport } from '../execution/task-state-reconciler.js';

/**
 * Background reconciliation logging.
 *
 * The periodic Server pass used to print one line per minute even when it did
 * nothing, which buried the only useful signal (a Conversation slot retained by
 * unfinished residue) under ~15k identical lines. This reporter prints:
 *
 * - every state change the pass made;
 * - a retained slot on first observation, when its task or residue changes, and
 *   as a bounded heartbeat while it stays blocked;
 * - the release of a previously retained slot.
 *
 * A pass that changed nothing and kept the same retained set prints nothing.
 */
export interface ReconcilerLogEntry {
  conversationId: string;
  taskId: string;
  residue: readonly string[];
  firstSeenAt: number;
  lastLoggedAt: number;
}

export interface ReconcilerLogReporterDeps {
  /** Re-log a slot that stays blocked at most this often. */
  readonly heartbeatMs?: number;
}

export interface ReconcilerLogReporter {
  /** @returns the lines a background caller should print, possibly empty. */
  report(report: TaskStateReconcilerReport, now?: number): string[];
  /** Durable log state, for diagnostics and tests. */
  retained(): ReconcilerLogEntry[];
}

const DEFAULT_HEARTBEAT_MS = 15 * 60_000;

export function createReconcilerLogReporter(
  deps: ReconcilerLogReporterDeps = {},
): ReconcilerLogReporter {
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const retained = new Map<string, ReconcilerLogEntry>();

  return {
    report(report: TaskStateReconcilerReport, now = Date.now()): string[] {
      const lines = [...report.changes];
      const active = new Set<string>();
      for (const slot of report.retainedSlotResidue) {
        const residue = slot.residue.map(String);
        active.add(slot.conversationId);
        const previous = retained.get(slot.conversationId);
        const changed = !previous
          || previous.taskId !== slot.taskId
          || previous.residue.join('\n') !== residue.join('\n');
        if (changed) {
          const entry: ReconcilerLogEntry = {
            conversationId: slot.conversationId,
            taskId: slot.taskId,
            residue,
            firstSeenAt: previous?.firstSeenAt ?? now,
            lastLoggedAt: now,
          };
          retained.set(slot.conversationId, entry);
          lines.push(describeRetained(entry, now, previous ? 'changed' : 'retained'));
          continue;
        }
        if (now - previous.lastLoggedAt >= heartbeatMs) {
          previous.lastLoggedAt = now;
          lines.push(describeRetained(previous, now, 'still_blocked'));
        }
      }
      for (const [conversationId, entry] of [...retained]) {
        if (active.has(conversationId)) continue;
        retained.delete(conversationId);
        lines.push(
          `released previously retained conversation slot in ${conversationId}: `
          + `task ${entry.taskId} stayed blocked for ${formatDuration(now - entry.firstSeenAt)}`,
        );
      }
      return lines;
    },
    retained: () => [...retained.values()],
  };
}

function describeRetained(
  entry: ReconcilerLogEntry,
  now: number,
  state: 'retained' | 'changed' | 'still_blocked',
): string {
  return `retained conversation slot in ${entry.conversationId} (${state}, `
    + `blocked for ${formatDuration(now - entry.firstSeenAt)}): `
    + `task ${entry.taskId} still owns ${entry.residue.join(', ')}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ''}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ''}`;
}
