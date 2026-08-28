const DEFAULT_SERVER_WEB_PORT = 8788;

export function resolveServerWebPort(env: NodeJS.ProcessEnv): number {
  const raw = env.METAWORK_WEB_PORT?.trim();
  if (!raw) return DEFAULT_SERVER_WEB_PORT;
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('METAWORK_WEB_PORT must be an integer between 0 and 65535');
  }
  return port;
}
