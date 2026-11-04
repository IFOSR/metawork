export type ServerLifecycleState = 'idle' | 'starting' | 'ready' | 'draining' | 'stopped' | 'failed';

export interface ServerLifecycleDeps {
  readonly acquireLock: () => Promise<() => Promise<void>>;
  readonly recover: () => Promise<void>;
  readonly startListeners: () => Promise<{
    unixSocketPath: string;
    webOrigin: string;
  }>;
  readonly writeManifest: (endpoints: {
    unixSocketPath: string;
    webOrigin: string;
  }) => Promise<void>;
  readonly markDraining?: () => Promise<void>;
  readonly stopListeners: () => Promise<void>;
  readonly drain: () => Promise<void>;
  readonly stopRuntime: () => Promise<void>;
  readonly removeManifest: () => Promise<void>;
};

export class ServerLifecycle {
  private currentState: ServerLifecycleState = 'idle';
  private releaseLock: (() => Promise<void>) | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly deps: ServerLifecycleDeps) {}

  get state(): ServerLifecycleState {
    return this.currentState;
  }

  async start(): Promise<void> {
    if (this.currentState === 'ready') return;
    if (this.currentState !== 'idle') {
      throw new Error(`Server lifecycle cannot start from ${this.currentState}`);
    }
    this.currentState = 'starting';
    let listenersStarted = false;
    try {
      this.releaseLock = await this.deps.acquireLock();
      await this.deps.recover();
      const endpoints = await this.deps.startListeners();
      listenersStarted = true;
      await this.deps.writeManifest(endpoints);
      this.currentState = 'ready';
    } catch (error) {
      this.currentState = 'failed';
      if (listenersStarted) {
        await this.deps.stopListeners().catch(() => undefined);
        await this.deps.drain().catch(() => undefined);
        await this.deps.stopRuntime().catch(() => undefined);
      }
      await this.deps.removeManifest().catch(() => undefined);
      await this.releaseLock?.().catch(() => undefined);
      this.releaseLock = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.currentState === 'idle' || this.currentState === 'stopped' || this.currentState === 'failed') {
      return;
    }
    this.stopPromise = (async () => {
      this.currentState = 'draining';
      const errors: unknown[] = [];
      await runStep(this.deps.markDraining ?? (async () => undefined), errors);
      await runStep(this.deps.stopListeners, errors);
      await runStep(this.deps.drain, errors);
      await runStep(this.deps.stopRuntime, errors);
      await runStep(this.deps.removeManifest, errors);
      // The instance lock is deliberately NOT released here. It is the only
      // durable evidence that this process is still alive: releasing it before
      // the process actually exits made a Server stuck inside
      // `process.exit` indistinguishable from a stopped one, so `status`,
      // `connect` and the updater all treated the zombie as absent. The lock is
      // removed by the `exit` handler (releaseOnExit) once the process really
      // ends; a crash leaves a stale lock that the next start reclaims by PID.
      this.currentState = 'stopped';
      if (errors.length > 0) {
        throw new AggregateError(errors, 'MetaWork Server shutdown did not complete cleanly');
      }
    })();
    return this.stopPromise;
  }
}

async function runStep(step: () => Promise<void>, errors: unknown[]): Promise<void> {
  try {
    await step();
  } catch (error) {
    errors.push(error);
  }
}
