/**
 * Minimal Pi RPC client (upstream `--mode rpc`, ADR-0055 D6).
 *
 * MetaWork owns the process: it spawns Pi with an isolated environment, speaks
 * strict JSONL, correlates commands by `id`, and surfaces session events to the
 * Manager turn. Failures are `ManagerHostError`s so callers get the same codes
 * regardless of whether the fault is ours or Pi's.
 *
 * Framing follows the upstream contract: split records on LF only (never
 * `readline`, which also splits on U+2028/U+2029 — legal inside JSON strings).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { MANAGER_MAX_MESSAGE_BYTES, ManagerHostError } from './protocol.js';

export interface PiRpcClientOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly commandTimeoutMs?: number;
  readonly maxRecordBytes?: number;
  readonly killGraceMs?: number;
  readonly onDiagnostic?: (line: string) => void;
  readonly spawn?: typeof spawn;
}

export interface PiRpcResponse {
  readonly id?: string;
  readonly type: 'response';
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export type PiRpcEvent = Record<string, unknown> & { readonly type: string };

interface PendingCommand {
  readonly id: string;
  readonly resolve: (response: PiRpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout | null;
}

export class PiRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private commandCounter = 0;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly listeners = new Set<(event: PiRpcEvent) => void>();
  private readonly failureListeners = new Set<(error: ManagerHostError) => void>();
  private closed = false;

  constructor(private readonly options: PiRpcClientOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get running(): boolean {
    return this.child !== null;
  }

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Process-level failure (exit, spawn error, oversized or malformed output).
   * A turn waits on session events, not only on command responses, so it must be
   * able to fail when the child dies mid-turn instead of waiting for its timeout.
   */
  onFailure(listener: (error: ManagerHostError) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  async command(
    payload: Record<string, unknown> & { type: string },
    options: { timeoutMs?: number } = {},
  ): Promise<PiRpcResponse> {
    const id = this.nextId(payload.type);
    const child = this.ensureChild();
    const timeoutMs = options.timeoutMs ?? this.options.commandTimeoutMs ?? 60_000;
    return new Promise<PiRpcResponse>((resolvePromise, rejectPromise) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          rejectPromise(new ManagerHostError(
            'manager_timeout',
            `pi rpc command ${payload.type} exceeded ${timeoutMs}ms`,
            { requestId: id, retryable: true },
          ));
        }, timeoutMs)
        : null;
      timer?.unref();
      this.pending.set(id, { id, resolve: resolvePromise, reject: rejectPromise, timer });
      if (!this.write({ ...payload, id })) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        rejectPromise(new ManagerHostError('manager_process_exit', 'pi rpc process is not writable', {
          requestId: id,
        }));
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.failPending(new ManagerHostError('manager_process_exit', 'pi rpc client closed'));
    if (!child || child.exitCode !== null) return;
    await new Promise<void>(resolvePromise => {
      let timer: ReturnType<typeof setTimeout>;
      child.once('exit', () => { clearTimeout(timer); resolvePromise(); });
      child.kill('SIGTERM');
      timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolvePromise();
      }, this.options.killGraceMs ?? 2_000).unref();
    });
  }

  private nextId(command: string): string {
    this.commandCounter += 1;
    return `${command}-${process.pid}-${this.commandCounter}`;
  }

  private write(record: Record<string, unknown>): boolean {
    const child = this.child;
    if (!child || child.stdin.destroyed) return false;
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line, 'utf8') > (this.options.maxRecordBytes ?? MANAGER_MAX_MESSAGE_BYTES)) {
      return false;
    }
    try {
      child.stdin.write(line);
      return true;
    } catch {
      return false;
    }
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    if (this.closed) {
      throw new ManagerHostError('manager_not_running', 'pi rpc client is closed');
    }
    const spawnProcess = this.options.spawn ?? spawn;
    const child = spawnProcess(this.options.command, [...(this.options.args ?? [])], {
      env: this.options.env,
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    child.stdin.on('error', error => {
      this.failPending(new ManagerHostError('manager_process_exit', `pi rpc input failed: ${error.message}`));
      void this.close();
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/u)) {
        if (line.trim()) this.options.onDiagnostic?.(line.slice(0, 500));
      }
    });
    child.on('error', error => {
      this.child = null;
      this.failPending(new ManagerHostError('manager_spawn_failed', `pi rpc process failed: ${error.message}`, {
        cause: error,
      }));
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      this.failPending(new ManagerHostError(
        'manager_process_exit',
        `pi rpc process exited (code=${String(code)}, signal=${String(signal)})`,
        { retryable: code === 0 },
      ));
    });
    this.child = child;
    return child;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const record = this.buffer.slice(0, newline).replace(/\r$/u, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (record.trim()) {
        try {
          this.onRecord(record);
        } catch (error) {
          const failure = error instanceof ManagerHostError
            ? error
            : new ManagerHostError('manager_invalid_output', String(error), { cause: error });
          this.failPending(failure);
          void this.close();
          return;
        }
      }
      newline = this.buffer.indexOf('\n');
    }
    const max = this.options.maxRecordBytes ?? MANAGER_MAX_MESSAGE_BYTES;
    if (Buffer.byteLength(this.buffer, 'utf8') > max) {
      this.buffer = '';
      this.failPending(new ManagerHostError(
        'manager_response_too_large',
        `pi rpc output exceeds the ${max}-byte record limit`,
      ));
      void this.close();
    }
  }

  private onRecord(record: string): void {
    const max = this.options.maxRecordBytes ?? MANAGER_MAX_MESSAGE_BYTES;
    if (Buffer.byteLength(record, 'utf8') > max) {
      throw new ManagerHostError('manager_response_too_large', `pi rpc record exceeds ${max} bytes`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(record);
    } catch {
      throw new ManagerHostError('manager_invalid_output', 'pi rpc emitted a non-JSON record');
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new ManagerHostError('manager_invalid_output', 'pi rpc record must be an object');
    }
    const value = parsed as Record<string, unknown>;
    if (value.type === 'response') {
      const id = typeof value.id === 'string' ? value.id : undefined;
      const response: PiRpcResponse = {
        ...(id ? { id } : {}),
        type: 'response',
        command: typeof value.command === 'string' ? value.command : 'unknown',
        success: value.success === true,
        ...(value.data === undefined ? {} : { data: value.data }),
        ...(typeof value.error === 'string' ? { error: value.error } : {}),
      };
      const pending = id ? this.pending.get(id) : undefined;
      if (pending) {
        this.pending.delete(id as string);
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(response);
      }
      return;
    }
    if (typeof value.type !== 'string') return;
    for (const listener of this.listeners) {
      try {
        listener(value as PiRpcEvent);
      } catch {
        // A broken listener must not stall the record loop.
      }
    }
  }

  private failPending(error: ManagerHostError): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    for (const listener of this.failureListeners) {
      try {
        listener(error);
      } catch {
        // A broken listener must not mask the original failure.
      }
    }
  }
}
