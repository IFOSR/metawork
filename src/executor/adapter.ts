// Defines the shared executor adapter contract, inputs, and progress events.
// The contract is transport-neutral: it carries the full authorization identity a
// future remote (A2A) transport needs without selecting models, AgentClasses, retry,
// fallback, or scheduling. A2A delivery is deferred to its separate roadmap.
import type { ExecutorResult } from '../core/types.js';
import type { KernelFailure } from '../core/kernel-failure.js';
import type { SubtaskExecutionContext } from '../execution/subtask-execution-context.js';
import type { ParsedSkillUsageEvent } from './skill-usage-event-parser.js';

export interface ExecutorInput {
  context: SubtaskExecutionContext;
  onProgress?: (event: ExecutorProgressEvent) => void;
  recovery?: {
    mode: 'native_session' | 'recovery_packet' | 'fresh';
    continuationToken: string | null;
    onContinuationToken?(token: string): void;
  };
  executionBinding?: {
    attemptId: string;
    taskId: string;
    generationId: string;
    subtaskId: string;
    workUnitId: string;
    leaseToken: string;
    idempotencyKey: string;
    authorization?: {
      agentClassRef: string;
      harnessRef: string;
      providerRef: string;
      modelRef: string;
      permissionProfileRef: string | null;
      configurationRevision: string;
      bindingFingerprint: string;
    };
    workspacePath: string;
    workspaceId: string;
    sourcePath: string;
    inputsPath: string;
    handoffsPath: string;
    gitMetadataPath: string | null;
    controlNetwork: string;
    capabilityBinding: { mcpUrl: string; jsonUrl: string; useUrl: string; bearerToken: string } | null;
    onExecutionCreated?(executionId: string): void;
  };
}

export interface ExecutorProgressEvent {
  kind: 'status' | 'log' | 'skill';
  text: string;
  skillEvent?: ParsedSkillUsageEvent;
}

export interface ExecutorProbeResult {
  available: boolean;
  failure: KernelFailure | null;
}

export interface ExecutorAdapter {
  readonly name: string;
  readonly supportsContinuation?: boolean;
  execute(input: ExecutorInput): Promise<ExecutorResult>;
  executeResponseOnly?(input: { prompt: string; maxBytes: number }): Promise<ExecutorResult>;
  probe(previousFailure?: KernelFailure | null): Promise<ExecutorProbeResult>;
  abort(attemptId?: string): void;
}