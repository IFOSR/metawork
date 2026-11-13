/**
 * Manager process runner (target contract design §1, ADR-0055 D6).
 *
 * Owns exactly one long-lived Manager child process and one in-flight turn at a
 * time (single-Task boundary, ADR-0011). Every failure mode is a typed
 * `ManagerHostError`: a stuck turn kills the process instead of leaking it, an
 * oversized or malformed answer never becomes a partial proposal, and a process
 * exit fails all pending work instead of hanging.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  MANAGER_DEFAULT_TURN_TIMEOUT_MS,
  MANAGER_HOST_PROTOCOL_VERSION,
  MANAGER_MAX_MESSAGE_BYTES,
  ManagerHostError,
  encodeManagerRequest,
  parseManagerResponse,
  type ManagerHostRequest,
  type ManagerHostResponse,
  type ManagerProposal,
  type ManagerTurnInput,
} from './protocol.js';

export interface ManagerProcessRunnerOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly defaultTimeoutMs?: number;
  readonly maxMessageBytes?: number;
  /** Grace period between SIGTERM and SIGKILL when a turn is aborted. */
  readonly killGraceMs?: number;
  readonly spawn?: typeof spawn;
}

interface PendingRequest {
  readonly requestId: string;
  readonly resolve: (response: ManagerHostResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout | null;
  readonly detachAbort: () => void;
  readonly expect: 'planned' | 'pong';
}

export class ManagerProcessRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private readonly pending = new Map<string, PendingRequest>();
  private exitError: ManagerHostError | null = null;
  private requestCounter = 0;
  private closing = false;

