/**
 * Server binding contract (ADR-0055 D10/D11).
 *
 * MetaWork Web defaults to loopback. A non-loopback bind is allowed only when
 * the operator states the origins that may talk to it, and every credentialled
 * surface still goes through account login. Requests without an `Origin` header
 * are non-browser clients (CLI, Desktop, tests) and are not origin-checked;
 * browser requests must match a configured origin, or the request's own origin
 * when no allow-list was configured.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const LOOPBACK_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u;
const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

export interface ServerBindingInput {
  host?: string;
  allowedOrigins?: readonly string[];
  trustProxy?: boolean;
}

export interface ServerBinding {
  readonly host: string;
  readonly loopback: boolean;
  readonly allowedOrigins: readonly string[];
  readonly trustProxy: boolean;
}

export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(value)) return true;
  if (value === '0.0.0.0' || value === '::' || value === '[::]') return false;
  return LOOPBACK_PATTERN.test(value);
}

/**
 * Canonicalizes `scheme://host[:port]`. Paths other than `/` are rejected
 * because an origin never carries one; credentials and wildcards are rejected
 * outright so a misconfiguration cannot quietly become "allow everyone".
 */
export function canonicalOrigin(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('origin must not be empty');
  if (value === '*') {
    throw new Error('origin "*" is not supported: list every allowed origin explicitly');
  }
  if (value === 'null') {
    throw new Error('origin "null" is not supported: it cannot be authenticated');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid origin: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`origin must use http or https: ${raw}`);
  }
  if (url.username || url.password) {
    throw new Error(`origin must not carry credentials: ${raw}`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`origin must not carry a path, query or fragment: ${raw}`);
  }
  return `${url.protocol}//${url.host}`;
}

export function resolveServerBinding(input: ServerBindingInput = {}): ServerBinding {
  const host = (input.host ?? '127.0.0.1').trim();
  if (!host) throw new Error('server host must not be empty');
  const loopback = isLoopbackHost(host);
  const allowedOrigins = [...new Set((input.allowedOrigins ?? [])
    .map(origin => origin.trim())
    .filter(origin => origin.length > 0)
    .map(canonicalOrigin))];
  if (!loopback && allowedOrigins.length === 0) {
    throw new Error(
      `refusing to listen on ${host} without allowed origins: set `
      + 'METAWORK_SERVER_ALLOWED_ORIGINS to the comma-separated origins that may reach this server',
    );
  }
  const trustProxy = input.trustProxy === true;
  if (trustProxy && !loopback) {
    // Behind a reverse proxy the request Host/Origin pair stops being
    // trustworthy unless the operator lists origins; keep the failure explicit.
    if (allowedOrigins.length === 0) {
      throw new Error('trustProxy requires an explicit allowed-origin list');
    }
  }
  return { host, loopback, allowedOrigins, trustProxy };
}

export function serverBindingFromEnv(env: NodeJS.ProcessEnv): ServerBinding {
  const rawOrigins = env.METAWORK_SERVER_ALLOWED_ORIGINS ?? '';
  const trustProxyRaw = (env.METAWORK_SERVER_TRUST_PROXY ?? '').trim().toLowerCase();
  return resolveServerBinding({
    host: env.METAWORK_SERVER_HOST,
    allowedOrigins: rawOrigins.split(',').map(origin => origin.trim()).filter(Boolean),
    trustProxy: trustProxyRaw === '1' || trustProxyRaw === 'true',
  });
}

/**
 * `requestHost` is the raw `Host` header. When no allow-list is configured the
 * request must be same-origin, and loopback aliases of the same port count as
 * the same origin so `localhost:8788` can reach a `127.0.0.1:8788` server.
 */
export function isOriginAllowed(
  origin: string | undefined,
  binding: ServerBinding,
  requestHost?: string,
): boolean {
  if (!origin) return true;
  let canonical: string;
  try {
    canonical = canonicalOrigin(origin);
  } catch {
    return false;
  }
  if (binding.allowedOrigins.includes(canonical)) return true;
  if (binding.allowedOrigins.length > 0) return false;
  if (!requestHost) return false;
  let parsed: URL;
  try {
    parsed = new URL(`http://${requestHost}`);
  } catch {
    return false;
  }
  const scheme = new URL(canonical).protocol;
  const requestOrigin = `${scheme}//${parsed.host}`;
  if (canonical === requestOrigin) return true;
  const originUrl = new URL(canonical);
  const requestUrl = new URL(requestOrigin);
  if (originUrl.port !== requestUrl.port) return false;
  return isLoopbackHost(originUrl.hostname) && isLoopbackHost(requestUrl.hostname);
}

/** Normalizes one `http://host:port` origin for status/doctor output. */
export function describeBindingAddress(binding: ServerBinding, port: number): string {
  const host = binding.host.includes(':') && !binding.host.startsWith('[')
    ? `[${binding.host}]`
    : binding.host;
  return `http://${host}:${port}`;
}

export function originPort(origin: string): string {
  const url = new URL(origin);
  return url.port || DEFAULT_PORTS[url.protocol] || '';
}
