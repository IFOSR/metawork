import { ServerLifecycle, type ServerLifecycleState } from './server-lifecycle.js';
import type { ServerComposition } from './server-composition-contract.js';

export class ServerApplication {
  constructor(
    private readonly lifecycle: ServerLifecycle,
  ) {}

  get state(): ServerLifecycleState {
    return this.lifecycle.state;
  }

  start(): Promise<void> {
    return this.lifecycle.start();
  }

  stop(): Promise<void> {
    return this.lifecycle.stop();
  }
}

export function createServerApplication(
  composition: ServerComposition,
  deps: Omit<ConstructorParameters<typeof ServerLifecycle>[0], 'startListeners' | 'stopListeners' | 'drain' | 'stopRuntime'>,
): ServerApplication {
  return new ServerApplication(new ServerLifecycle({
    ...deps,
    startListeners: () => composition.startListeners(),
    stopListeners: () => composition.stopListeners(),
    drain: () => composition.drain(),
    stopRuntime: () => composition.stopRuntime(),
  }));
}

export async function main(
  cliCommand?: import('../cli/args.js').CliCommand,
): Promise<void> {
  const composition = await import('./server-composition.js');
  await composition.main(cliCommand);
}
