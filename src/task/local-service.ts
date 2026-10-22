export interface LocalServiceSpecification {
  serviceId: string;
  taskId: string;
  command: string;
  args: string[];
  directory?: string;
  environmentReferences: Record<string, string>;
  host: '127.0.0.1' | '::1';
  port: number;
  healthPath: string;
  startupTimeoutMs: number;
  restartPolicy: 'explicit';
}
export type LocalServiceState = 'starting' | 'healthy' | 'unhealthy' | 'stopped' | 'failed';
export interface LocalServiceRecord {
  accountId: string;
  specification: LocalServiceSpecification;
  state: LocalServiceState;
  processId: number | null;
  processToken: string | null;
  healthMessage: string | null;
  updatedAt: string;
}
export interface LocalServiceStore {
  find(serviceId: string): LocalServiceRecord | null;
  list(): LocalServiceRecord[];
  save(record: LocalServiceRecord): void;
  findOperation(decisionId: string): LocalServiceEffect | null;
  saveOperation(effect: LocalServiceEffect): void;
}
export interface LocalServiceView {
  serviceId: string;
  taskId: string;
  state: LocalServiceState;
  url: string;
  message: string | null;
}

export type LocalServiceOperation = 'start' | 'stop' | 'restart';

/** Runtime effect checkpoint, subordinate to an already-authorized Kernel decision. */
export interface LocalServiceEffect {
  decisionId: string;
  serviceId: string;
  operation: LocalServiceOperation;
  phase: 'stopping' | 'starting' | 'completed';
  initialToken: string | null;
  result: LocalServiceView | null;
  error: string | null;
}
