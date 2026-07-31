export const ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION = 1 as const;
export const ANYFUSION_PLANNER_HOST_MAX_LINE_BYTES = 1_048_576;

export type PlannerHostMode = 'interactive' | 'rpc';

export type PlannerHostRequest =
  | { protocolVersion: 1; type: 'hello'; requestId: string; runtimeVersion: string; sessionId: string; mode: PlannerHostMode }
  | { protocolVersion: 1; type: 'ping'; requestId: string }
  | { protocolVersion: 1; type: 'snapshot_get'; requestId: string }
  | { protocolVersion: 1; type: 'snapshot_subscribe'; requestId: string }
  | {
      protocolVersion: 1;
      type: 'proposal_submit';
      requestId: string;
      turnId: string;
      sessionId: string;
      userInput: string;
      plan: unknown;
    }
  | { protocolVersion: 1; type: 'shutdown'; requestId: string };

export type PlannerHostMessage<TSnapshot = unknown> =
  | {
      protocolVersion: 1;
      type: 'hello';
      requestId: string;
      accepted: true;
      capabilities: string[];
    }
  | { protocolVersion: 1; type: 'pong'; requestId: string }
  | { protocolVersion: 1; type: 'snapshot'; requestId: string | null; snapshot: TSnapshot }
  | { protocolVersion: 1; type: 'subscribed'; requestId: string }
  | {
      protocolVersion: 1;
      type: 'proposal_result';
      requestId: string;
      turnId: string;
      accepted: true;
      planId: string | null;
    }
  | {
      protocolVersion: 1;
      type: 'proposal_result';
      requestId: string;
      turnId: string;
      accepted: false;
      error: { code: string; message: string; details?: string[] };
    }
  | { protocolVersion: 1; type: 'shutdown'; requestId: string; accepted: true }
  | {
      protocolVersion: 1;
      type: 'error';
      requestId: string | null;
      error: { code: string; message: string; details?: string[] };
    };

export function isPlannerHostRequest(value: unknown): value is PlannerHostRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { protocolVersion?: unknown; type?: unknown; requestId?: unknown };
  if (candidate.protocolVersion !== ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION) return false;
  if (typeof candidate.requestId !== 'string' || candidate.requestId.length === 0) return false;
  return candidate.type === 'hello'
    || candidate.type === 'ping'
    || candidate.type === 'snapshot_get'
    || candidate.type === 'snapshot_subscribe'
    || candidate.type === 'proposal_submit'
    || candidate.type === 'shutdown';
}
