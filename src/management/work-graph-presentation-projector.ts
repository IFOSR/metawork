import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import {
  resolvePublicRoutingIdentity,
  type ConfigurationSnapshot,
  type RuntimeConfigurationView,
} from '../configuration/index.js';
import type { RoutingResolutionAudit } from '../routing/auto-model-resolver.js';
import { deriveRunnableFrontier } from '../work-graph/frontier.js';
import { buildCanonicalSubtaskIdentityMap } from '../work-graph/subtask-identity.js';
import type { WorkGraphProposal, WorkGraphSubtask } from '../work-graph/types.js';

export interface WorkGraphPresentationSubtaskFact {
  id: string;
  status: string;
  generationId: string;
  firstDispatchOrder: number | null;
  hasPendingOrActiveAttempt: boolean;
}

export interface WorkGraphPresentationDecisionFact {
  taskId: string;
  subtaskId: string | null;
  action: string;
  authorizedBindings: AuthorizedExecutorBinding[];
  routing?: RoutingResolutionAudit[];
}

export interface WorkGraphPresentationDispatchFact {
  subtaskId: string;
  status: string;
  authorizedBinding: AuthorizedExecutorBinding;
}

export interface WorkGraphPresentationReceiptFact {
  subtaskId: string;
  attemptId: string;
  terminalState: string;
  authorizedBinding: AuthorizedExecutorBinding;
}

export interface WorkGraphPresentationPublicationFact {
  subtaskId: string;
  status: string;
}

export interface WorkGraphPresentationInput {
  taskId: string;
  graphRevision: number;
  configuration: ConfigurationSnapshot | RuntimeConfigurationView;
  graph: WorkGraphProposal;
  subtasks: readonly WorkGraphPresentationSubtaskFact[];
  decisions: readonly WorkGraphPresentationDecisionFact[];
  dispatchItems: readonly WorkGraphPresentationDispatchFact[];
  receipts: readonly WorkGraphPresentationReceiptFact[];
  publications: readonly WorkGraphPresentationPublicationFact[];
}

export interface WorkGraphPresentationRouting {
  executorDisplayName: string;
  harnessDisplayName: string;
  policy: 'auto' | 'fixed';
  selected?: {
    providerDisplayName: string;
    modelDisplayName: string;
  };
  estimatedCost?: number;
  estimatedLatencyMs?: number;
  rejectedCandidates: Array<{
    providerDisplayName: string;
    modelDisplayName: string;
    reasonCode: string;
    reasonDetail?: string;
  }>;
}

export interface WorkGraphPresentationNode {
  id: string;
  title: string;
  goal: string;
  status: string;
  phase: number;
  runnable: boolean;
  dependencies: string[];
  requiredCapabilities: string[];
  acceptanceCriteria: string[];
  routing: WorkGraphPresentationRouting[];
}

export interface WorkGraphPresentationEdge {
  from: string;
  to: string;
  kind: 'dependency' | 'handoff' | 'artifact';
  label: string;
}

export interface WorkGraphPresentationProjection {
  generationId: string | null;
  nodes: WorkGraphPresentationNode[];
  edges: WorkGraphPresentationEdge[];
  parallelGroups: string[][];
  currentRunnableFrontier: string[];
}

