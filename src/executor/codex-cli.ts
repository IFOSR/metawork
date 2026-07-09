// Adapts the Codex CLI into the shared non-interactive executor interface.
import { CommandLineExecutorAdapter } from './command-line-adapter.js';
import { buildCodexNonInteractiveArgs } from './codex-args.js';

/** Runs Codex CLI exec with MetaClaw's configured non-interactive argument set. */
export class CodexCliAdapter extends CommandLineExecutorAdapter {
  readonly name = 'codex-cli';

  protected buildSpawnArgs(prompt: string): string[] {
    return buildCodexNonInteractiveArgs(prompt);
  }
}
