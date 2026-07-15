// Adapts the Codex CLI into the shared non-interactive executor interface.
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CommandLineExecutorAdapter,
  type CommandLineExecution,
} from './command-line-adapter.js';
import { buildCodexNonInteractiveArgs } from './codex-args.js';

/** Runs Codex CLI exec with MetaClaw's configured non-interactive argument set. */
export class CodexCliAdapter extends CommandLineExecutorAdapter {
  readonly name = 'codex-cli';

  protected buildSpawnArgs(prompt: string): string[] {
    return buildCodexNonInteractiveArgs(prompt, { ephemeral: false });
  }

  protected prepareExecution(prompt: string): CommandLineExecution {
    const captureDirectory = mkdtempSync(join(tmpdir(), 'metaclaw-codex-final-'));
    const finalMessagePath = join(captureDirectory, 'last-message.txt');

    return {
      args: buildCodexNonInteractiveArgs(prompt, {
        ephemeral: false,
        outputLastMessagePath: finalMessagePath,
      }),
      captureStdout: false,
      readFinalOutput: () => {
        try {
          const output = readFileSync(finalMessagePath, 'utf8');
          if (output.trim()) {
            return output;
          }
        } catch {
          // Missing and unreadable files are the same protocol failure to callers.
        }
        throw new Error('Codex executor completed without a final response');
      },
      cleanup: () => rmSync(captureDirectory, { recursive: true, force: true }),
    };
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
