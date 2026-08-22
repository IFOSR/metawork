import type {
  ActivateResult,
  ConfigSnapshot,
  ExecutionTimeline,
  ExecutorSummary,
  TaskSummary,
} from './types';
import type {
  AttachmentMetadata,
  WebSessionActivationResult,
  WebSessionCreationResult,
  WebSessionMetadata,
  WebSessionRecord,
} from './session-types';

export class HttpClient {
  constructor(private readonly onUnauthorized?: () => void) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text();
      if (response.status === 401) this.onUnauthorized?.();
      throw new Error(`HTTP ${response.status}: ${body}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  getConfig(): Promise<ConfigSnapshot> {
    return this.request<ConfigSnapshot>('/api/config');
  }

  getTasks(): Promise<TaskSummary[]> {
    return this.request<TaskSummary[]>('/api/execution/tasks');
  }

  getTaskTimeline(taskId: string): Promise<ExecutionTimeline> {
    return this.request<ExecutionTimeline>(`/api/execution/tasks/${encodeURIComponent(taskId)}`);
  }

  getExecutors(): Promise<ExecutorSummary[]> {
    return this.request<ExecutorSummary[]>('/api/execution/executors');
  }

  getSessions(query = ''): Promise<{
    activeSessionId: string;
    sessions: WebSessionMetadata[];
  }> {
    const suffix = query.trim() ? `?q=${encodeURIComponent(query)}` : '';
    return this.request(`/api/sessions${suffix}`);
  }

  getSession(sessionId: string): Promise<WebSessionRecord> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  createSession(title?: string): Promise<WebSessionCreationResult> {
    return this.request('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
  }

  activateSession(sessionId: string): Promise<WebSessionActivationResult> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/activate`, {
      method: 'POST',
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  }

  clearSessions(): Promise<{ deleted: number }> {
    return this.request('/api/sessions/clear-all', { method: 'POST' });
  }

  async uploadAttachment(
    sessionId: string,
    name: string,
    bytes: Uint8Array,
  ): Promise<AttachmentMetadata> {
    const params = new URLSearchParams({ sessionId, name });
    const response = await fetch(`/api/attachments?${params.toString()}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes as unknown as BodyInit,
    });
    if (!response.ok) {
      const body = await response.text();
      if (response.status === 401) this.onUnauthorized?.();
      throw new Error(`HTTP ${response.status}: ${body}`);
    }
    return response.json() as Promise<AttachmentMetadata>;
  }

  activate(baseRevisionId: string, config: Record<string, unknown>): Promise<ActivateResult> {
    return this.request<ActivateResult>('/api/config/activate', {
      method: 'POST',
      body: JSON.stringify({ baseRevisionId, config }),
    });
  }

  writeSecret(providerRef: string, apiKey: string): Promise<{ apiKeyRef: string }> {
    return this.request<{ apiKeyRef: string }>('/api/config/secrets', {
      method: 'POST',
      body: JSON.stringify({ providerRef, apiKey }),
    });
  }

  getSecretStatus(providers: string[]): Promise<Record<string, boolean>> {
    const params = new URLSearchParams({ providers: providers.join(',') });
    return this.request<Record<string, boolean>>(`/api/config/secrets/status?${params.toString()}`);
  }

  verifySecret(providerRef: string): Promise<{ configured: boolean; valid: boolean | null; detail?: string }> {
    return this.request('/api/config/secrets/verify', {
      method: 'POST',
      body: JSON.stringify({ providerRef }),
    });
  }
}
