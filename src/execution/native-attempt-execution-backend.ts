import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { boundedPathSegment } from '../utils/bounded-path-segment.js';
import { withWorkspaceGitLock } from './workspace-git-lock.js';
import type {
  AttemptExecutionBackend,
  AttemptExecutionRecord,
  CreateAttemptExecutionInput,
} from './attempt-execution-backend.js';
import {
  processGroupOwnershipNow,
  processGroupAlive,
  reapProcessGroup,
  type ResidualProcessFact,
} from './process-group-reaper.js';

// Retained for compatibility with schema-v30 recovery and existing Docker labels.
const MANAGED_LABEL = 'io.metaclaw.attempt-sandbox';
const MAX_LOG_BYTES = 16 * 1024 * 1024;

interface NativeAttempt {
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

interface NativeReceipt {
  record: AttemptExecutionRecord;
  pid: number | null;
  processStart: string | null;
  groupCreatedAtMs: number;
  token: string;
}

// The host records its own identity before launching business code. Recovery
// and launch share a short mutex: a delayed host cannot launch after recovery
// has declared an unstarted intent missing. No environment/secrets are stored.
const NATIVE_HOST = `
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
const [path, gate, token, command, args] = process.argv.slice(1);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const candidate=gate + '.candidate-' + token;
mkdirSync(candidate);
writeFileSync(candidate + '/owner.json', JSON.stringify({pid:process.pid, token}));
for (;;) {
  try { renameSync(candidate,gate); break; } catch (error) {
    if (!['EEXIST','ENOTEMPTY'].includes(error.code)) throw error;
    try {
      const old = JSON.parse(readFileSync(gate + '/owner.json', 'utf8'));
      try { process.kill(old.pid, 0); } catch (error) {
        if (error.code === 'ESRCH') rmSync(gate, {recursive: true, force: true});
      }
    } catch {}
    await pause(25);
  }
}
let receipt;
const save = () => { writeFileSync(path + '.' + token, JSON.stringify(receipt), {mode:0o600}); renameSync(path + '.' + token, path); };
try {
  receipt = JSON.parse(readFileSync(path, 'utf8'));
  if (receipt.token !== token || receipt.record.status !== 'created') process.exitCode = 1;
  else {
    receipt.pid = process.pid;
    receipt.groupCreatedAtMs = Date.now();
    receipt.processStart = execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {encoding:'utf8'}).trim();
    receipt.record.status = 'running'; save();
  }
} finally { rmSync(gate, {recursive:true,force:true}); }
if (receipt?.record.status === 'running' && receipt.pid === process.pid) {
  const child = spawn(command, JSON.parse(args), {stdio:'inherit', env:process.env});
  const finish = code => { receipt.record.status = 'exited'; receipt.record.exitCode = code; save(); process.exitCode = code; };
  child.once('error', () => finish(127));
  child.once('exit', code => finish(code ?? 1));
}
`;

const execFileAsync = promisify(execFile);
async function processStart(pid: number): Promise<string | null> {
  return execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {timeout: 5_000})
    .then(result => result.stdout.trim() || null, () => null);
}

/**
 * Runs an Executor CLI as a child process in the authorized Conversation Workspace.
 *
 * This deliberately implements the existing AttemptExecutionBackend so the durable
 * attempt, cancellation, checkpoint, and recovery paths remain unchanged while
 * the Runtime moves away from sibling Executor containers.
 */
export class NativeAttemptExecutionBackend implements AttemptExecutionBackend {
  readonly kind = 'native' as const;
  readonly pathMode = 'native' as const;
  private readonly attempts = new Map<string, NativeAttempt>();
  constructor(private readonly stateRoot?: string) {}

  private receiptPath(containerId: string): string {
    return join(this.stateRoot!, boundedPathSegment(containerId, {prefix: 'attempt'}) + '.json');
  }

  private gate(containerId: string): string {
    return `launch-${boundedPathSegment(containerId, {prefix: 'attempt'})}`;
  }

  private async saveReceipt(containerId: string, receipt: NativeReceipt): Promise<void> {
    const path = this.receiptPath(containerId);
    const temp = `${path}.${randomUUID()}`;
    await writeFile(temp, JSON.stringify(receipt), {mode: 0o600});
    await rename(temp, path);
  }

