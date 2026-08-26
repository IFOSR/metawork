import {
  resolveClientEndpoint,
  type ClientEndpointResult,
} from './client-endpoint-resolver.js';

export interface WebClientLauncherDeps {
  readonly manifestPath: string;
  readonly resolveEndpoint?: (
    manifestPath: string,
    protocolVersion: number,
  ) => Promise<ClientEndpointResult>;
  readonly open?: (url: string) => void;
}

export class WebClientLauncher {
  constructor(private readonly deps: WebClientLauncherDeps) {}

  async start(options: { conversationId?: string; noOpen: boolean }): Promise<string> {
    const resolveEndpoint = this.deps.resolveEndpoint
      ?? ((manifestPath, protocolVersion) => resolveClientEndpoint(manifestPath, protocolVersion));
    const endpoint = await resolveEndpoint(this.deps.manifestPath, 1);
    if (!endpoint.ok) throw new Error(endpoint.message);
    const url = options.conversationId
      ? `${endpoint.webOrigin.replace(/\/+$/u, '')}/?conversation=${encodeURIComponent(options.conversationId)}`
      : endpoint.webOrigin;
    if (!options.noOpen) this.deps.open?.(url);
    return url;
  }
}
