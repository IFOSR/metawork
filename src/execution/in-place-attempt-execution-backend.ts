import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type {
  AttemptExecutionBackend,
  AttemptExecutionRecord,
  CreateAttemptExecutionInput,
} from './attempt-execution-backend.js';
import {
  processGroupOwnershipNow,
  reapProcessGroup,
  type ResidualProcessFact,
} from './process-group-reaper.js';

// Retained for compatibility with schema-v30 recovery and existing Docker labels.
const MANAGED_LABEL = 'io.metaclaw.attempt-sandbox';
const MAX_LOG_BYTES = 16 * 1024 * 1024;

interface InPlaceAttempt {
  input: CreateAttemptExecutionInput;
  record: AttemptExecutionRecord;
  workspacePath: string;
  child: ChildProcess | null;
  /** Real wall clock when the child was spawned; bounds group ownership. */
  groupCreatedAtMs: number | null;
  logs: string;
  waitPromise: Promise<number> | null;
  resolveWait: ((exitCode: number) => void) | null;
}

/**
 * Runs an Executor CLI as a child process in the authorized Conversation Workspace.
 *
 * This deliberately implements the existing AttemptExecutionBackend so the durable
 * attempt, cancellation, checkpoint, and recovery paths remain unchanged while
 * the Runtime moves away from sibling Executor containers.
 */
export class InPlaceAttemptExecutionBackend implements AttemptExecutionBackend {
  readonly kind = 'in_place' as const;
  readonly pathMode = 'native' as const;
  private readonly attempts = new Map<string, InPlaceAttempt>();

  async resolveImage(imageRef: string): Promise<string> {
    if (!imageRef.trim()) throw new Error('executor runtime profile is required');
    return `sha256:${createHash('sha256').update(`in_place:${imageRef}`).digest('hex')}`;
  }

  async probeControlNetwork(_controlNetwork: string): Promise<void> {
    // Native Executor processes share the Runtime network namespace. The
    // Docker-internal network check is only meaningful for container attempts.
  }

  async create(input: CreateAttemptExecutionInput): Promise<AttemptExecutionRecord> {
    const workspace = input.mounts.find(mount => mount.target === '/workspace');
    if (!workspace || workspace.mode !== 'rw') {
      throw new Error('in-place attempt requires one writable /workspace binding');
    }
    if (!input.command.trim()) throw new Error('in-place executor command is required');
    const workspaceInfo = await stat(workspace.source).catch(() => null);
    if (!workspaceInfo?.isDirectory()) {
      throw new Error(`in-place workspace does not exist: ${workspace.source}`);
    }
    const containerId = `in_place:${input.attemptId}`;
    const labels = {
      [MANAGED_LABEL]: 'true',
      'io.metaclaw.execution-backend': 'in_place',
      'io.metaclaw.task-id': input.taskId,
      'io.metaclaw.generation-id': input.generationId,
      'io.metaclaw.subtask-id': input.subtaskId,
      'io.metaclaw.attempt-id': input.attemptId,
      'io.metaclaw.work-unit-id': input.workUnitId,
      'io.metaclaw.lease-token': input.leaseToken,
      'io.metaclaw.idempotency-key': input.idempotencyKey,
    };
    const record: AttemptExecutionRecord = {
      containerId,
      imageId: await this.resolveImage(input.imageRef),
      status: 'created',
      exitCode: null,
      labels,
    };
    this.attempts.set(containerId, {
      input,
      record,
      workspacePath: workspace.source,
      child: null,
      groupCreatedAtMs: null,
      logs: '',
      waitPromise: null,
      resolveWait: null,
    });
    return record;
  }

