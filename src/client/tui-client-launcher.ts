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
  readonly resolveEndpoint?: (
    manifestPath: string,
    protocolVersion: number,
  ) => Promise<ClientEndpointResult>;
  readonly runUi?: (socketPath: string, conversationId?: string) => Promise<void>;
  readonly command?: string;
  readonly spawn?: typeof spawn;
}

export class TuiClientLauncher {
  constructor(private readonly deps: TuiClientLauncherDeps) {}

  async start(): Promise<void> {
    const resolveEndpoint = this.deps.resolveEndpoint
      ?? ((manifestPath, protocolVersion) => resolveClientEndpoint(manifestPath, protocolVersion));
    const endpoint = await resolveEndpoint(this.deps.manifestPath, 1);
    if (!endpoint.ok) throw new Error(endpoint.message);
    if (this.deps.runUi) {
      await this.deps.runUi(endpoint.socketPath, this.deps.conversationId);
      return;
    }
    await runVendoredPlannerClient(
      this.deps.command ?? findVendoredPlannerCommand(),
      endpoint.socketPath,
      this.deps.conversationId,
      this.deps.spawn ?? spawn,
    );
  }
}

async function runVendoredPlannerClient(
  command: string,
  socketPath: string,
  conversationId: string | undefined,
  spawnProcess: typeof spawn,
): Promise<void> {
  const child = spawnProcess(command, [
    '--gateway-socket',
    socketPath,
    ...(conversationId ? ['--conversation-id', conversationId] : []),
  ], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      ANYFUSION_PLANNER_MODE: '1',
      METACLAW_GATEWAY_SOCKET: socketPath,
    },
  });
  await waitForExit(child);
}

function findVendoredPlannerCommand(): string {
  const relative = join(
    'planner',
    'AnyFusion-Pi',
    'packages',
    'coding-agent',
    'dist',
    'cli.js',
  );
  const moduleRoot = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), relative),
    resolve(moduleRoot, '../../', relative),
    resolve(moduleRoot, '../', relative),
  ];
  const command = candidates.find(candidate => existsSync(candidate));
  if (!command) {
    throw new Error('Vendored AnyFusion-Pi Client is unavailable; rebuild the Planner package');
  }
  return command;
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
