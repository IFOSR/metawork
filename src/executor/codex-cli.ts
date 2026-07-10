// Adapts the Codex CLI into the shared non-interactive executor interface.
import { CommandLineExecutorAdapter } from './command-line-adapter.js';
import { buildCodexNonInteractiveArgs } from './codex-args.js';

/** Runs Codex CLI exec with MetaClaw's configured non-interactive argument set. */
export class CodexCliAdapter extends CommandLineExecutorAdapter {
  readonly name = 'codex-cli';

  protected buildSpawnArgs(prompt: string): string[] {
    return buildCodexNonInteractiveArgs(prompt);
  }

  protected buildSpawnEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...(process.env.METACLAW_EXECUTOR_CODEX_HOME
        ? { CODEX_HOME: process.env.METACLAW_EXECUTOR_CODEX_HOME }
        : {}),
    };
  }
}
