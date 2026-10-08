import type { Readable, Writable } from 'node:stream';

/** Public process events/streams used by Planner and Executor lifecycle owners. */
export interface ManagedProcess {
  readonly pid?: number;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'spawn', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'spawn', listener: () => void): this;
}
