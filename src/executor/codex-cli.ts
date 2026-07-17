// Adapts the Codex CLI into the shared non-interactive executor interface.
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CommandLineExecutorAdapter,
  type CommandLineExecution,
} from './command-line-adapter.js';
import { buildCodexNonInteractiveArgs } from './codex-args.js';
import type { ExecutorInput } from './adapter.js';

/** Runs Codex CLI exec with MetaClaw's configured non-interactive argument set. */
export class CodexCliAdapter extends CommandLineExecutorAdapter {
  readonly name = 'codex-cli';

  protected buildSpawnArgs(prompt: string): string[] {
    return buildCodexNonInteractiveArgs(prompt, { ephemeral: false });
  }

  protected prepareExecution(prompt: string, input?: ExecutorInput): CommandLineExecution {
    const captureDirectory = mkdtempSync(join(tmpdir(), 'metaclaw-codex-final-'));
    const finalMessagePath = join(captureDirectory, 'last-message.txt');
    const args = buildCodexNonInteractiveArgs(prompt, {
      ephemeral: false,
      outputLastMessagePath: finalMessagePath,
    });
    args.splice(args.length - 1, 0, ...codexEvidenceArgs(input));

    return {
      args,
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

  protected buildSpawnEnv(input?: ExecutorInput): NodeJS.ProcessEnv {
    const token = input?.context.evidenceTools.binding?.bearerToken;
    return {
      ...process.env,
      ...(process.env.METACLAW_EXECUTOR_CODEX_HOME
        ? { CODEX_HOME: process.env.METACLAW_EXECUTOR_CODEX_HOME }
        : {}),
      ...(token ? { METACLAW_EVIDENCE_TOKEN: token } : {}),
    };
  }
}

function codexEvidenceArgs(input?: ExecutorInput): string[] {
  const binding = input?.context.evidenceTools.binding;
  if (!binding) return [];
  return [
    '-c', `mcp_servers.metaclaw_evidence.url=${JSON.stringify(binding.mcpUrl)}`,
    '-c', 'mcp_servers.metaclaw_evidence.bearer_token_env_var="METACLAW_EVIDENCE_TOKEN"',
  ];
}
