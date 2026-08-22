export type ExecutionTracePhase =
  | 'authorization'
  | 'routing'
  | 'execution'
  | 'verification'
  | 'delivery';

export type ExecutionTraceActor = 'kernel' | 'runtime' | 'executor';
export type ExecutionTraceEventStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
export type ExecutionTraceStatus = 'running' | 'completed' | 'failed' | 'blocked';

/** Presentation-safe execution facts emitted by the Runtime to a Conversation. */
export interface ExecutionTraceAppendInput {
  phase: ExecutionTracePhase;
  actor: ExecutionTraceActor;
  kind: string;
  status: ExecutionTraceEventStatus;
  title: string;
  summary: string;
  details: Record<string, unknown>;
  eventKey: string;
  taskId?: string | null;
  traceStatus?: ExecutionTraceStatus;
}
