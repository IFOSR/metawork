import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DesktopActivationPort } from './desktop-activation.js';

const stages = ['waiting-desktop', 'verify', 'stop', 'updateRuntime', 'replaceShell',
  'startAndVerifyCandidate', 'restoreRuntime', 'restoreShell', 'startPrevious', 'complete'] as const;
type Stage = typeof stages[number];
const codes = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENOSPC', 'ECONNREFUSED', 'EADDRINUSE',
  'runtime-not-ready', 'desktop-not-ready', 'desktop-exited', 'identity-mismatch',
  'payload-rejected', 'desktop-not-exited', 'unexpected'] as const;
type FailureCode = typeof codes[number];
export interface DesktopUpdateDiagnostic {
  schemaVersion: 1;
  operation: 'update' | 'repair';
  stage: Stage;
  outcome: 'running' | 'committed' | 'rolled-back' | 'failed';
  updatedAt: string;
  failures: Array<{ stage: Stage; code: FailureCode }>;
}

function failureCode(error: unknown): FailureCode {
  if (!(error instanceof Error)) return 'unexpected';
  const code = (error as NodeJS.ErrnoException).code;
  if (codes.includes(code as FailureCode)) return code as FailureCode;
  const known: Record<string, FailureCode> = {
    '后台服务未能就绪，请检查安装与服务日志。': 'runtime-not-ready',
    'Previous Server did not become ready': 'runtime-not-ready',
    'Candidate desktop did not confirm authenticated Web readiness': 'desktop-not-ready',
    'Candidate desktop exited before health verification': 'desktop-exited',
    'Desktop Server identity mismatch': 'identity-mismatch',
    'Desktop release signature rejected': 'payload-rejected',
    'Runtime release signature rejected': 'payload-rejected',
    'Desktop did not exit': 'desktop-not-exited',
  };
  return known[error.message] ?? 'unexpected';
}

/** Diagnostic projection only: journals and native activation remain authoritative. */
export class DesktopUpdateDiagnostics {
  private readonly value: DesktopUpdateDiagnostic;
  constructor(private readonly root: string, operation: DesktopUpdateDiagnostic['operation']) {
    this.value = { schemaVersion: 1, operation, stage: 'waiting-desktop', outcome: 'running',
      updatedAt: new Date().toISOString(), failures: [] };
  }
  observe(port: DesktopActivationPort): DesktopActivationPort {
    return Object.fromEntries(Object.entries(port).map(([name, operation]) => [name, async () => {
      this.value.stage = name as Stage;
      await this.persist();
      try { await operation(); }
      catch (error) {
        this.addFailure(error);
        await this.persist();
        throw error;
      }
    }])) as unknown as DesktopActivationPort;
  }
  async finish(outcome: DesktopUpdateDiagnostic['outcome'], error?: unknown): Promise<void> {
    if (error !== undefined && this.value.failures.length === 0) this.addFailure(error);
    this.value.outcome = outcome;
    if (outcome === 'committed') this.value.stage = 'complete';
    await this.persist();
  }
  private addFailure(error: unknown): void {
    if (this.value.failures.length < 4) this.value.failures.push({ stage: this.value.stage, code: failureCode(error) });
  }
  private async persist(): Promise<void> {
    this.value.updatedAt = new Date().toISOString();
    const directory = join(this.root, 'upgrades');
    const file = join(directory, 'desktop-update-status.json');
    // Never copy exception messages, causes, paths, provider output or credentials.
    // A diagnostic write failure must not prevent the authoritative rollback.
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(this.value), { mode: 0o600 });
      await rename(temporary, file);
    } catch { /* The durable activation journal remains available. */ }
  }
}

export async function readDesktopUpdateDiagnostic(root: string): Promise<DesktopUpdateDiagnostic | null> {
  try {
    const raw = await readFile(join(root, 'upgrades/desktop-update-status.json'), 'utf8');
    if (Buffer.byteLength(raw) > 4096) return null;
    const value = JSON.parse(raw) as DesktopUpdateDiagnostic;
    if (value.schemaVersion !== 1 || !['update', 'repair'].includes(value.operation)
      || !stages.includes(value.stage) || !['running', 'committed', 'rolled-back', 'failed'].includes(value.outcome)
      || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
      || !Array.isArray(value.failures) || value.failures.length > 4
      || value.failures.some(failure => !failure || !stages.includes(failure.stage) || !codes.includes(failure.code))) return null;
    // Return only allowlisted fields, even if the file contains extra data.
    return { schemaVersion: 1, operation: value.operation, stage: value.stage, outcome: value.outcome,
      updatedAt: value.updatedAt, failures: value.failures.map(({ stage, code }) => ({ stage, code })) };
  } catch { return null; }
}
