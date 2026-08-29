import {
	resolveClientEndpoint,
	type ClientEndpointResult,
} from './client-endpoint-resolver.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TuiClientLauncherDeps {
  readonly manifestPath: string;
  readonly conversationId?: string;
  readonly startupWorkspacePath?: string;
  readonly resolveEndpoint?: (
    manifestPath: string,
    protocolVersion: number,
  ) => Promise<ClientEndpointResult>;
  readonly runUi?: (
    socketPath: string,
    conversationId: string | undefined,
    workspaceHint: string,
  ) => Promise<void>;
  readonly command?: string;
  readonly spawn?: typeof spawn;
}

export class TuiClientLauncher {
  private readonly startupWorkspacePath: string;

  constructor(private readonly deps: TuiClientLauncherDeps) {
    this.startupWorkspacePath = deps.startupWorkspacePath ?? process.cwd();
  }

  async start(): Promise<void> {
    const resolveEndpoint = this.deps.resolveEndpoint
      ?? ((manifestPath, protocolVersion) => resolveClientEndpoint(manifestPath, protocolVersion, {
        releaseId: process.env.METAWORK_RELEASE_ID,
      }));
    const endpoint = await resolveEndpoint(this.deps.manifestPath, 2);
    if (!endpoint.ok) throw new Error(endpoint.message);
    if (this.deps.runUi) {
      await this.deps.runUi(
        endpoint.socketPath,
        this.deps.conversationId,
        this.startupWorkspacePath,
      );
      return;
    }
    await runVendoredPlannerClient(
      this.deps.command ?? findVendoredPlannerCommand(),
      endpoint.socketPath,
      this.deps.conversationId,
      this.startupWorkspacePath,
      this.deps.spawn ?? spawn,
    );
  }
}

async function runVendoredPlannerClient(
  command: string,
  socketPath: string,
  conversationId: string | undefined,
  workspaceHint: string,
  spawnProcess: typeof spawn,
): Promise<void> {
  const {
    ANYFUSION_PLANNER_WORKSPACE: _plannerWorkspace,
    ...clientEnvironment
  } = process.env;
  const child = spawnProcess(command, [
    '--gateway-socket',
    socketPath,
    ...(conversationId ? ['--conversation-id', conversationId] : []),
    '--workspace-hint',
    workspaceHint,
  ], {
    cwd: workspaceHint,
    stdio: 'inherit',
    env: {
      ...clientEnvironment,
      ANYFUSION_PLANNER_MODE: '1',
      METACLAW_GATEWAY_SOCKET: socketPath,
    },
  });
  await waitForExit(child);
}

export function resolveVendoredPlannerCommand(
  moduleRoot = dirname(fileURLToPath(import.meta.url)),
  workspaceHint = process.cwd(),
  pathExists: (path: string) => boolean = existsSync,
): string {
  const sourceRelative = join(
    'planner',
    'AnyFusion-Pi',
    'packages',
    'coding-agent',
    'dist',
    'cli.js',
  );
  const installedRelative = join(
    'planner',
    'packages',
    'coding-agent',
    'dist',
    'cli.js',
  );
  const candidates = [
    resolve(moduleRoot, '..', installedRelative),
    resolve(moduleRoot, '..', sourceRelative),
    resolve(moduleRoot, '../..', sourceRelative),
    resolve(process.cwd(), sourceRelative),
    resolve(workspaceHint, sourceRelative),
  ];
  const command = candidates.find(candidate => pathExists(candidate));
  if (!command) {
    throw new Error('Vendored AnyFusion-Pi Client is unavailable; rebuild the Planner package');
  }
  return command;
}

function findVendoredPlannerCommand(): string {
  return resolveVendoredPlannerCommand();
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGINT') {
        resolvePromise();
        return;
      }
      reject(new Error(`MetaWork TUI Client exited with ${code ?? signal ?? 'unknown'}`));
    });
  });
}
