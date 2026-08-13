// Request/response contract for the local Unix-socket management API.
export interface ManagementApiRequest {
  id: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

export type ManagementApiResponse =
  | { id: string; status: 200; body: unknown }
  | { id: string; status: 404; error: string }
  | { id: string; status: 500; error: string };

export interface ServerHealthResponse {
  schemaVersion: 1;
  status: 'ok' | 'degraded' | 'blocked';
  release: string;
  databaseSchema: number;
  activeConfigurationRevision: string | null;
  plannerProtocol: string;
  kernelWorkflowAvailable: boolean;
  dispatchQuiesced: boolean;
  blockingRecovery: string | null;
}

export function serializeManagementApiResponse(response: ManagementApiResponse): string {
  return JSON.stringify(response);
}
