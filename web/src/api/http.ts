import type {
  ActivateResult,
  ConfigSnapshot,
  ExecutionTimeline,
  ExecutorSummary,
  ConfigurationCompletionResult,
  ExecutorCapabilityManual,
  ExecutorManualAnalysis,
  ProviderModelDiscoveryResult,
  ProviderCredentialStatus,
  AgentReadiness,
  ExecutorManagementView,
  ExecutorConfigurationChange,
  PreparedExecutorConfiguration,
  TaskSummary,
  WorkGraphPresentationProjection,
} from './types';
import type {
  ArtifactProjection,
  AttachmentMetadata,
  BillingRecordPageView,
  BillingTaskView,
  QueryBillUserStatus,
  TaskBillingDetailView,
  WebSessionActivationResult,
  WebSessionCreationResult,
  WebSessionMetadata,
  WebSessionRecord,
  WorkspaceSummary,
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

  getExecutorManagement(): Promise<ExecutorManagementView> {
    return this.request('/api/config/executors');
  }

  prepareExecutor(baseRevisionId: string, change: ExecutorConfigurationChange): Promise<PreparedExecutorConfiguration> {
    return this.request('/api/config/executors/prepare', {
      method: 'POST',
      body: JSON.stringify({ baseRevisionId, change }),
    });
  }

  getActivationStatus(): Promise<Pick<ConfigSnapshot, 'activationStatus' | 'activationAllowed' | 'blockingReasons' | 'activeTaskId' | 'activeAttemptCount' | 'plannerTurnActive' | 'hotActivationSupported' | 'restartRequired' | 'checkedAt'>> {
    return this.request('/api/config/activation-status');
  }

  getAgentReadiness(): Promise<{ agents: AgentReadiness[] }> {
    return this.request('/api/agents/readiness');
  }

  refreshAgentReadiness(): Promise<{ agents: AgentReadiness[] }> {
    return this.request('/api/agents/readiness/refresh', { method: 'POST' });
  }

  getConfigurationCompletion(): Promise<ConfigurationCompletionResult> {
    return this.request('/api/config/completion');
  }

  discoverProviderModels(input: {
    baseUrl: string;
    apiKey?: string;
    providerRef?: string;
  }): Promise<ProviderModelDiscoveryResult> {
    return this.request('/api/config/discover-models', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getExecutorCapabilityManual(
    agentClassRef: string,
    revisionId?: string,
  ): Promise<ExecutorCapabilityManual> {
    const query = revisionId ? `?revisionId=${encodeURIComponent(revisionId)}` : '';
    return this.request(
      `/api/config/executors/${encodeURIComponent(agentClassRef)}/capability-manual${query}`,
    );
  }

  analyzeExecutorManual(
    agentClassRef: string,
    baseRevisionId: string,
    sourceText: string,
    config?: Record<string, unknown>,
  ): Promise<ExecutorManualAnalysis> {
    return this.request(
      `/api/config/executors/${encodeURIComponent(agentClassRef)}/capability-manual/analyze`,
      {
        method: 'POST',
        body: JSON.stringify({ baseRevisionId, sourceText, ...(config ? { config } : {}) }),
      },
    );
  }

  compileExecutorCapabilityManual(
    agentClassRef: string,
    baseRevisionId: string,
    sourceText: string,
    config?: Record<string, unknown>,
  ): Promise<ExecutorManualAnalysis> {
    return this.request(
      `/api/config/executors/${encodeURIComponent(agentClassRef)}/capability-manual/compile`,
      {
        method: 'POST',
        body: JSON.stringify({ baseRevisionId, sourceText, ...(config ? { config } : {}) }),
      },
    );
  }

  previewExecutorCapabilityManual(
    agentClassRef: string,
    baseRevisionId: string,
    config: Record<string, unknown>,
  ): Promise<ExecutorCapabilityManual> {
    return this.request(
      `/api/config/executors/${encodeURIComponent(agentClassRef)}/capability-manual/preview`,
      {
        method: 'POST',
        body: JSON.stringify({ baseRevisionId, config }),
      },
    );
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

  getWorkspaces(): Promise<{
    activeWorkspaceId: string | null;
    workspaces: WorkspaceSummary[];
  }> {
    return this.request('/api/workspaces');
  }

  browseWorkspaceDirectory(path?: string): Promise<{
    path: string;
    parent: string | null;
    crumbs: Array<{ name: string; path: string }>;
    entries: Array<{ name: string; path: string }>;
  }> {
    const suffix = path?.trim() ? `?path=${encodeURIComponent(path.trim())}` : '';
    return this.request(`/api/workspaces/browse${suffix}`);
  }

  selectWorkspace(path: string): Promise<{
    selection:
      | { status: 'not_requested' }
      | {
        status: 'accepted'; workspace?: WorkspaceSummary;
        conversations?: WebSessionMetadata[]; nextCursor?: string | null;
        projectionVersion?: number;
      }
      | { status: 'failed'; reason: string };
    activeWorkspaceId: string | null;
    activeSessionId: string | null;
  }> {
    return this.request('/api/workspaces/select', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  }

  getConversations(workspaceId: string, query = '', cursor?: string): Promise<{
    activeWorkspaceId: string;
    activeConversationId: string | null;
    conversations: WebSessionMetadata[];
    nextCursor?: string | null;
  }> {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query);
    if (cursor) params.set('cursor', cursor);
    const suffix = params.size ? `?${params}` : '';
    return this.request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/conversations${suffix}`,
    );
  }

  getConversation(sessionId: string, cursor?: string): Promise<WebSessionRecord> {
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request(`/api/conversations/${encodeURIComponent(sessionId)}${suffix}`);
  }

  /** 只读账单页：分页历史账单；金额与状态全部来自 Server 投影。 */
  getBillingRecords(input: {
    cursor?: string;
    filter?: 'all' | QueryBillUserStatus;
    limit?: number;
  } = {}): Promise<BillingRecordPageView> {
    const params = new URLSearchParams();
    if (input.cursor) params.set('cursor', input.cursor);
    if (input.filter && input.filter !== 'all') params.set('filter', input.filter);
    if (input.limit) params.set('limit', String(input.limit));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.request(`/api/billing/records${suffix}`);
  }

  /** Task 详情的关联请求；无事实时 items 为空（页面显示未建立计量记录）。 */
  getTaskBillingDetail(taskId: string): Promise<TaskBillingDetailView> {
    return this.request(`/api/billing/tasks/${encodeURIComponent(taskId)}`);
  }

  getBillingTasks(): Promise<readonly BillingTaskView[]> {
    return this.request('/api/billing/tasks');
  }

  createConversation(workspaceId: string): Promise<WebSessionCreationResult> {
    return this.request(`/api/workspaces/${encodeURIComponent(workspaceId)}/conversations`, {
      method: 'POST',
    });
  }

  attachConversation(sessionId: string, expectedWorkspaceId?: string): Promise<WebSessionActivationResult> {
    const scope = expectedWorkspaceId === undefined ? '' : `?workspaceId=${encodeURIComponent(expectedWorkspaceId)}`;
    return this.request(`/api/conversations/${encodeURIComponent(sessionId)}/attach${scope}`, {
      method: 'POST',
    });
  }

  async deleteConversation(sessionId: string): Promise<void> {
    await this.request<void>(`/api/conversations/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  }

  clearConversations(): Promise<{ deleted: number }> {
    return this.request('/api/conversations/clear-all', { method: 'POST' });
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
    body: Blob | Uint8Array,
  ): Promise<AttachmentMetadata> {
    const params = new URLSearchParams({ sessionId, name });
    const response = await fetch(`/api/attachments?${params.toString()}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: body as BodyInit,
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
    spanApiKey?: string,
  ): Promise<ActivateResult> {
    return this.requestActivation('/api/config/activate', {
      method: 'POST',
      body: JSON.stringify({
        baseRevisionId,
        config,
        ...(secrets ? { secrets } : {}),
        ...(spanApiKey ? { spanApiKey } : {}),
      }),
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
    const structuredFailure = body
      && body.ok === false
      && typeof body.code === 'string';
    if (!response.ok
      && !structuredFailure
      && response.status !== 409
      && response.status !== 422) {
      if (response.status === 401) this.onUnauthorized?.();
      throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
    }
    return body;
  }

  writeSecret(providerRef: string, apiKey: string): Promise<ProviderCredentialStatus> {
    return this.request<ProviderCredentialStatus>('/api/config/secrets', {
      method: 'POST',
      body: JSON.stringify({ providerRef, apiKey }),
    });
  }

  getSpanCredentialStatus(): Promise<{ configured: boolean }> {
    return this.request<{ configured: boolean }>('/api/config/routing/span/status');
  }

  writeSpanSecret(apiKey: string): Promise<ProviderCredentialStatus> {
    return this.request<ProviderCredentialStatus>('/api/config/routing/span/secret', {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    });
  }

  getSecretStatus(providers: string[]): Promise<Record<string, ProviderCredentialStatus>> {
    const params = new URLSearchParams({ providers: providers.join(',') });
    return this.request<Record<string, ProviderCredentialStatus>>(
      `/api/config/secrets/status?${params.toString()}`,
    );
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
