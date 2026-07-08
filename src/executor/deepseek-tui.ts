// Adapts deepseek-tui into the shared non-interactive executor interface.
import { CommandLineExecutorAdapter } from './command-line-adapter.js';

/** Runs deepseek-tui in exec auto mode for MetaClaw executor prompts. */
export class DeepSeekTuiAdapter extends CommandLineExecutorAdapter {
  readonly name = 'deepseek-tui';

  protected buildSpawnArgs(prompt: string): string[] {
    return ['exec', '--auto', prompt];
  }
}
