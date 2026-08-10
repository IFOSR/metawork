import { vi } from 'vitest';
import type {
  AttemptExecutionBackend,
  AttemptExecutionRecord,
  CreateAttemptExecutionInput,
} from '../../src/execution/attempt-execution-backend.js';
import { COMPLETION_MARKER_V3 } from '../../src/execution/completion-protocol.js';

export interface FakeAttemptExecutionResponse {
  body?: string;
  artifacts?: string[];
  exitCode?: number;
  rawOutput?: string;
  wait?: Promise<number>;
  failure?: {
    kind: 'capability_mismatch' | 'task_failed' | 'quality_failed';
    code: string;
    summary: string;
  };
}

export type FakeAttemptExecutionResponder = (
  input: CreateAttemptExecutionInput,
  attemptIndex: number,
) => FakeAttemptExecutionResponse | Promise<FakeAttemptExecutionResponse>;

export class FakeAttemptExecutionBackend implements AttemptExecutionBackend {
  private readonly records = new Map<string, AttemptExecutionRecord>();
  private readonly inputs = new Map<string, CreateAttemptExecutionInput>();
  private readonly responses = new Map<string, FakeAttemptExecutionResponse>();
  private attemptIndex = 0;

  constructor(private readonly responder: FakeAttemptExecutionResponder = () => ({})) {}

  readonly resolveImage = vi.fn(async (_imageRef: string) => `sha256:${'a'.repeat(64)}`);

  readonly create = vi.fn(async (input: CreateAttemptExecutionInput) => {
    const containerId = `fake-execution-${input.attemptId}`;
    const record: AttemptExecutionRecord = {
      containerId,
      imageId: input.resolvedImageId,
      status: 'created',
      exitCode: null,
      labels: {
        'metaclaw.managed': 'true',
        'metaclaw.attempt-id': input.attemptId,
      },
    };
    this.records.set(containerId, record);
    this.inputs.set(containerId, input);
    this.responses.set(containerId, await this.responder(input, this.attemptIndex++));
    return record;
  });

  readonly start = vi.fn(async (containerId: string) => {
    this.updateRecord(containerId, { status: 'running' });
  });

  readonly wait = vi.fn(async (containerId: string) => {
    const response = this.requireResponse(containerId);
    const exitCode = response.wait ? await response.wait : (response.exitCode ?? 0);
    this.updateRecord(containerId, { status: 'exited', exitCode });
    return exitCode;
  });

  readonly logs = vi.fn(async (containerId: string) => {
    const input = this.requireInput(containerId);
    const response = this.requireResponse(containerId);
    if (response.rawOutput !== undefined) return response.rawOutput;
    if ((response.exitCode ?? 0) !== 0) return response.body ?? 'fake execution backend failed';
    if (response.failure) {
      return `${response.body ?? response.failure.summary}\n\n${COMPLETION_MARKER_V3}\n${JSON.stringify({
        failure: response.failure,
      })}`;
    }
    return completionResponseFromExecutionInput(input, response.body, response.artifacts);
  });

  readonly pause = vi.fn(async (containerId: string) => {
    this.updateRecord(containerId, { status: 'paused' });
  });

  readonly resume = vi.fn(async (containerId: string) => {
    this.updateRecord(containerId, { status: 'running' });
  });

  readonly inspect = vi.fn(async (containerId: string) => this.records.get(containerId) ?? null);

  readonly stop = vi.fn(async (containerId: string) => {
    this.updateRecord(containerId, { status: 'exited', exitCode: 137 });
  });

  readonly remove = vi.fn(async (containerId: string) => {
    this.records.delete(containerId);
  });

  readonly listManaged = vi.fn(async () => [...this.records.values()]);

  private requireInput(containerId: string): CreateAttemptExecutionInput {
    const input = this.inputs.get(containerId);
    if (!input) throw new Error(`unknown fake execution backend ${containerId}`);
    return input;
  }

  private requireResponse(containerId: string): FakeAttemptExecutionResponse {
    const response = this.responses.get(containerId);
    if (!response) throw new Error(`unknown fake execution backend ${containerId}`);
    return response;
  }

  private updateRecord(containerId: string, changes: Partial<AttemptExecutionRecord>): void {
    const current = this.records.get(containerId);
    if (!current) throw new Error(`unknown fake execution backend ${containerId}`);
    this.records.set(containerId, { ...current, ...changes });
  }
}

export function completionResponseFromExecutionInput(
  input: CreateAttemptExecutionInput,
  body = 'completed',
  artifacts: string[] = [],
): string {
  const isEdit = input.args.join('\n').includes('Delivery kind: edit');
  return `${body}\n\n${COMPLETION_MARKER_V3}\n${JSON.stringify({
    evidence: ['tests were not run: deterministic fake execution backend'],
    noChangeReason: isEdit && artifacts.length === 0
      ? 'The deterministic test executor made no workspace changes.'
      : null,
  })}`;
}