export class WorkGraphPresentationProjector {
  project(input: WorkGraphPresentationInput): WorkGraphPresentationProjection {
    const aliases = buildCanonicalSubtaskIdentityMap(
      input.taskId,
      input.graphRevision,
      input.graph.subtasks,
    );
    const canonical = (subtaskId: string): string => aliases.get(subtaskId) ?? subtaskId;
    const graph = canonicalGraph(input.graph, canonical);
    const factsById = new Map(input.subtasks.map(fact => [canonical(fact.id), fact]));
    const decisionsBySubtask = new Map(
      input.decisions
        .filter(decision => decision.subtaskId)
        .map(decision => [canonical(decision.subtaskId!), decision]),
    );
    const dispatchBySubtask = new Map(
      input.dispatchItems.map(item => [canonical(item.subtaskId), item]),
    );
    const receiptBySubtask = new Map(
      input.receipts.map(item => [canonical(item.subtaskId), item]),
    );
    const publicationBySubtask = new Map(
      input.publications.map(item => [canonical(item.subtaskId), item]),
    );
    const layers = topologyLayers(graph.subtasks);
    const edges = graph.subtasks.flatMap(subtask => subtask.dependencies.flatMap(dependency => (
      dependency.requiredItems.map(item => ({
        from: dependency.fromSubtaskId,
        to: subtask.id,
        kind: item.type === 'artifact' ? 'artifact' as const : 'handoff' as const,
        label: item.description,
      }))
    )));
    const runnable = new Set(deriveRunnableFrontier(
      graph,
      input.subtasks.map(fact => ({
        subtaskId: canonical(fact.id),
        status: normalizeRuntimeStatus(fact.status),
        firstDispatchOrder: fact.firstDispatchOrder,
        hasPendingOrActiveAttempt: fact.hasPendingOrActiveAttempt,
      })),
    ));
    const nodes = graph.subtasks.map(subtask => {
      const fact = factsById.get(subtask.id);
      const decision = decisionsBySubtask.get(subtask.id);
      const dispatch = dispatchBySubtask.get(subtask.id);
      const receipt = receiptBySubtask.get(subtask.id);
      const publication = publicationBySubtask.get(subtask.id);
      return {
        id: subtask.id,
        title: bounded(subtask.title, 300),
        goal: bounded(subtask.goal, 1_000),
        status: publication?.status ?? receipt?.terminalState ?? dispatch?.status ?? fact?.status ?? 'unknown',
        phase: layers.get(subtask.id) ?? 0,
        runnable: runnable.has(subtask.id),
        dependencies: subtask.dependencies.map(dependency => dependency.fromSubtaskId),
        requiredCapabilities: [...subtask.requiredCapabilities].sort(),
        acceptanceCriteria: subtask.acceptance.map(item => bounded(item.description, 300)),
        routing: routingFor(
          subtask,
          decision,
          dispatch,
          receipt,
          input.configuration,
        ),
      } satisfies WorkGraphPresentationNode;
    });
    return {
      generationId: input.subtasks[0]?.generationId ?? null,
      nodes,
      edges,
      parallelGroups: [...layers.entries()]
        .sort((left, right) => left[1] - right[1])
        .reduce<string[][]>((groups, [id, layer]) => {
          (groups[layer] ??= []).push(id);
          return groups;
        }, []),
      currentRunnableFrontier: [...runnable],
    };
  }
}

function routingFor(
  subtask: WorkGraphSubtask,
  decision: WorkGraphPresentationDecisionFact | undefined,
  dispatch: WorkGraphPresentationDispatchFact | undefined,
  receipt: WorkGraphPresentationReceiptFact | undefined,
  configuration: ConfigurationSnapshot | RuntimeConfigurationView,
): WorkGraphPresentationRouting[] {
  const finalBindings = new Map<string, AuthorizedExecutorBinding>();
  for (const binding of decision?.authorizedBindings ?? []) finalBindings.set(binding.agentClassRef, binding);
  if (dispatch) finalBindings.set(dispatch.authorizedBinding.agentClassRef, dispatch.authorizedBinding);
  if (receipt) finalBindings.set(receipt.authorizedBinding.agentClassRef, receipt.authorizedBinding);
  return subtask.executorBindings.map(proposed => {
    const binding = finalBindings.get(proposed.agentClassRef);
    const audit = decision?.routing?.find(item => item.agentClassRef === proposed.agentClassRef);
    const policy = proposed.modelSelection.mode === 'fixed-by-agent-class' ? 'fixed' : 'auto';
    const rejectedCandidates = Array.isArray(audit?.rejectedCandidates)
      ? audit.rejectedCandidates.flatMap(candidate => (
        isRecord(candidate)
          && typeof candidate.providerRef === 'string'
          && typeof candidate.modelRef === 'string'
          && typeof candidate.reason === 'string'
          ? [publicRejectedCandidate(candidate, binding, proposed.agentClassRef, configuration)]
          : []
      ))
      : [];
    const score = isRecord(audit?.scoreBreakdown) ? audit.scoreBreakdown : undefined;
    const identityBinding = binding ?? audit?.binding;
    const identity = identityBinding
      ? resolvePublicRoutingIdentity(configuration, identityBinding)
      : null;
    return {
      executorDisplayName: identity?.executorDisplayName ?? proposed.agentClassRef,
      harnessDisplayName: identity?.harnessDisplayName ?? '',
      policy,
      ...(identity ? {
        selected: {
          providerDisplayName: identity.providerDisplayName,
          modelDisplayName: identity.modelDisplayName,
        },
      } : {}),
      ...(typeof score?.estimatedCost === 'number' ? { estimatedCost: score.estimatedCost } : {}),
      ...(typeof score?.estimatedLatencyMs === 'number' ? { estimatedLatencyMs: score.estimatedLatencyMs } : {}),
      rejectedCandidates,
    };
  });
}

