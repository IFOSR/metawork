import type { Subtask, Task } from '../core/types.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import { resolvePublicRoutingIdentity } from '../configuration/public-routing-identity.js';
import type { GatewayTaskViewSnapshot } from './task-view.js';

type Configuration = Parameters<typeof resolvePublicRoutingIdentity>[0];

interface GatewayDispatchFact {
  readonly subtaskId: string;
  readonly createdAt: string;
  readonly authorizedBinding: AuthorizedExecutorBinding;
}

interface GatewayAttemptReceiptFact {
  readonly attemptId: string;
  readonly taskId: string;
  readonly subtaskId: string;
  readonly generationId: string;
  readonly completedAt: string;
  readonly terminalState: string;
  readonly failure: unknown;
  readonly authorizedBinding: AuthorizedExecutorBinding;
  readonly parsing: Record<string, unknown>;
}

interface GatewayResultObjectFact {
  readonly resultId: string;
  readonly accountId: string;
  readonly taskId: string;
  readonly generationId: string;
  readonly sourceSubtaskId: string;
  readonly attemptId: string;
  readonly kind: string;
  readonly byteLength: number;
  readonly completeness: 'complete' | 'partial' | 'incomplete';
}

/** Task facts come from attempts, never a command Turn's result stream. */
export async function projectTaskViewFacts(input: {
  task: Pick<Task, 'id' | 'accountId'>;
  subtasks: readonly Subtask[];
  dispatches: readonly GatewayDispatchFact[];
  receipts: readonly GatewayAttemptReceiptFact[];
  findObject(resultId: string): GatewayResultObjectFact | null;
  readConfiguration(revisionId: string): Promise<Configuration>;
}): Promise<Pick<GatewayTaskViewSnapshot, 'routing' | 'subtasks' | 'result'>> {
  const configurations = new Map<string, Promise<Configuration>>();
  const identity = async (binding: AuthorizedExecutorBinding | undefined) => {
    if (!binding) return null;
    let configuration = configurations.get(binding.configurationRevision);
    if (!configuration) {
      configuration = input.readConfiguration(binding.configurationRevision).catch(() => null);
      configurations.set(binding.configurationRevision, configuration);
    }
    const source = await configuration;
    if (!source || source.revisionId !== binding.configurationRevision) return null;
    return resolvePublicRoutingIdentity(source, binding);
  };
  const dispatches = [...input.dispatches].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const receipts = [...input.receipts].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const identities = await Promise.all(input.subtasks.map(subtask => identity(
    dispatches.find(item => item.subtaskId === subtask.id)?.authorizedBinding
      ?? receipts.find(item => item.subtaskId === subtask.id)?.authorizedBinding
      ?? subtask.executorBindings[0],
  )));
  const publicIdentity = identities.find(item => item !== null);
  let result: GatewayTaskViewSnapshot['result'] = null;
  for (const receipt of receipts) {
    if (receipt.taskId !== input.task.id) continue;
    const refs = receipt.parsing.resultObjects as { safeProjectionId?: unknown } | undefined;
    if (typeof refs?.safeProjectionId !== 'string') continue;
    const object = input.findObject(refs.safeProjectionId);
    if (!object || object.kind !== 'safe_projection' || object.byteLength === 0
      || object.accountId !== input.task.accountId || object.taskId !== input.task.id
      || object.attemptId !== receipt.attemptId || object.sourceSubtaskId !== receipt.subtaskId
      || object.generationId !== receipt.generationId) continue;
    result = {
      resultId: object.resultId,
      completeness: object.completeness,
      certification: receipt.terminalState === 'completed' && receipt.failure === null
        ? 'certified' : 'uncertified',
    };
    break;
  }
  return {
    routing: publicIdentity ? {
      executor: publicIdentity.executorDisplayName, provider: publicIdentity.providerDisplayName,
      model: publicIdentity.modelDisplayName, harness: publicIdentity.harnessDisplayName,
    } : null,
    subtasks: input.subtasks.map((subtask, index) => ({
      id: subtask.id, title: subtask.title, status: subtask.status,
      executor: identities[index]?.executorDisplayName ?? null,
    })),
    result,
  };
}
