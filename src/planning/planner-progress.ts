export type PlannerRunProgressPayload =
  | { kind: 'process_started' }
  | { kind: 'prompt_accepted' }
  | { kind: 'agent_started' }
  | { kind: 'turn_started'; turn: number }
  | { kind: 'model_stream_started'; turn: number }
  | { kind: 'model_waiting'; turn: number; idleMs: number }
  | ({ kind: 'tool_started' } & PlannerToolProgress)
  | ({ kind: 'tool_completed' } & PlannerToolProgress & {
      status: 'completed' | 'failed';
      resultFields: string[];
    })
  | { kind: 'agent_completed' };

export type PlannerRunProgress = PlannerRunProgressPayload & {
  sequence: number;
  elapsedMs: number;
};

export type PlannerRunProgressObserver = (event: PlannerRunProgress) => void;

interface PlannerToolProgress {
  toolSequence: number;
  toolName: string;
  argumentFields: string[];
}
