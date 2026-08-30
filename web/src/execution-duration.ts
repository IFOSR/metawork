export function executionElapsedEndMs(
  running: boolean,
  updatedAt: string | null | undefined,
  nowMs: number,
): number {
  if (running || !updatedAt) return nowMs;
  const updatedMs = Date.parse(updatedAt);
  return Number.isNaN(updatedMs) ? nowMs : updatedMs;
}
