import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorResult } from '../core/types.js';

const TERMINATION_GRACE_MS = 1000;

export async function runResponseOnlyCli(input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutSeconds: number;
  readOutput?: (stdout: string, workingDirectory: string) => string;
}): Promise<ExecutorResult> {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'metaclaw-response-only-'));
  const startedAt = Date.now();
  try {
    return await new Promise(resolve => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let forceKillTimer: NodeJS.Timeout | null = null;
      const child = spawn(input.command, input.args, {
        cwd: workingDirectory,
        env: input.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const finish = (result: ExecutorResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, TERMINATION_GRACE_MS);
      }, Math.max(1, input.timeoutSeconds) * 1000);
      child.stdout?.on('data', chunk => { stdout += String(chunk); });
      child.stderr?.on('data', chunk => { stderr += String(chunk); });
      child.on('error', error => finish({ success: false, output: '', error: error.message, exitCode: 1, durationMs: Date.now() - startedAt }));
      child.on('close', code => {
        if (timedOut) {
          finish({ success: false, output: '', error: 'response-only correction timeout', exitCode: 1, durationMs: Date.now() - startedAt });
          return;
        }
        if (code !== 0) {
          finish({ success: false, output: '', error: stderr.trim() || `response-only process exited ${code}`, exitCode: code ?? 1, durationMs: Date.now() - startedAt });
          return;
        }
        try {
          const output = input.readOutput ? input.readOutput(stdout, workingDirectory) : stdout.trim();
          finish({ success: Boolean(output.trim()), output, error: output.trim() ? undefined : 'empty response-only correction', exitCode: output.trim() ? 0 : 1, durationMs: Date.now() - startedAt });
        } catch (error) {
          finish({ success: false, output: '', error: error instanceof Error ? error.message : String(error), exitCode: 1, durationMs: Date.now() - startedAt });
        }
      });
    });
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}
