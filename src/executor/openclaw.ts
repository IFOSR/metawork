// Adapts the OpenClaw CLI into the shared non-interactive executor interface.
import { CommandLineExecutorAdapter } from './command-line-adapter.js';

/** Runs OpenClaw's local JSON agent command for MetaClaw executor prompts. */
export class OpenClawAdapter extends CommandLineExecutorAdapter {
  readonly name = 'openclaw';

  protected buildSpawnArgs(prompt: string): string[] {
    return ['agent', '--message', prompt, '--local', '--json'];
  }
}
