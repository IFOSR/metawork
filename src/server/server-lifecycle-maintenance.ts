import type { TaskStateReconcilerReport } from '../execution/task-state-reconciler.js';
import { createReconcilerLogReporter } from './reconciler-log.js';

/**
 * Periodic task-state reconciliation belongs to a running Server.
 *
 * It used to run from `main()` before the `help` early return, so a read-only
 * `server status`, `help`, or an admin command could enter the writable repair
 * path and print a "nothing to reconcile" line (2026-10-22 review §A3 and the
 * 2026-10-23 diagnostic review §3). Composing it only from the Server startup
 * branch keeps status reads out of the repair path, while an explicit
 * `metawork maintenance reconcile-tasks` stays available for operators.
 */
export interface ServerStateReconcilerInput {
  installRoot?: string;
  intervalMs?: number;
  print?: (line: string) => void;
  onError?: (error: unknown) => void;
  /** Test seam; production always reads the install database. */
  reconcile?: () => Promise<TaskStateReconcilerReport>;
}

export interface ServerStateReconciler {
  /** Run one pass now, exactly like the periodic pass. */
  runOnce(): Promise<void>;
  stop(): void;
}

export async function startServerStateReconciler(
  input: ServerStateReconcilerInput = {},
): Promise<ServerStateReconciler> {
  const reconcile = input.reconcile ?? await defaultReconcile(input.installRoot);
  const reporter = createReconcilerLogReporter();
  const print = input.print ?? (line => console.log(`[reconciler] ${line}`));
  const onError = input.onError ?? (error => console.error('[reconciler] reconciliation failed:', error));
  const runOnce = async (): Promise<void> => {
    try {
      for (const line of reporter.report(await reconcile())) print(line);
    } catch (error) {
      onError(error);
    }
  };
  await runOnce();
  const timer = setInterval(() => { void runOnce(); }, input.intervalMs ?? 60_000);
  timer.unref?.();
  return { runOnce, stop: () => clearInterval(timer) };
}

async function defaultReconcile(
  installRoot: string | undefined,
): Promise<() => Promise<TaskStateReconcilerReport>> {
  const { runTaskStateReconciler } = await import('../execution/task-state-reconciler.js');
  return () => runTaskStateReconciler({ installRoot });
}
