import type { CliCommand } from '../cli/args.js';

// Unifies Server startup/shutdown across the supported surfaces:
// interactive Planner TUI, Gateway daemon, scripted session, and the standby
// Ink TUI. Shared resources (database, ConfigurationService, PlannerHostBridge,
// Gateway, timers, delivery) start once before the selected surface and stop
// after it.
export type ServerSurface = 'interactive' | 'gateway' | 'web' | 'standby';

export function resolveServerSurface(
  command: CliCommand,
  environment: NodeJS.ProcessEnv = process.env,
): ServerSurface {
  if (command.kind === 'server') return 'gateway';
  if (command.kind === 'web') return 'web';
  if (command.kind === 'tui' && environment.METACLAW_STANDBY_TUI === '1') return 'standby';
  if (command.kind === 'tui') return 'interactive';
  throw new Error(`${command.kind} does not select a Server surface`);
}

export interface ServerSurfaceHandle {
  stop(): Promise<void>;
}

export interface ServerApplicationDeps {
  surface: ServerSurface;
  startShared(): Promise<ServerSurfaceHandle>;
  startSurface(surface: ServerSurface, shared: ServerSurfaceHandle): Promise<ServerSurfaceHandle>;
}

export class ServerApplication {
  private shared: ServerSurfaceHandle | null = null;
  private surface: ServerSurfaceHandle | null = null;
  private started = false;

  constructor(private readonly deps: ServerApplicationDeps) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.shared = await this.deps.startShared();
    try {
      this.surface = await this.deps.startSurface(this.deps.surface, this.shared);
      this.started = true;
    } catch (error) {
      await this.shared.stop().catch(() => undefined);
      this.shared = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.surface?.stop().catch(() => undefined);
    await this.shared?.stop().catch(() => undefined);
    this.surface = null;
    this.shared = null;
    this.started = false;
  }
}
