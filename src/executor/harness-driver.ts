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

export function normalizeHarnessResult(input: HarnessResultInput): HarnessExecutorResult {
  const output = input.stdout.trim();
  if (input.exitCode === 0) return { success: true, output };
  return {
    success: false,
    output: '',
    error: redactSensitiveText(input.stderr.trim() || `process exited with code ${input.exitCode ?? 'unknown'}`),
  };
}
