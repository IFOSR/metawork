import { existsSync } from 'node:fs';
import { readEnvFileIfExists } from '../utils/env-file.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';

export interface HarnessProbeResult {
  available: boolean;
  detail?: string;
}

export interface HarnessResultInput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type HarnessExecutorResult =
  | { success: true; output: string }
  | { success: false; output: ''; error: string };

export interface HarnessLaunchInput {
  prompt: string;
  cwd: string;
  runtimeHomePath: string;
}

export interface HarnessLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
}

export interface RuntimeHomeInput {
  attemptId: string;
  revisionId: string;
  agentClassId: string;
  bindingFingerprint: string;
  attemptsRoot: string;
}

export interface MaterializedRuntimeHome {
  homePath: string;
  environment: Record<string, string>;
}

export type ProbeCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface HarnessDriver {
  readonly id: string;
  readonly supportsContinuation?: boolean;
  readonly supportsResponseOnly?: boolean;
  probe(): Promise<HarnessProbeResult>;
  materializeHome(input: RuntimeHomeInput): Promise<MaterializedRuntimeHome>;
  buildLaunch(input: HarnessLaunchInput): HarnessLaunchSpec;
  parseResult(input: HarnessResultInput): HarnessExecutorResult;
}

/** Whitelists the host variables an Executor child process may inherit. */
export function safeHostEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    'COMSPEC',
    'LANG',
    'LC_ALL',
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
  ] as const;
  return Object.fromEntries(allowed.flatMap(key => {
    const value = environment[key];
    return value ? [[key, value]] : [];
  }));
}

/** Reads the operator-managed provider env file one Executor driver was assigned. */
export function readProviderEnvFile(envFile: string | undefined, label: string): NodeJS.ProcessEnv {
  if (!envFile) return {};
  if (!existsSync(envFile)) {
    throw new Error(`${label} executor env file does not exist: ${envFile}`);
  }
  const entries = readEnvFileIfExists(envFile);
  return Object.fromEntries(
    Object.entries(entries).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

export function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeHarnessResult(input: HarnessResultInput): HarnessExecutorResult {
  const output = input.stdout.trim();
  if (input.exitCode === 0) return { success: true, output };
  return {
    success: false,
    output: '',
    error: redactSensitiveText(input.stderr.trim() || `process exited with code ${input.exitCode ?? 'unknown'}`),
  };
}
