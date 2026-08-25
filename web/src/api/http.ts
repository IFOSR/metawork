import type {
  ActivateResult,
  ConfigSnapshot,
  ExecutionTimeline,
  ExecutorSummary,
  ConfigurationCompletionResult,
  TaskSummary,
  WorkGraphPresentationProjection,
} from './types';
import type {
  ArtifactProjection,
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

  getActivationStatus(): Promise<Pick<ConfigSnapshot, 'activationStatus' | 'activationAllowed' | 'blockingReasons' | 'activeTaskId' | 'activeAttemptCount' | 'plannerTurnActive' | 'hotActivationSupported' | 'restartRequired' | 'checkedAt'>> {
    return this.request('/api/config/activation-status');
  }

  getConfigurationCompletion(): Promise<ConfigurationCompletionResult> {
    return this.request('/api/config/completion');
  }

  getTasks(): Promise<TaskSummary[]> {
    return this.request<TaskSummary[]>('/api/execution/tasks');
  }

  getTaskTimeline(taskId: string): Promise<ExecutionTimeline> {
    return this.request<ExecutionTimeline>(`/api/execution/tasks/${encodeURIComponent(taskId)}`);
  }

  getTaskWorkGraph(taskId: string): Promise<WorkGraphPresentationProjection> {
    return this.request<WorkGraphPresentationProjection>(
      `/api/execution/tasks/${encodeURIComponent(taskId)}/work-graph`,
    );
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

  getArtifact(artifactId: string): Promise<{ artifact: ArtifactProjection }> {
    return this.request(`/api/artifacts/${encodeURIComponent(artifactId)}`);
  }

  getArtifactPreview(artifactId: string): Promise<{
    artifact: ArtifactProjection;
    content: string;
    renderedHtml?: string;
  }> {
    return this.request(`/api/artifacts/${encodeURIComponent(artifactId)}/preview`);
  }

  artifactDownloadUrl(artifactId: string): string {
    return `/api/artifacts/${encodeURIComponent(artifactId)}/download`;
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

  activate(
    baseRevisionId: string,
    config: Record<string, unknown>,
    secrets?: Record<string, string>,
  ): Promise<ActivateResult> {
    return this.requestActivation('/api/config/activate', {
      method: 'POST',
      body: JSON.stringify({ baseRevisionId, config, ...(secrets ? { secrets } : {}) }),
    });
  }

  private async requestActivation(
    path: string,
    init: RequestInit,
  ): Promise<ActivateResult> {
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body = await response.json() as ActivateResult;
    if (!response.ok && response.status !== 409 && response.status !== 422) {
      if (response.status === 401) this.onUnauthorized?.();
      throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
    }
    return body;
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

  verifySecret(
    providerRef: string,
    baseUrl?: string,
  ): Promise<{ configured: boolean; valid: boolean | null; detail?: string }> {
    return this.request('/api/config/secrets/verify', {
      method: 'POST',
      body: JSON.stringify({ providerRef, baseUrl }),
    });
  }
}
