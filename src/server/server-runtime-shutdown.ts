/**
 * Fixed shutdown order for the Server-owned runtimes.
 *
 * The memory controller keeps depositing turns while it is alive, and its final
 * drain reads the Conversation read model. Account runtimes must therefore stop
 * producing turns first; only then may the memory controller drain, stop its
 * scheduler and stop the sidecar. Keeping this order in one function makes it
 * testable instead of an implicit property of the composition root.
 */
export interface ServerRuntimeShutdownDeps {
  stopPlanner(): Promise<void>;
  shutdownAccounts(): Promise<void>;
  stopMemory(): Promise<void>;
}

export async function stopServerRuntimes(deps: ServerRuntimeShutdownDeps): Promise<void> {
  await deps.stopPlanner();
  await deps.shutdownAccounts();
  // Final deposition after every AccountRuntime stopped: no account can append
  // a turn between the drain and the sidecar shutdown.
  await deps.stopMemory();
}
