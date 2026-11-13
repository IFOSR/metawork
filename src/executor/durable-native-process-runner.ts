import { readFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { DEFAULT_ATTEMPT_EXECUTION_LIMITS, type AttemptExecutionBackend } from '../execution/attempt-execution-backend.js';
import type { AttemptExecutionRepositoryPort } from '../execution/repositories.js';
import { OperationActivityMonitor } from './operation-activity-monitor.js';
import { parseToolStallFact } from './tool-stall-core.js';
import {
  SpawnLocalCliChildProcessRunner,
  type LocalCliChildProcessInput,
  type LocalCliChildProcessResult,
  type LocalCliChildProcessRunner,
} from './local-cli-executor-adapter.js';

/** Pi output adaptation stays in LocalCliExecutorAdapter; process ownership and
 * restart receipts stay in the same backend used by pause/cancel/recovery. */
export class DurableNativeProcessRunner implements LocalCliChildProcessRunner {
  private readonly active = new Map<string, { cancelled: boolean; id?: string; stop?: Promise<void> }>();
  private readonly corrections = new SpawnLocalCliChildProcessRunner();

  constructor(private readonly backend: AttemptExecutionBackend,
    private readonly repository: AttemptExecutionRepositoryPort) {}

  abort(attemptId?: string): void {
    this.corrections.abort(attemptId);
    for (const [id, state] of this.active) {
      if (attemptId && id !== attemptId) continue;
      state.cancelled = true;
      if (state.id && !state.stop) {
        state.stop = this.backend.stop(state.id);
        // run() observes the rejection; abort() is a synchronous notification.
        void state.stop.catch(() => undefined);
      }
    }
  }

  async run(input: LocalCliChildProcessInput): Promise<LocalCliChildProcessResult> {
    const binding = input.executionBinding;
    // Tool-free response correction has no workspace Attempt binding.
    if (!binding) return this.corrections.run(input);
    if (binding.attemptId !== input.attemptId) throw new Error('native_attempt_identity_mismatch');
    if (this.active.has(input.attemptId) || this.repository.find(input.attemptId)) {
      throw new Error('native_attempt_already_created');
    }
    const state: { cancelled: boolean; id?: string; stop?: Promise<void> } = { cancelled: false };
    this.active.set(input.attemptId, state);
    const startedAt = new Date().toISOString();
    let timer: ReturnType<typeof setInterval> | undefined;
    let observing = Promise.resolve();
    let observationError: unknown;
    let logs = '';
    const buffers = { stdout: '', stderr: '' };
    const captured = { stdout: '', stderr: '' };
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let detachOutput: (() => void) | undefined;
    let stallOffset = 0;
    const monitor = new OperationActivityMonitor({
      quietMs: input.idleTimeoutMs ?? 300_000,
      probe: async () => {
        const record = state.id ? await this.backend.inspect(state.id) : null;
        return { state: record?.status === 'exited' ? 'exited' : 'unknown',
          evidence: 'Native backend receipt; process existence alone does not prove progress' };
      },
      onHealth: health => input.onHealth?.(health),
    });
    const emitLine = (line: string, stream: 'stdout' | 'stderr') => {
      const activity = input.onLine?.(line, stream);
      if (activity) monitor.observe(activity);
    };
    const append = (chunk: Buffer | string, stream: 'stdout' | 'stderr') => {
      try {
        input.onRawChunk?.(chunk, stream);
        const text = decoders[stream].write(Buffer.from(chunk));
        captured[stream] = (captured[stream] + text).slice(-16 * 1024 * 1024);
        buffers[stream] += text;
        const lastBreak = buffers[stream].lastIndexOf('\n');
        if (lastBreak >= 0) {
          for (const line of buffers[stream].slice(0, lastBreak).split('\n')) emitLine(line, stream);
          buffers[stream] = buffers[stream].slice(lastBreak + 1);
        }
        if (buffers[stream].length > 8 * 1024 * 1024) throw new Error('native_output_record_too_large');
      } catch (error) {
        observationError = error;
        this.abort(input.attemptId);
      }
    };
    const observe = async () => {
      if (!state.id) return;
      if (!detachOutput) {
        const next = await this.backend.logs(state.id);
        const chunk = next.slice(logs.length);
        logs = next;
        if (chunk) append(chunk, 'stdout');
      }
      const stallPath = input.environment?.METACLAW_TOOL_STALL_FACTS;
      if (stallPath && input.onToolStall) {
        const content = await readFile(stallPath, 'utf8').catch(() => '');
        if (content.length < stallOffset) stallOffset = 0;
        const tail = content.slice(stallOffset);
        const lastBreak = tail.lastIndexOf('\n');
        if (lastBreak >= 0) {
          stallOffset += lastBreak + 1;
          for (const line of tail.slice(0, lastBreak).split('\n')) {
            const fact = parseToolStallFact(line);
            if (fact) input.onToolStall(fact);
          }
        }
      }
      monitor.tick();
    };
    try {
      const imageRef = 'bundled-pi-native';
      const record = await this.backend.create({
        attemptId: binding.attemptId, taskId: binding.taskId, generationId: binding.generationId,
        subtaskId: binding.subtaskId, workUnitId: binding.workUnitId, leaseToken: binding.leaseToken,
        idempotencyKey: binding.idempotencyKey, imageRef, resolvedImageId: await this.backend.resolveImage(imageRef),
        command: input.command, args: [...input.args], cwd: input.cwd,
        environment: input.environment ?? {},
        mounts: [
          { source: binding.workspacePath, target: '/workspace', mode: 'rw' },
          { source: binding.sourcePath, target: '/source', mode: 'ro' },
          { source: binding.inputsPath, target: '/inputs', mode: 'ro' },
          { source: binding.handoffsPath, target: '/handoffs', mode: 'ro' },
        ],
        controlNetwork: binding.controlNetwork, egressMode: 'disabled', limits: DEFAULT_ATTEMPT_EXECUTION_LIMITS,
      });
      state.id = record.containerId;
      this.repository.create({
        attemptId: binding.attemptId, taskId: binding.taskId, generationId: binding.generationId,
        subtaskId: binding.subtaskId, workUnitId: binding.workUnitId, workspaceId: binding.workspaceId,
        containerId: record.containerId, imageRef, imageId: record.imageId, status: 'created',
        leaseToken: binding.leaseToken, labels: record.labels, exitCode: null, resultCollectedAt: null,
        cleanupStatus: null, cleanupError: null, createdAt: startedAt, updatedAt: startedAt,
      });
      binding.onExecutionCreated?.(record.containerId);
      if (state.cancelled) throw new Error('native_attempt_cancelled_before_start');
      detachOutput = this.backend.onOutput?.(record.containerId, append);
      await this.backend.start(record.containerId);
      this.repository.update(binding.attemptId, { status: 'running' });
      // Cancellation may arrive while start is awaiting its launch receipt.
      if (state.cancelled) await this.backend.stop(record.containerId);
      timer = setInterval(() => {
        observing = observing.then(observe).catch(error => {
          observationError = error;
          this.abort(input.attemptId);
        });
      }, 100);
      timer.unref();
      const exitCode = await this.backend.wait(record.containerId);
      clearInterval(timer);
      await observing;
      await observe();
      for (const stream of ['stdout', 'stderr'] as const) {
        buffers[stream] += decoders[stream].end();
        if (buffers[stream]) emitLine(buffers[stream], stream);
      }
      if (state.stop) await state.stop;
      if (observationError) throw observationError;
      this.repository.update(binding.attemptId, {
        status: 'exited', exitCode, resultCollectedAt: new Date().toISOString(),
      });
      await this.backend.remove(record.containerId);
      this.repository.update(binding.attemptId, { status: 'removed', cleanupStatus: 'removed' });
      return { exitCode, stdout: captured.stdout,
        stderr: captured.stderr || (!detachOutput && exitCode !== 0 ? logs : '') };
    } catch (error) {
      if (state.id) {
        try {
          await this.backend.stop(state.id);
          await this.backend.remove(state.id);
          this.repository.update(binding.attemptId, { status: 'removed', cleanupStatus: 'removed' });
        } catch (cleanupError) {
          this.repository.update(binding.attemptId, {
            cleanupStatus: 'failed', cleanupError: String(cleanupError),
          });
          throw new AggregateError([error, cleanupError], 'Native execution cleanup remains unresolved');
        }
      }
      throw error;
    } finally {
      if (timer) clearInterval(timer);
      await observing;
      detachOutput?.();
      monitor.dispose();
      this.active.delete(input.attemptId);
    }
  }
}
