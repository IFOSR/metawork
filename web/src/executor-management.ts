export function applyExecutorSnapshot<T>(
  local: Record<string, T>,
  saved: Record<string, T>,
  agentClassRef: string,
  options: { preserveLocal?: boolean } = {},
): Record<string, T> {
  const next = { ...local };
  if (Object.hasOwn(saved, agentClassRef)) {
    if (!options.preserveLocal || !Object.hasOwn(local, agentClassRef)) {
      next[agentClassRef] = saved[agentClassRef];
    }
  }
  else delete next[agentClassRef];
  return next;
}