  async start(containerId: string): Promise<void> {
    const attempt = this.requireAttempt(containerId);
    if (attempt.child) return;
    attempt.groupCreatedAtMs = processGroupOwnershipNow();
    const child = spawn(attempt.input.command, attempt.input.args, {
      cwd: attempt.workspacePath,
      env: {
        ...process.env,
        ...attempt.input.environment,
        METACLAW_EXECUTION_BACKEND: 'in_place',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    attempt.child = child;
    attempt.record.status = 'running';
    attempt.waitPromise = new Promise(resolve => {
      attempt.resolveWait = resolve;
    });
    const append = (chunk: Buffer | string) => {
      if (attempt.logs.length >= MAX_LOG_BYTES) return;
      const remaining = MAX_LOG_BYTES - Buffer.byteLength(attempt.logs, 'utf8');
      attempt.logs += Buffer.from(chunk).toString('utf8').slice(0, remaining);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', error => {
      append(`\n${error instanceof Error ? error.message : String(error)}\n`);
      this.finish(attempt, 127);
    });
    child.once('exit', (code, signal) => {
      if (signal) append(`\nprocess terminated by ${signal}\n`);
      // The Attempt owns its process group, not only the process it spawned.
      // Reap leftovers before the backend reports the Attempt as exited, so a
      // successful Attempt can never leave an unowned daemon behind.
      void this.reapResidualGroup(attempt, append).finally(() => {
        this.finish(attempt, code ?? 1);
      });
    });
  }

  async wait(containerId: string): Promise<number> {
    const attempt = this.requireAttempt(containerId);
    if (!attempt.waitPromise) {
      if (attempt.record.status === 'created') throw new Error('in-place attempt has not started');
      return attempt.record.exitCode ?? 1;
    }
    return attempt.waitPromise;
  }

  async logs(containerId: string): Promise<string> {
    return this.requireAttempt(containerId).logs;
  }

  async pause(containerId: string): Promise<void> {
    const attempt = this.requireAttempt(containerId);
    const pid = attempt.child?.pid;
    if (!pid || attempt.record.status !== 'running') return;
    if (process.platform === 'win32') throw new Error('in-place attempt pause is unavailable on Windows');
    process.kill(-pid, 'SIGSTOP');
    attempt.record.status = 'paused';
  }

  async resume(containerId: string): Promise<void> {
    const attempt = this.requireAttempt(containerId);
    const pid = attempt.child?.pid;
    if (!pid || attempt.record.status !== 'paused') return;
    if (process.platform === 'win32') throw new Error('in-place attempt resume is unavailable on Windows');
    process.kill(-pid, 'SIGCONT');
    attempt.record.status = 'running';
  }

  async inspect(containerId: string): Promise<AttemptExecutionRecord | null> {
    const attempt = this.attempts.get(containerId);
    return attempt ? { ...attempt.record, labels: { ...attempt.record.labels } } : null;
  }

  async stop(containerId: string): Promise<void> {
    const attempt = this.requireAttempt(containerId);
    const pid = attempt.child?.pid;
    if (!pid || ['created', 'exited', 'missing'].includes(attempt.record.status)) return;
    try {
      if (process.platform === 'win32') attempt.child?.kill('SIGTERM');
      else process.kill(-pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    if (attempt.waitPromise) {
      await Promise.race([
        attempt.waitPromise,
        new Promise(resolve => setTimeout(resolve, 2_000)),
      ]);
      if (attempt.record.status !== 'exited') {
        try {
          if (process.platform === 'win32') attempt.child?.kill('SIGKILL');
          else process.kill(-pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        await attempt.waitPromise;
      }
    }
  }

  async remove(containerId: string): Promise<void> {
    const attempt = this.requireAttempt(containerId);
    if (!['created', 'exited', 'missing'].includes(attempt.record.status)) {
      throw new Error('in-place attempt must be stopped before removal');
    }
    this.attempts.delete(containerId);
  }

  async listManaged(): Promise<AttemptExecutionRecord[]> {
    return [...this.attempts.values()].map(attempt => ({
      ...attempt.record,
      labels: { ...attempt.record.labels },
    }));
  }

  private requireAttempt(containerId: string): InPlaceAttempt {
    const attempt = this.attempts.get(containerId);
    if (!attempt) throw new Error(`in-place attempt not found: ${containerId}`);
    return attempt;
  }

  /**
   * Stop anything still running in the Attempt's process group and record the
   * bounded facts. A group that is already empty returns immediately, so a
   * well-behaved Attempt pays nothing.
   */
  private async reapResidualGroup(
    attempt: InPlaceAttempt,
    append: (chunk: string) => void,
  ): Promise<void> {
    const pid = attempt.child?.pid;
    if (!pid || process.platform === 'win32') return;
    const result = await reapProcessGroup({
      pgid: pid,
      graceMs: 1_000,
      sinceMs: attempt.groupCreatedAtMs ?? undefined,
    }).catch(() => null);
    if (!result || result.signalled === 'none') return;
    attempt.record.residualProcesses = result.members;
    const listed = result.members
      .map(member => `${member.command}(${member.pid})`)
      .join(', ') || 'unknown members';
    append(
      `\n[in_place] reaped ${result.members.length} residual process(es) after the Attempt `
      + `exited (${result.signalled}, ${listed})\n`,
    );
  }

  private finish(attempt: InPlaceAttempt, exitCode: number): void {
    if (attempt.record.status === 'exited') return;
    attempt.record.status = 'exited';
    attempt.record.exitCode = exitCode;
    attempt.resolveWait?.(exitCode);
    attempt.resolveWait = null;
  }
}