  private async readReceipt(containerId: string): Promise<NativeReceipt | null> {
    if (!this.stateRoot) return null;
    return readFile(this.receiptPath(containerId), 'utf8').then(value => JSON.parse(value) as NativeReceipt, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
  }

  async resolveImage(imageRef: string): Promise<string> {
    if (!imageRef.trim()) throw new Error('executor runtime profile is required');
    return `sha256:${createHash('sha256').update(`native:${imageRef}`).digest('hex')}`;
  }

  async probeControlNetwork(_controlNetwork: string): Promise<void> {
    // Native Executor processes share the Runtime network namespace. The
    // Docker-internal network check is only meaningful for container attempts.
  }

  async create(input: CreateAttemptExecutionInput): Promise<AttemptExecutionRecord> {
    const workspace = input.mounts.find(mount => mount.target === '/workspace');
    if (!workspace || workspace.mode !== 'rw') {
      throw new Error('native attempt requires one writable /workspace binding');
    }
    if (!input.command.trim()) throw new Error('native executor command is required');
    const workspaceInfo = await stat(workspace.source).catch(() => null);
    if (!workspaceInfo?.isDirectory()) {
      throw new Error(`native workspace does not exist: ${workspace.source}`);
    }
    const containerId = `native:${input.attemptId}`;
    const labels = {
      [MANAGED_LABEL]: 'true',
      'io.metaclaw.execution-backend': 'native',
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
    if (this.stateRoot) {
      await mkdir(this.stateRoot, {recursive: true, mode: 0o700});
      await this.saveReceipt(containerId, {record, pid: null, processStart: null, groupCreatedAtMs: Date.now(), token: randomUUID()});
    }
    return record;
  }

  async start(containerId: string): Promise<void> {
    const attempt = this.requireAttempt(containerId);
    if (attempt.child) return;
    attempt.groupCreatedAtMs = processGroupOwnershipNow();
    const receipt = await this.readReceipt(containerId);
    const child = receipt
      ? spawn(process.execPath, ['--input-type=module', '-e', NATIVE_HOST, this.receiptPath(containerId),
        join(this.stateRoot!, `metawork-${this.gate(containerId)}.lock`), receipt.token, attempt.input.command, JSON.stringify(attempt.input.args)], {
        cwd: attempt.workspacePath, env: {...process.env, ...attempt.input.environment, METACLAW_EXECUTION_BACKEND: 'native'},
        stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true,
      })
      : spawn(attempt.input.command, attempt.input.args, {
      cwd: attempt.workspacePath,
      env: {
        ...process.env,
        ...attempt.input.environment,
        METACLAW_EXECUTION_BACKEND: 'native',
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
      void this.reapResidualGroup(attempt, append).then(() => {
        this.finish(attempt, code ?? 1);
      }, error => { append(`\n${String(error)}\n`); });
    });
  }

  async wait(containerId: string): Promise<number> {
    const attempt = this.requireAttempt(containerId);
    if (!attempt.waitPromise) {
      if (attempt.record.status === 'created') throw new Error('native attempt has not started');
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
    if (process.platform === 'win32') throw new Error('native attempt pause is unavailable on Windows');
    process.kill(-pid, 'SIGSTOP');
    attempt.record.status = 'paused';
  }

  async resume(containerId: string): Promise<void> {
    const attempt = this.requireAttempt(containerId);
    const pid = attempt.child?.pid;
    if (!pid || attempt.record.status !== 'paused') return;
    if (process.platform === 'win32') throw new Error('native attempt resume is unavailable on Windows');
    process.kill(-pid, 'SIGCONT');
    attempt.record.status = 'running';
  }

  async inspect(containerId: string): Promise<AttemptExecutionRecord | null> {
    const attempt = this.attempts.get(containerId);
    if (attempt) return {...attempt.record, labels: {...attempt.record.labels}};
    const receipt = await this.readReceipt(containerId);
    if (!receipt) return null;
    return withWorkspaceGitLock(this.stateRoot!, this.gate(containerId), async () => {
      const current = (await this.readReceipt(containerId))!;
      if (current.record.status === 'created') {
        current.record.status = 'missing';
        await this.saveReceipt(containerId, current);
      } else if (current.pid && ['running','paused','exited'].includes(current.record.status)) {
        const identity = await processStart(current.pid);
        if (identity && identity !== current.processStart) throw new Error('native_process_identity_changed');
        if (!identity && processGroupAlive(current.pid)) current.record.status = 'running';
        if (!identity && !processGroupAlive(current.pid)) current.record.status = 'exited';
        else if (current.record.status === 'exited') current.record.status = 'running';
      }
      return {...current.record, labels: {...current.record.labels}};
    });
  }

  async stop(containerId: string): Promise<void> {
    if (!this.attempts.has(containerId) && this.stateRoot) {
      await this.inspect(containerId); // Fence PID reuse and unstarted launch intents.
      const receipt = await this.readReceipt(containerId);
      if (!receipt) return;
      if (receipt.pid && processGroupAlive(receipt.pid)) {
        const result = await reapProcessGroup({pgid: receipt.pid, sinceMs: receipt.groupCreatedAtMs});
        if (!result.reaped || processGroupAlive(receipt.pid)) throw new Error('native_process_exit_unconfirmed');
      }
      receipt.record.status = 'exited';
      await this.saveReceipt(containerId, receipt);
      return;
    }
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
        await Promise.race([attempt.waitPromise, new Promise(resolve => setTimeout(resolve, 2_000))]);
        if (!['exited'].includes(attempt.record.status)) throw new Error('native_process_exit_unconfirmed');
      }
    }
  }

  async remove(containerId: string): Promise<void> {
    const observed = await this.inspect(containerId);
    if (observed && !['created','exited','missing'].includes(observed.status)) throw new Error('native attempt must be stopped before removal');
    if (this.stateRoot) await rm(this.receiptPath(containerId), {force: true});
    const attempt = this.attempts.get(containerId);
    if (!attempt) return;
    if (!['created', 'exited', 'missing'].includes(attempt.record.status)) {
      throw new Error('native attempt must be stopped before removal');
    }
    this.attempts.delete(containerId);
  }

  async listManaged(): Promise<AttemptExecutionRecord[]> {
    const recovered: AttemptExecutionRecord[] = [];
    if (this.stateRoot) {
      await mkdir(this.stateRoot, {recursive: true, mode: 0o700});
      for (const file of await readdir(this.stateRoot)) {
        if (!file.endsWith('.json')) continue;
        const receipt = JSON.parse(await readFile(join(this.stateRoot, file), 'utf8')) as NativeReceipt;
        if (this.attempts.has(receipt.record.containerId)) continue;
        const record = await this.inspect(receipt.record.containerId);
        if (record) recovered.push(record);
      }
    }
    return [...recovered, ...[...this.attempts.values()].map(attempt => ({
      ...attempt.record,
      labels: { ...attempt.record.labels },
    }))];
  }

  private requireAttempt(containerId: string): NativeAttempt {
    const attempt = this.attempts.get(containerId);
    if (!attempt) throw new Error(`native attempt not found: ${containerId}`);
    return attempt;
  }

  /**
   * Stop anything still running in the Attempt's process group and record the
   * bounded facts. A group that is already empty returns immediately, so a
   * well-behaved Attempt pays nothing.
   */
  private async reapResidualGroup(
    attempt: NativeAttempt,
    append: (chunk: string) => void,
  ): Promise<void> {
    const pid = attempt.child?.pid;
    if (!pid || process.platform === 'win32') return;
    const result = await reapProcessGroup({
      pgid: pid,
      graceMs: 1_000,
      sinceMs: attempt.groupCreatedAtMs ?? undefined,
    }).catch(() => null);
    if (result && !result.reaped) throw new Error('native_process_exit_unconfirmed');
    if (processGroupAlive(pid)) throw new Error('native_process_exit_unconfirmed');
    if (!result || result.signalled === 'none') return;
    attempt.record.residualProcesses = result.members;
    const listed = result.members
      .map(member => `${member.command}(${member.pid})`)
      .join(', ') || 'unknown members';
    append(
      `\n[native] reaped ${result.members.length} residual process(es) after the Attempt `
      + `exited (${result.signalled}, ${listed})\n`,
    );
  }

  private finish(attempt: NativeAttempt, exitCode: number): void {
    if (attempt.record.status === 'exited') return;
    attempt.record.status = 'exited';
    attempt.record.exitCode = exitCode;
    attempt.resolveWait?.(exitCode);
    attempt.resolveWait = null;
  }
}
