import { redactSensitiveText } from '../utils/redact-sensitive-text.js';

export interface HarnessProbeResult {
  available: boolean;
  detail?: string;
}

export interface HarnessResultInput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  streamedOutput?: string | null;
}

export interface HarnessProgressLineInput {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface HarnessProgressEvent {
  kind: 'status' | 'log' | 'skill';
  text: string;
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
  environment: Record<string, string>;
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
  parseResultLine?(input: HarnessProgressLineInput): string | null;
  parseProgressLine?(input: HarnessProgressLineInput): HarnessProgressEvent | null;
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

export function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeHarnessResult(input: HarnessResultInput): HarnessExecutorResult {
  const output = input.streamedOutput?.trim() || input.stdout.trim();
  if (input.exitCode === 0) return { success: true, output };
  return {
    success: false,
    output: '',
    error: redactSensitiveText(input.stderr.trim() || `process exited with code ${input.exitCode ?? 'unknown'}`),
  };
}

export function parseJsonLine(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function parseJsonLines(value: string): Record<string, unknown>[] {
  return value.split(/\r?\n/u)
    .map(parseJsonLine)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

export function safeHarnessName(value: unknown): string {
  const normalized = typeof value === 'string'
    ? value.trim().replace(/[^A-Za-z0-9_.:-]+/gu, '_')
    : '';
  return normalized.slice(0, 120) || 'unknown';
}

export function assistantMessageText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (message.role !== 'assistant') return null;
  if (typeof message.text === 'string' && message.text.trim()) return message.text.trim();
  if (!Array.isArray(message.content)) return null;
  const text = message.content
    .filter((item): item is Record<string, unknown> => (
      Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    ))
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => String(item.text))
    .join('\n')
    .trim();
  return text || null;
}
