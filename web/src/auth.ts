type FetchLike = typeof fetch;

export interface WebLaunchContext {
  workspaceHint: string;
  conversationId?: string;
}

export interface WebAuthSession {
  authenticated: true;
  launchContext: WebLaunchContext | null;
}

export function bootstrapTokenFromHash(hash = window.location.hash): string | null {
  return new URLSearchParams(hash.replace(/^#/u, '')).get('bootstrap');
}

export function clearBootstrapFragment(
  location: Pick<Location, 'pathname' | 'search'> = window.location,
  history: Pick<History, 'replaceState'> = window.history,
): void {
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

export async function exchangeWebCredential(
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<WebAuthSession | null> {
  const response = await fetchImpl('/api/auth/bootstrap', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<WebAuthSession>;
}

export async function loginWithPassword(
  username: string,
  password: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const response = await fetchImpl('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (response.status === 401 || response.status === 429) return false;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return true;
}

export async function hasWebSession(fetchImpl: FetchLike = fetch): Promise<WebAuthSession | null> {
  const response = await fetchImpl('/api/auth/session', {
    credentials: 'same-origin',
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<WebAuthSession>;
}

export async function establishWebSession(): Promise<WebAuthSession | null> {
  const bootstrap = bootstrapTokenFromHash();
  if (bootstrap) {
    clearBootstrapFragment();
    return exchangeWebCredential(bootstrap);
  }
  return hasWebSession();
}
