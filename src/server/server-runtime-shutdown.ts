/**
 * Fixed shutdown order for the Server-owned runtimes.
 *
 * The memory controller deposits completed turns through the Conversation read
 * model, so its final drain needs AccountRuntime storage to still be open. The
 * "no account can write while memory drains" guarantee comes from the earlier
 * lifecycle stages, not from disposing the accounts first: `stopListeners`
 * closes every client and Gateway admission point, and `drain` closes the
 * remaining gateways and awaits in-flight work. Releasing AccountRuntime
 * storage before this drain makes the final deposition fail with
 * "The database connection is not open" and loses that segment permanently, so
 * the deposition runs first and storage is released afterwards.
 */
export interface ServerRuntimeShutdownDeps {
  stopPlanner(): Promise<void>;
  shutdownAccounts(): Promise<void>;
  stopMemory(): Promise<void>;
}

export async function stopServerRuntimes(deps: ServerRuntimeShutdownDeps): Promise<void> {
  const errors: unknown[] = [];
  await runStep(deps.stopPlanner, errors);
  await runStep(deps.stopMemory, errors);
  // Storage is released even when the deposition failed: leaving open handles
  // behind would make the next start inherit an abandoned shutdown.
  await runStep(deps.shutdownAccounts, errors);
  if (errors.length > 0) {
    throw new AggregateError(errors, 'MetaWork Server runtime shutdown did not complete cleanly');
  }
}

async function runStep(step: () => Promise<void>, errors: unknown[]): Promise<void> {
  try {
    await step();
  } catch (error) {
    errors.push(error);
  }
}