  constructor(private readonly options: ManagerProcessRunnerOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get running(): boolean {
    return this.child !== null;
  }

  async plan(
    input: ManagerTurnInput,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ManagerProposal> {
    const requestId = this.nextRequestId('plan');
    const response = await this.send(
      { type: 'plan', protocolVersion: MANAGER_HOST_PROTOCOL_VERSION, requestId, input },
      'planned',
      options,
    );
    if (response.type === 'error') {
      throw new ManagerHostError(response.code as ManagerHostError['code'], response.message, {
        retryable: response.retryable,
        requestId,
      });
    }
    if (response.type !== 'planned') {
      throw new ManagerHostError('manager_invalid_output', `unexpected ${response.type} for a plan request`, {
        requestId,
      });
    }
    return { proposal: response.proposal, usage: response.usage ?? [] };
  }

  async ping(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const requestId = this.nextRequestId('ping');
    const response = await this.send(
      { type: 'ping', protocolVersion: MANAGER_HOST_PROTOCOL_VERSION, requestId },
      'pong',
      options,
    );
    if (response.type === 'error') {
      throw new ManagerHostError(response.code as ManagerHostError['code'], response.message, {
        retryable: response.retryable,
        requestId,
      });
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    this.child = null;
    this.failPending(new ManagerHostError('manager_process_exit', 'manager process closed'));
    if (!child || child.exitCode !== null) return;
    await new Promise<void>(resolvePromise => {
      child.once('exit', () => resolvePromise());
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolvePromise();
      }, this.killGraceMs).unref();
    });
  }

  private get killGraceMs(): number {
    return this.options.killGraceMs ?? 2_000;
  }

  private nextRequestId(prefix: string): string {
    this.requestCounter += 1;
    return `${prefix}-${process.pid}-${this.requestCounter}`;
  }

  private send(
    request: ManagerHostRequest,
    expect: 'planned' | 'pong',
    options: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ManagerHostResponse> {
    return new Promise<ManagerHostResponse>((resolvePromise, rejectPromise) => {
      const child = this.ensureChild();
      if (!child) {
        rejectPromise(new ManagerHostError('manager_spawn_failed', 'manager process is not available', {
          requestId: request.requestId,
        }));
        return;
      }
      const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs ?? MANAGER_DEFAULT_TURN_TIMEOUT_MS;
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(request.requestId);
          // A stuck turn is killed: leaving it running would let a second turn
          // race the first one's output on the same pipe.
          void this.killForTimeout(request.requestId);
          rejectPromise(new ManagerHostError(
            'manager_timeout',
            `manager turn exceeded ${timeoutMs}ms`,
            { requestId: request.requestId, retryable: true },
          ));
        }, timeoutMs)
        : null;
      timer?.unref();

      const signal = options.signal;
      const onAbort = () => {
        const pending = this.pending.get(request.requestId);
        if (!pending) return;
        this.pending.delete(request.requestId);
        pending.timer && clearTimeout(pending.timer);
        // Best-effort cooperative cancel; the caller already has its answer.
        this.write({ type: 'cancel', protocolVersion: MANAGER_HOST_PROTOCOL_VERSION,
          requestId: this.nextRequestId('cancel'), targetRequestId: request.requestId });
        rejectPromise(new ManagerHostError('manager_cancelled', 'manager turn was cancelled', {
          requestId: request.requestId,
          retryable: true,
        }));
      };
      if (signal) {
        if (signal.aborted) {
          if (timer) clearTimeout(timer);
          rejectPromise(new ManagerHostError('manager_cancelled', 'manager turn was cancelled', {
            requestId: request.requestId,
            retryable: true,
          }));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(request.requestId, {
        requestId: request.requestId,
        expect,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
        detachAbort: () => signal?.removeEventListener('abort', onAbort),
      });
      if (!this.write(request)) {
        this.pending.delete(request.requestId);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        rejectPromise(new ManagerHostError('manager_process_exit', 'manager process is not writable', {
          requestId: request.requestId,
        }));
      }
    });
  }

  private write(request: ManagerHostRequest): boolean {
    const child = this.child;
    if (!child || child.stdin.destroyed) return false;
    try {
      child.stdin.write(encodeManagerRequest(request));
      return true;
    } catch {
      return false;
    }
  }

  private ensureChild(): ChildProcessWithoutNullStreams | null {
    if (this.child) return this.child;
    if (this.closing) return null;
    const spawnProcess = this.options.spawn ?? spawn;
    const child = spawnProcess(this.options.command, [...(this.options.args ?? [])], {
      env: this.options.env,
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.exitError = null;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Diagnostics only; never treated as protocol output.
      this.recordDiagnostic(chunk);
    });
    child.on('error', error => {
      this.failPending(new ManagerHostError('manager_spawn_failed', `manager process failed: ${error.message}`, {
        cause: error,
      }));
      this.child = null;
      this.exitError = new ManagerHostError('manager_spawn_failed', error.message, { cause: error });
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      const error = new ManagerHostError(
        'manager_process_exit',
        `manager process exited (code=${String(code)}, signal=${String(signal)})`,
        { retryable: code === 0 },
      );
      this.exitError = error;
      this.failPending(error);
    });
    this.child = child;
    return child;
  }

  /** Last few stderr lines, for diagnostics only (never parsed as protocol). */
  private diagnostics: string[] = [];

  private recordDiagnostic(chunk: string): void {
    for (const line of chunk.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      this.diagnostics.push(line.slice(0, 500));
      if (this.diagnostics.length > 20) this.diagnostics.shift();
    }
  }

  get recentDiagnostics(): readonly string[] {
    return this.diagnostics;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.onLine(line);
      newline = this.buffer.indexOf('\n');
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > (this.options.maxMessageBytes ?? MANAGER_MAX_MESSAGE_BYTES)) {
      const error = new ManagerHostError(
        'manager_response_too_large',
        `manager buffered output exceeds the ${this.options.maxMessageBytes ?? MANAGER_MAX_MESSAGE_BYTES}-byte limit`,
        { retryable: false },
      );
      this.buffer = '';
      this.failPending(error);
      void this.close();
    }
  }

  private onLine(line: string): void {
    const maxBytes = this.options.maxMessageBytes ?? MANAGER_MAX_MESSAGE_BYTES;
    if (Buffer.byteLength(line, 'utf8') > maxBytes) {
      const error = new ManagerHostError(
        'manager_response_too_large',
        `manager output line exceeds the ${maxBytes}-byte limit`,
      );
      this.failPending(error);
      void this.close();
      return;
    }
    let response: ManagerHostResponse;
    try {
      response = parseManagerResponse(line);
    } catch (error) {
      const failure = error instanceof ManagerHostError
        ? error
        : new ManagerHostError('manager_invalid_output', String(error));
      // An unparsable answer cannot be attributed safely beyond its requestId.
      if (failure.requestId) {
        const pending = this.takePending(failure.requestId);
        pending?.reject(failure);
        return;
      }
      this.failPending(failure);
      return;
    }
    const pending = this.takePending(response.requestId);
    if (!pending) return; // Late answer for an abandoned request.
    if (response.type === 'error' && pending.expect !== 'planned') {
      pending.reject(new ManagerHostError(response.code as ManagerHostError['code'], response.message, {
        retryable: response.retryable,
        requestId: response.requestId,
      }));
      return;
    }
    if (pending.expect === 'planned' && response.type === 'pong') {
      pending.reject(new ManagerHostError('manager_invalid_output', 'manager answered a plan with pong', {
        requestId: response.requestId,
      }));
      return;
    }
    if (pending.expect === 'pong' && response.type === 'planned') {
      pending.reject(new ManagerHostError('manager_invalid_output', 'manager answered a ping with a proposal', {
        requestId: response.requestId,
      }));
      return;
    }
    pending.resolve(response);
  }

  private takePending(requestId: string): PendingRequest | null {
    const pending = this.pending.get(requestId);
    if (!pending) return null;
    this.pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.detachAbort();
    return pending;
  }

  private async killForTimeout(requestId: string): Promise<void> {
    const child = this.child;
    if (!child) return;
    const error = new ManagerHostError('manager_timeout', `manager turn ${requestId} timed out`, {
      requestId,
      retryable: true,
    });
    this.child = null;
    this.failPending(error);
    await new Promise<void>(resolvePromise => {
      child.once('exit', () => resolvePromise());
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolvePromise();
      }, this.killGraceMs).unref();
    });
  }

  private failPending(error: ManagerHostError): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.detachAbort();
      entry.reject(error);
    }
  }

  /** Diagnostics for the last failed turn; deliberately excludes turn content. */
  get lastExitError(): ManagerHostError | null {
    return this.exitError;
  }
}
