// Adapts Claude Code CLI into the shared non-interactive executor interface.
import { CommandLineExecutorAdapter } from './command-line-adapter.js';

/** Runs Claude Code with print-mode arguments suitable for MetaClaw executor prompts. */
export class ClaudeCodeAdapter extends CommandLineExecutorAdapter {
  readonly name = 'claude-code';

  protected buildSpawnArgs(prompt: string): string[] {
    return [
      '--print',
      '--dangerously-skip-permissions',
      prompt,
    ];
  }
}
