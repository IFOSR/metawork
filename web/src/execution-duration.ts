export function executionElapsedEndMs(
  running: boolean,
  updatedAt: string | null | undefined,
  nowMs: number,
): number {
  if (running || !updatedAt) return nowMs;
  const updatedMs = Date.parse(updatedAt);
  return Number.isNaN(updatedMs) ? nowMs : updatedMs;
}

/**
 * Format a measured execution duration from real Attempt facts.
 *
 * Only the runtime/execute window counts as execution time: the scheduler
 * attempt window (`startedAt` → `updatedAt`) is not executor work. When no
 * execution start or end fact exists the caller gets an empty string, so a
 * surface never prints a fabricated `0s`; a real sub-second execution is
 * reported as `<1s` instead of rounding to zero
 * (2026-10-28 transparent execution §P2.3).
 */
export function formatExecutionDuration(input: {
  executionStartedAt?: string | null;
  executionCompletedAt?: string | null;
  updatedAt?: string | null;
  running: boolean;
  nowMs: number;
}): string {
  const startedMs = input.executionStartedAt ? Date.parse(input.executionStartedAt) : NaN;
  if (!Number.isFinite(startedMs)) return '';
  const endMs = input.executionCompletedAt
    ? Date.parse(input.executionCompletedAt)
    : input.running
      ? input.nowMs
      : input.updatedAt
        ? Date.parse(input.updatedAt)
        : NaN;
  if (!Number.isFinite(endMs) || endMs < startedMs) return '';
  const elapsed = endMs - startedMs;
  if (elapsed < 1_000) return '<1s';
  const seconds = Math.floor(elapsed / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