function canonicalGraph(
  graph: WorkGraphProposal,
  canonical: (subtaskId: string) => string,
): WorkGraphProposal {
  return {
    ...graph,
    subtasks: graph.subtasks.map(subtask => ({
      ...subtask,
      id: canonical(subtask.id),
      dependencies: subtask.dependencies.map(dependency => ({
        ...dependency,
        fromSubtaskId: canonical(dependency.fromSubtaskId),
      })),
    })),
  };
}

function publicRejectedCandidate(
  candidate: { providerRef: string; modelRef: string; reason: string },
  selectedBinding: AuthorizedExecutorBinding | undefined,
  agentClassRef: string,
  configuration: ConfigurationSnapshot | RuntimeConfigurationView,
): WorkGraphPresentationRouting['rejectedCandidates'][number] {
  const identity = resolvePublicRoutingIdentity(configuration, {
    agentClassRef,
    harnessRef: selectedBinding?.harnessRef ?? agentClassRef,
    providerRef: candidate.providerRef,
    modelRef: candidate.modelRef,
    configurationRevision: selectedBinding?.configurationRevision ?? configuration.revisionId,
  });
  const [reasonCode, reasonDetail] = candidate.reason.split(':', 2);
  return {
    providerDisplayName: identity.providerDisplayName,
    modelDisplayName: identity.modelDisplayName,
    reasonCode: reasonCode || 'unknown',
    ...(reasonDetail ? { reasonDetail } : {}),
  };
}

function topologyLayers(subtasks: readonly WorkGraphSubtask[]): Map<string, number> {
  const byId = new Map(subtasks.map(subtask => [subtask.id, subtask]));
  const layers = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    if (layers.has(id)) return layers.get(id)!;
    if (visiting.has(id)) return Number.MAX_SAFE_INTEGER;
    const subtask = byId.get(id);
    if (!subtask) return Number.MAX_SAFE_INTEGER;
    visiting.add(id);
    const dependencies = subtask.dependencies.map(item => visit(item.fromSubtaskId));
    visiting.delete(id);
    const layer = dependencies.length === 0 ? 0 : Math.max(...dependencies) + 1;
    layers.set(id, layer);
    return layer;
  };
  for (const subtask of subtasks) visit(subtask.id);
  return layers;
}

function normalizeRuntimeStatus(status: string): 'ready' | 'running' | 'awaiting_integration' | 'awaiting_decision' | 'blocked' | 'done' | 'cancelled' {
  if (['ready', 'running', 'awaiting_integration', 'awaiting_decision', 'blocked', 'done', 'cancelled'].includes(status)) {
    return status as ReturnType<typeof normalizeRuntimeStatus>;
  }
  return 'blocked';
}

function bounded(value: string, limit: number): string {
  const normalized = value.trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
