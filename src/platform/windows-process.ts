import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { WindowsNativeStream, type WindowsStreamPrimitives } from './windows-native-stream.js';

interface SpawnedProcess {
  handle: object;
  pid: number;
  stdin: object;
  stdout: object;
  stderr: object;
}

export interface WindowsProcessPrimitives extends WindowsStreamPrimitives {
  processSpawn(executable: string, commandLine: string, cwd: string, environment: string): SpawnedProcess;
  processStatus(handle: object): { exitCode: number | null; activeProcesses: number };
  processKill(handle: object): void;
  processPause(handle: object): Promise<void>;
  processResume(handle: object): Promise<void>;
  processDispose(handle: object): boolean;
}

export function loadWindowsProcesses(modulePath: string): WindowsProcessPrimitives {
  if (process.platform !== 'win32' || !isAbsolute(modulePath)) throw new Error('Absolute Windows platform module required');
  const addon: unknown = createRequire(import.meta.url)(modulePath);
  if (!addon || typeof addon !== 'object' || !['processSpawn', 'processStatus', 'processKill', 'processPause',
    'processResume', 'processDispose', 'pipeRead', 'pipeWrite', 'pipeWriteReady', 'pipeClose']
    .every(name => typeof (addon as Record<string, unknown>)[name] === 'function')) {
    throw new Error('Incompatible Windows process adapter');
  }
  return addon as WindowsProcessPrimitives;
}

/** Microsoft CRT argv quoting; no command shell participates in this launch. */
export function quoteWindowsArgument(value: string): string {
  if (value.includes('\0')) throw new Error('NUL in process argument');
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`;
}

export function windowsEnvironmentBlock(environment: NodeJS.ProcessEnv): string {
  const entries = new Map<string, { key: string; value: string }>();
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (!key || key.includes('=') || key.includes('\0') || value.includes('\0')) throw new Error('Invalid process environment');
    const normalized = key.toUpperCase();
    if (entries.has(normalized)) throw new Error(`Duplicate Windows environment variable: ${key}`);
    entries.set(normalized, { key, value });
  }
  return [...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, entry]) => `${entry.key}=${entry.value}`).join('\0') + '\0\0';
}

export interface WindowsProcessInput {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** An owned process group. Exit is reported only after all Job members and stdio settle. */
export class WindowsOwnedProcess extends EventEmitter<{
  spawn: [];
  error: [Error];
  exit: [number | null, NodeJS.Signals | null];
  close: [number | null, NodeJS.Signals | null];
}> {
  readonly pid: number;
  readonly stdin: WindowsNativeStream;
  readonly stdout: WindowsNativeStream;
  readonly stderr: WindowsNativeStream;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  private readonly handle: object;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private referenced = true;
  private failure?: Error;

  constructor(private readonly native: WindowsProcessPrimitives, input: WindowsProcessInput) {
    super();
    if (!isAbsolute(input.executable) || !isAbsolute(input.cwd)) throw new Error('Owned process requires absolute executable and cwd');
    const child = native.processSpawn(input.executable, [input.executable, ...input.args].map(quoteWindowsArgument).join(' '),
      input.cwd, windowsEnvironmentBlock(input.env));
    this.pid = child.pid;
    this.handle = child.handle;
    this.stdin = new WindowsNativeStream(native, child.stdin);
    this.stdout = new WindowsNativeStream(native, child.stdout);
    this.stderr = new WindowsNativeStream(native, child.stderr);
    for (const stream of [this.stdin, this.stdout, this.stderr]) {
      stream.on('error', error => {
        this.failure ??= error;
        this.kill('SIGKILL');
      });
    }
    // These are plain byte streams, never authenticated WindowsPipeStream objects.
    queueMicrotask(() => { this.emit('spawn'); this.poll(); });
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.closed) return false;
    if (signal !== 'SIGTERM' && signal !== 'SIGKILL') throw new Error('Use explicit Job pause/resume; Windows signals are not emulated');
    this.native.processKill(this.handle);
    this.killed = true;
    this.signalCode = signal;
    return true;
  }

  async pause(): Promise<void> {
    if (this.closed || this.killed) throw new Error('Cannot pause a stopped process');
    await this.native.processPause(this.handle);
    if (this.killed) throw new Error('Process was cancelled during pause');
  }

  async resume(): Promise<void> {
    if (this.closed || this.killed) throw new Error('Cannot resume a stopped process');
    await this.native.processResume(this.handle);
  }

  ref(): this { this.referenced = true; this.timer?.ref(); return this; }
  unref(): this { this.referenced = false; this.timer?.unref(); return this; }

  private poll(): void {
    if (this.closed) return;
    try {
      const status = this.native.processStatus(this.handle);
      if (status.exitCode !== null) {
        // A CLI root cannot leave background descendants outside its attempt's
        // lifetime. Retain the Job until termination is confirmed by the kernel.
        if (status.activeProcesses > 0) this.native.processKill(this.handle);
        else {
          this.stdin.destroy();
          if ([this.stdout, this.stderr].every(stream => stream.readableEnded || stream.destroyed)
            && this.native.processDispose(this.handle)) {
            this.closed = true;
            this.exitCode = this.signalCode ? null : status.exitCode;
            this.stdout.destroy(); this.stderr.destroy();
            if (this.failure) this.emit('error', this.failure);
            this.emit('exit', this.exitCode, this.signalCode);
            this.emit('close', this.exitCode, this.signalCode);
            return;
          }
        }
      }
    } catch (error) {
      this.failure ??= error instanceof Error ? error : new Error(String(error));
      // Uncertain cleanup never becomes an exit/completion fact.
      this.native.processKill(this.handle);
    }
    this.timer = setTimeout(() => this.poll(), 5);
    if (!this.referenced) this.timer.unref();
  }
}
