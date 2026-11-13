import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeHostEnvironment } from './harness-driver.js';

const execFileAsync = promisify(execFile);

/** Budget for an optional user-installed tool that answers in milliseconds. */
export const DEFAULT_TOOL_PROBE_TIMEOUT_MS = 5_000;

/**
 * The managed Pi ships as a ~110 MB self-contained executable. Its first launch
 * after an install or update pays for image load and host scanning and can
 * take far longer than a short budget allows; every later launch answers in
 * well under a second.
 */
export const MANAGED_TOOL_PROBE_TIMEOUT_MS = 30_000;

/** One retry: the second launch runs warm, so a cold start is not a failure. */
export const MANAGED_TOOL_PROBE_RETRIES = 1;

/** Canonical outcome of one bounded host tool version probe. */
export type ToolProbeResult =
  | { kind: 'exit'; code: number; stdout: string; stderr: string }
  | { kind: 'missing' }
  | { kind: 'timeout' }
  | { kind: 'error'; detail: string };

/** Budget and retry count one probe consumer must honor. */
export interface ToolProbePolicy {
  readonly timeoutMs: number;
  readonly retries: number;
}

export const DEFAULT_TOOL_PROBE_POLICY: ToolProbePolicy = Object.freeze({
  timeoutMs: DEFAULT_TOOL_PROBE_TIMEOUT_MS,
  retries: 0,
});

export const MANAGED_TOOL_PROBE_POLICY: ToolProbePolicy = Object.freeze({
  timeoutMs: MANAGED_TOOL_PROBE_TIMEOUT_MS,
  retries: MANAGED_TOOL_PROBE_RETRIES,
});

/**
 * Runs a bounded host tool version probe and retries a timed-out launch.
 *
 * A managed binary pays its cold-start cost on the first run only. Reporting
 * that launch as a broken installation would block new work and fail real
 * attempts on a healthy tool, so the retry is part of the probe contract
 * instead of a consumer-specific workaround.
 */
export async function probeToolVersion(
  command: string,
  args: readonly string[],
  policy: ToolProbePolicy = DEFAULT_TOOL_PROBE_POLICY,
): Promise<ToolProbeResult> {
  let result = await runToolVersion(command, args, policy.timeoutMs);
  for (let attempt = 0; attempt < policy.retries && result.kind === 'timeout'; attempt += 1) {
    result = await runToolVersion(command, args, policy.timeoutMs);
  }
  return result;
}

async function runToolVersion(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ToolProbeResult> {
  try {
    const result = await execFileAsync(command, [...args], {
      env: safeHostEnvironment(process.env),
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    return {
      kind: 'exit',
      code: 0,
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  } catch (error) {
    const candidate = error as {
      code?: string | number;
      killed?: boolean;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (candidate.code === 'ENOENT') return { kind: 'missing' };
    if (candidate.killed || candidate.signal === 'SIGTERM') return { kind: 'timeout' };
    return {
      kind: 'exit',
      code: typeof candidate.code === 'number' ? candidate.code : 1,
      stdout: String(candidate.stdout ?? ''),
      stderr: String(candidate.stderr ?? candidate.message ?? ''),
    };
  }
}
