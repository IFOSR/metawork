import { vi } from 'vitest';
import type {
  AttemptSandboxPort,
  AttemptSandboxRecord,
  CreateAttemptSandboxInput,
} from '../../src/execution/attempt-sandbox.js';
import { COMPLETION_MARKER_V2 } from '../../src/execution/completion-protocol.js';

interface AcceptanceCriterion {
  key: string;
}

interface HandoffRequirement {
  toSubtaskId: string;
  requiredItems: Array<{
    key: string;
    type: 'text' | 'artifact';
    description: string;
  }>;
}

export interface FakeAttemptSandboxResponse {
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

export type FakeAttemptSandboxResponder = (
  input: CreateAttemptSandboxInput,
  attemptIndex: number,
) => FakeAttemptSandboxResponse | Promise<FakeAttemptSandboxResponse>;

export class FakeAttemptSandbox implements AttemptSandboxPort {
  private readonly records = new Map<string, AttemptSandboxRecord>();
  private readonly inputs = new Map<string, CreateAttemptSandboxInput>();
  private readonly responses = new Map<string, FakeAttemptSandboxResponse>();
  private attemptIndex = 0;

  constructor(private readonly responder: FakeAttemptSandboxResponder = () => ({})) {}

  readonly resolveImage = vi.fn(async (_imageRef: string) => `sha256:${'a'.repeat(64)}`);

  readonly create = vi.fn(async (input: CreateAttemptSandboxInput) => {
    const containerId = `fake-sandbox-${input.attemptId}`;
    const record: AttemptSandboxRecord = {
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
    if ((response.exitCode ?? 0) !== 0) return response.body ?? 'fake sandbox failed';
    if (response.failure) {
      return `${response.body ?? response.failure.summary}\n\n${COMPLETION_MARKER_V2}\n${JSON.stringify({
        schemaVersion: 2,
        status: 'failed',
        subtaskId: input.subtaskId,
        failure: response.failure,
      })}`;
    }
    return completionResponseFromSandboxInput(input, response.body, response.artifacts);
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

  private requireInput(containerId: string): CreateAttemptSandboxInput {
    const input = this.inputs.get(containerId);
    if (!input) throw new Error(`unknown fake sandbox ${containerId}`);
    return input;
  }

  private requireResponse(containerId: string): FakeAttemptSandboxResponse {
    const response = this.responses.get(containerId);
    if (!response) throw new Error(`unknown fake sandbox ${containerId}`);
    return response;
  }

  private updateRecord(containerId: string, changes: Partial<AttemptSandboxRecord>): void {
    const current = this.records.get(containerId);
    if (!current) throw new Error(`unknown fake sandbox ${containerId}`);
    this.records.set(containerId, { ...current, ...changes });
  }
}

export function completionResponseFromSandboxInput(
  input: CreateAttemptSandboxInput,
  body = 'completed',
  artifacts: string[] = [],
): string {
  const prompt = input.args.at(-1) ?? '';
  const acceptance = parsePromptSection<AcceptanceCriterion[]>(
    prompt,
    'Acceptance contract:',
    'Incoming direct handoffs:',
  );
  const outgoingHandoffs = parsePromptSection<HandoffRequirement[]>(
    prompt,
    'Outgoing handoff requirements (do not infer downstream goals):',
    'Planner-selected evidence:',
  );
  return `${body}\n\n${COMPLETION_MARKER_V2}\n${JSON.stringify({
    schemaVersion: 2,
    status: 'completed',
    subtaskId: input.subtaskId,
    acceptanceEvidence: acceptance.map(criterion => ({
      key: criterion.key,
      evidence: ['tests were not run: deterministic fake sandbox'],
    })),
    artifacts,
    handoffs: outgoingHandoffs.map(contract => ({
      toSubtaskId: contract.toSubtaskId,
      items: contract.requiredItems.map(item => item.type === 'text'
        ? { key: item.key, type: 'text', value: `${body} (${item.description})` }
        : { key: item.key, type: 'artifact', paths: artifacts }),
    })),
  })}`;
}

function parsePromptSection<T>(prompt: string, startLabel: string, endLabel: string): T {
  const start = prompt.indexOf(`${startLabel}\n`);
  const end = prompt.indexOf(`\n\n${endLabel}`, start);
  if (start < 0 || end < 0) {
    throw new Error(`fake sandbox could not parse prompt section ${startLabel}`);
  }
  return JSON.parse(prompt.slice(start + startLabel.length + 1, end)) as T;
}
