// Coordinates the transactional update lifecycle for the native Server.
//
// The update path never switches files under a running daemon: it acquires a
// lease, closes Task admission, quiesces dispatch, waits for idle, stops all
// surfaces, closes the database, then starts the candidate (or restarts the
// previous release on any failure). Concurrent update requests allow one holder;
// a timeout aborts the update instead of force-killing attempts.
export interface UpdateLease {
  held: boolean;
  holder: string;
}

export interface ServerUpdateCoordinatorDeps {
  acquireLease(): Promise<UpdateLease>;
  closeTaskAdmission(): Promise<void>;
  quiesceDispatch(): Promise<void>;
  awaitIdle(timeoutMs: number): Promise<boolean>;
  stopSurfaces(): Promise<void>;
  closeDatabase(): Promise<void>;
  startCandidate(): Promise<void>;
  restartPrevious(): Promise<void>;
  openTaskAdmission(): Promise<void>;
  releaseLease(): Promise<void>;
}

export interface ServerUpdateResult {
  outcome: 'committed' | 'aborted' | 'timeout';
  holder: string | null;
}

export class ServerUpdateCoordinator {
  private inFlight: Promise<ServerUpdateResult> | null = null;

  constructor(private readonly deps: ServerUpdateCoordinatorDeps) {}

  /** Runs one update transaction; concurrent requests share the in-flight run. */
  runUpdate(timeoutMs: number): Promise<ServerUpdateResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.performUpdate(timeoutMs).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async performUpdate(timeoutMs: number): Promise<ServerUpdateResult> {
    const lease = await this.deps.acquireLease();
    if (!lease.held) {
      return { outcome: 'aborted', holder: lease.holder };
    }
    try {
      await this.deps.closeTaskAdmission();
      await this.deps.quiesceDispatch();
      const idle = await this.deps.awaitIdle(timeoutMs);
      if (!idle) {
        await this.deps.restartPrevious();
        await this.deps.openTaskAdmission();
        return { outcome: 'timeout', holder: lease.holder };
      }
      await this.deps.stopSurfaces();
      await this.deps.closeDatabase();
      try {
        await this.deps.startCandidate();
      } catch {
        await this.deps.restartPrevious();
        await this.deps.openTaskAdmission();
        return { outcome: 'aborted', holder: lease.holder };
      }
      await this.deps.openTaskAdmission();
      return { outcome: 'committed', holder: lease.holder };
    } finally {
      await this.deps.releaseLease();
    }
  }
}
