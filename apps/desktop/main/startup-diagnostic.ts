const messages = new Map([
  ['Installation failed', 'installation-helper-failed'],
  ['Desktop release signature rejected', 'payload-signature-rejected'],
  ['Runtime release signature rejected', 'runtime-signature-rejected'],
  ['Desktop authentication is unavailable', 'desktop-session-unavailable'],
  ['Desktop Gateway is unavailable', 'gateway-unavailable'],
  ['Desktop Server identity mismatch', 'server-identity-mismatch'],
  ['Local endpoint ownership or permissions are invalid', 'endpoint-permissions'],
  ['HTTP Server does not match the local Gateway', 'http-proof-mismatch'],
  ['Desktop session could not be established', 'session-exchange-failed'],
  ['Desktop session identity mismatch', 'session-identity-mismatch'],
]);

/** Never log exception bodies, paths, provider responses, tickets or credentials. */
export function startupFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return 'unexpected';
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === 'string' && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENOSPC', 'ECONNREFUSED'].includes(code)) return code;
  return messages.get(error.message) ?? 'unexpected';
}
