type FetchLike = typeof fetch;

export interface WebLaunchSuggestion {
  workspaceHint: string;
  conversationId?: string;
}

export interface WebAuthSession {
  authenticated: true;
}

export function launchTokenFromHash(hash = window.location.hash): string | null {
  return new URLSearchParams(hash.replace(/^#/u, '')).get('launch');
}

export function clearLaunchFragment(
  location: Pick<Location, 'pathname' | 'search'> = window.location,
  history: Pick<History, 'replaceState'> = window.history,
): void {
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

/**
 * 启动目录提示：一次性、60 秒有效、未鉴权，只返回本机目录建议。
 *
 * 该 token 不能建立会话，因此不构成免密登录。真正的 Workspace 授权仍走已鉴权的
 * `POST /api/workspaces/select`。
 */
export async function resolveWebLaunchSuggestion(
  fetchImpl: FetchLike = fetch,
): Promise<WebLaunchSuggestion | null> {
  const token = launchTokenFromHash();
  if (!token) return null;
  clearLaunchFragment();
  const response = await fetchImpl('/api/auth/launch-context', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (response.status === 400 || response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<WebLaunchSuggestion>;
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
  return hasWebSession();
}
