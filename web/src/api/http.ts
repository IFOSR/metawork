import type {
  ActivateResult,
  ConfigSnapshot,
  ExecutionTimeline,
  ExecutorSummary,
  TaskSummary,
} from './types';
import type {
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
}
