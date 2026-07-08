// Adapts the Hermes agent CLI into the shared non-interactive executor interface.
import { CommandLineExecutorAdapter } from './command-line-adapter.js';

/** Runs Hermes in oneshot mode with permissive local execution flags for executor prompts. */
export class HermesAgentAdapter extends CommandLineExecutorAdapter {
  readonly name = 'hermes-agent';

  protected buildSpawnArgs(prompt: string): string[] {
    return ['--oneshot', prompt, '--yolo', '--accept-hooks'];
  }
}
