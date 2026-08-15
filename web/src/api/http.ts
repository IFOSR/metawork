import type {
  ActivateResult,
  ConfigSnapshot,
  ExecutionTimeline,
  ExecutorSummary,
  TaskSummary,
} from './types';

export class HttpClient {
  constructor(private readonly token: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text();
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

  activate(baseRevisionId: string, config: Record<string, unknown>): Promise<ActivateResult> {
    return this.request<ActivateResult>('/api/config/activate', {
      method: 'POST',
      body: JSON.stringify({ baseRevisionId, config }),
    });
  }
}
