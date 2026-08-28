import {
  resolveClientEndpoint,
  type ClientEndpointResult,
} from './client-endpoint-resolver.js';
import { registerWebLaunchContext } from './web-launch-context-client.js';
import type {
  IssuedWebLaunchContext,
  WebLaunchContextInput,
} from '../management/web-launch-context.js';

export interface WebClientLauncherDeps {
  readonly manifestPath: string;
  readonly startupWorkspacePath?: string;
  readonly resolveEndpoint?: (
    manifestPath: string,
    protocolVersion: number,
  ) => Promise<ClientEndpointResult>;
  readonly registerLaunch?: (
    socketPath: string,
    input: WebLaunchContextInput,
  ) => Promise<IssuedWebLaunchContext>;
  readonly open?: (url: string) => void;
}

export class WebClientLauncher {
  private readonly startupWorkspacePath: string;

  constructor(private readonly deps: WebClientLauncherDeps) {
    this.startupWorkspacePath = deps.startupWorkspacePath ?? process.cwd();
  }

  async start(options: { conversationId?: string; noOpen: boolean }): Promise<string> {
    const resolveEndpoint = this.deps.resolveEndpoint
      ?? ((manifestPath, protocolVersion) => resolveClientEndpoint(manifestPath, protocolVersion));
    const endpoint = await resolveEndpoint(this.deps.manifestPath, 2);
    if (!endpoint.ok) throw new Error(endpoint.message);
    const registerLaunch = this.deps.registerLaunch ?? registerWebLaunchContext;
    const launch = await registerLaunch(endpoint.socketPath, {
      workspaceHint: this.startupWorkspacePath,
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    });
    const url = `${endpoint.webOrigin.replace(/\/+$/u, '')}/#bootstrap=${encodeURIComponent(launch.token)}`;
    if (!options.noOpen) this.deps.open?.(url);
    return url;
  }
}
