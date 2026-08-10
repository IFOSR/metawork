export type ExecutionMountMode = 'ro' | 'rw';

/** Execution backends supported by the Runtime. */
export type AttemptExecutionBackendKind = 'container' | 'worktree';

/** Whether Executor prompts use container aliases or native Runtime paths. */
export type AttemptExecutionPathMode = 'container' | 'native';

export interface AttemptExecutionMount {
  source: string;
  target: string;
  mode: ExecutionMountMode;
}

export interface AttemptExecutionLimits {
  cpus: number;
  memoryBytes: number;
  pids: number;
  tmpfsBytes: number;
  logSize: string;
  logFiles: number;
}

export interface CreateAttemptExecutionInput {
  attemptId: string;
  taskId: string;
  generationId: string;
  subtaskId: string;
  workUnitId: string;
  leaseToken: string;
  idempotencyKey: string;
  imageRef: string;
  resolvedImageId: string;
  command: string;
  args: string[];
  environment: Record<string, string>;
  mounts: AttemptExecutionMount[];
  controlNetwork: string;
  egressMode: 'disabled' | 'proxy';
  nestedSandbox?: 'codex-workspace-write';
  limits: AttemptExecutionLimits;
}

export interface AttemptExecutionRecord {
  containerId: string;
  imageId: string;
  status: 'created' | 'running' | 'paused' | 'exited' | 'missing';
  exitCode: number | null;
  labels: Record<string, string>;
}

export interface AttemptExecutionBackend {
  readonly kind?: AttemptExecutionBackendKind;
  readonly pathMode?: AttemptExecutionPathMode;
  resolveImage(imageRef: string): Promise<string>;
  probeControlNetwork?(controlNetwork: string): Promise<void>;
  create(input: CreateAttemptExecutionInput): Promise<AttemptExecutionRecord>;
  start(containerId: string): Promise<void>;
  wait(containerId: string): Promise<number>;
  logs(containerId: string): Promise<string>;
  pause(containerId: string): Promise<void>;
  resume(containerId: string): Promise<void>;
  inspect(containerId: string): Promise<AttemptExecutionRecord | null>;
  stop(containerId: string): Promise<void>;
  remove(containerId: string): Promise<void>;
  listManaged(): Promise<AttemptExecutionRecord[]>;
}

export const DEFAULT_ATTEMPT_EXECUTION_LIMITS: AttemptExecutionLimits = {
  cpus: 2,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  pids: 256,
  tmpfsBytes: 512 * 1024 * 1024,
  logSize: '10m',
  logFiles: 3,
};
