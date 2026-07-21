// Adapts the Codex CLI into the shared non-interactive executor interface.
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildEnvFromFile } from '../utils/env-file.js';
import {
  CommandLineExecutorAdapter,
  type CommandLineExecution,
} from './command-line-adapter.js';
import { buildCodexNonInteractiveArgs, buildCodexResumeArgs } from './codex-args.js';
import type { ExecutorInput } from './adapter.js';
import type { ExecutorResult } from '../core/types.js';
import { runResponseOnlyCli } from './response-only-cli.js';

/** Runs Codex CLI exec with MetaClaw's configured non-interactive argument set. */
export class CodexCliAdapter extends CommandLineExecutorAdapter {
  readonly name = 'codex-cli';
  readonly supportsContinuation = true;

  protected buildSpawnArgs(prompt: string): string[] {
    return buildCodexNonInteractiveArgs(prompt, { ephemeral: false });
  }

  protected prepareExecution(prompt: string, input?: ExecutorInput): CommandLineExecution {
    const captureDirectory = mkdtempSync(join(tmpdir(), 'metaclaw-codex-final-'));
    const finalMessagePath = join(captureDirectory, 'last-message.txt');
    const continuationToken = input?.recovery?.mode === 'native_session'
      ? input.recovery.continuationToken
      : null;
    const args = continuationToken
      ? buildCodexResumeArgs(continuationToken, prompt, { outputLastMessagePath: finalMessagePath })
      : [
          ...buildCodexNonInteractiveArgs(prompt, {
            ephemeral: false,
            outputLastMessagePath: finalMessagePath,
          }),
        ];
    if (!continuationToken) args.splice(args.length - 3, 0, '--json');
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

  protected observeOutputLine(line: string, input: ExecutorInput): void {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type !== 'thread.started') return;
      const token = event.thread_id ?? event.session_id ?? event.threadId;
      if (typeof token === 'string' && token.trim()) input.recovery?.onContinuationToken?.(token.trim());
    } catch {
      // Non-JSON progress remains available through the common progress parser.
    }
  }

  protected buildSpawnEnv(input?: ExecutorInput): NodeJS.ProcessEnv {
    const token = input?.context.evidenceTools.binding?.bearerToken;
    return {
      ...buildEnvFromFile(process.env.METACLAW_CODEX_EXECUTOR_ENV_FILE),
      ...(process.env.METACLAW_EXECUTOR_CODEX_HOME
        ? { CODEX_HOME: process.env.METACLAW_EXECUTOR_CODEX_HOME }
        : {}),
      ...(token ? { METACLAW_EVIDENCE_TOKEN: token } : {}),
    };
  }

  async executeResponseOnly(input: { prompt: string; maxBytes: number }): Promise<ExecutorResult> {
    if (Buffer.byteLength(input.prompt, 'utf8') > input.maxBytes) {
      return { success: false, output: '', error: 'response-only correction input exceeds byte limit', exitCode: 1, durationMs: 0 };
    }
    const outputName = 'last-message.txt';
    return runResponseOnlyCli({
      command: this.config.command,
      args: [
        'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral',
        '--output-last-message', outputName, '--color', 'never', input.prompt,
      ],
      env: this.buildSpawnEnv(),
      timeoutSeconds: this.config.timeout,
      readOutput: (_stdout, workingDirectory) => readFileSync(join(workingDirectory, outputName), 'utf8'),
    });
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
