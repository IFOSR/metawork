import { createHash } from 'node:crypto';
import type {
  KernelConfigurationView,
  ModelCapability,
} from '../configuration/types.js';
import type {
  ProposedModelSelection,
  WorkGraphProposal,
  WorkGraphSubtask,
} from '../work-graph/types.js';
import {
  filterEligibleModelCandidates,
  type AutoModelCandidate,
  type AutoModelRequirements,
  type RejectedModelCandidate,
} from './auto-model-resolver.js';
import { projectConfigurationCandidates } from './configuration-candidate-projection.js';
import { requiredModelCapabilitiesForRoutingCapabilities } from './types.js';

/**
 * Pure, shared plan-routing candidate resolution.
 *
 * Both the Server-side Span advisor and `ControlKernel` use this one module so
 * a candidate can never be scored under a looser rule than the one that
 * authorizes it. It returns candidate facts only; it never authorizes work,
 * creates a binding decision, or performs I/O.
 */

export interface PlanSubtaskCandidateGroup {
  agentClassRef: string;
  /** Planner proposal order, used as the deterministic tie-break. */
  bindingIndex: number;
  harnessRef: string;
  permissionProfileRef: string;
  preferredModelRef?: string;
  eligible: readonly AutoModelCandidate[];
  rejected: readonly RejectedModelCandidate[];
  /** Present when the AgentClass itself is not a valid executor binding. */
  error?: string;
}

export interface PlanSubtaskCandidateResolution {
  subtaskId: string;
  groups: PlanSubtaskCandidateGroup[];
}

export interface PlanRoutingCandidateIdentity {
  agentClassRef: string;
  providerRef: string;
  modelRef: string;
}

/** Resolves the Planner's model selection against the AgentClass policy. */
export function resolvePreferredModelRef(
  modelSelection: ProposedModelSelection,
  policy: KernelConfigurationView['agentClasses'][string]['modelPolicy'],
): string | undefined {
  if (modelSelection.mode === 'proposed') return modelSelection.modelRef;
  if (modelSelection.mode === 'agent-class-default' && policy.mode === 'auto') {
    return policy.defaultModelRef;
  }
  return undefined;
}

/**
 * Computes the hard-eligible candidate groups for one Subtask.
 *
 * `unavailableAgentClasses` mirrors the Kernel availability rule so Span is
 * never asked about an Executor the Kernel would reject. Kernel keeps using the
 * unfiltered groups for its existing deferred-availability handling and passes
 * the same set when it re-derives the candidate fingerprint.
 */
export function planSubtaskCandidateGroups(input: {
  configuration: KernelConfigurationView;
  subtask: WorkGraphSubtask;
  unavailableAgentClasses?: ReadonlySet<string>;
}): PlanSubtaskCandidateGroup[] {
  const { configuration, subtask } = input;
  const unavailable = input.unavailableAgentClasses ?? new Set<string>();
  const requirements: AutoModelRequirements = {
    requiredCapabilities: requiredModelCapabilitiesForRoutingCapabilities(
      subtask.requiredCapabilities,
    ) as ModelCapability[],
    preferredCapabilities: [],
    contextTokens: 1_024,
  };
  const groups: PlanSubtaskCandidateGroup[] = [];
  subtask.executorBindings.forEach((proposed, bindingIndex) => {
    const agentClass = configuration.agentClasses[proposed.agentClassRef];
    if (!agentClass || !agentClass.enabled || agentClass.kind !== 'executor') {
      groups.push({
        agentClassRef: proposed.agentClassRef,
        bindingIndex,
        harnessRef: '',
        permissionProfileRef: '',
        eligible: [],
        rejected: [],
        error: 'agent_class_unavailable',
      });
      return;
    }
    const permissionProfileRef = agentClass.permissionProfileRef ?? '';
    if (!permissionProfileRef || !configuration.permissionProfiles[permissionProfileRef]) {
      groups.push({
        agentClassRef: proposed.agentClassRef,
        bindingIndex,
        harnessRef: agentClass.harnessRef,
        permissionProfileRef,
        eligible: [],
        rejected: [],
        error: 'permission_profile_unavailable',
      });
      return;
    }
    if (unavailable.has(proposed.agentClassRef)) {
      groups.push({
        agentClassRef: proposed.agentClassRef,
        bindingIndex,
        harnessRef: agentClass.harnessRef,
        permissionProfileRef,
        eligible: [],
        rejected: [],
        error: 'agent_class_unavailable',
      });
      return;
    }
    const candidates = projectConfigurationCandidates(
      configuration,
      proposed.agentClassRef,
      { mode: agentClass.modelPolicy.mode },
    );
    const { eligible, rejected } = filterEligibleModelCandidates({
      policy: agentClass.modelPolicy,
      candidates,
      requirements,
    });
    groups.push({
      agentClassRef: proposed.agentClassRef,
      bindingIndex,
      harnessRef: agentClass.harnessRef,
      permissionProfileRef,
      ...(resolvePreferredModelRef(proposed.modelSelection, agentClass.modelPolicy)
        ? { preferredModelRef: resolvePreferredModelRef(proposed.modelSelection, agentClass.modelPolicy)! }
        : {}),
      eligible,
      rejected,
    });
  });
  return groups;
}

/** Stable identity string for one eligible AgentClass + Provider + Model. */
export function planRoutingCandidateId(identity: PlanRoutingCandidateIdentity): string {
  return `${identity.agentClassRef}\u0000${identity.providerRef}\u0000${identity.modelRef}`;
}

/**
 * Canonical fingerprint of the eligible candidate identity set. Span embeds it
 * in the observation; Kernel recomputes it and falls back on any mismatch so a
 * stale or partial score can never be reused.
 */
export function planRoutingCandidateSetFingerprint(
  identities: readonly PlanRoutingCandidateIdentity[],
): string {
  const canonical = identities
    .map(planRoutingCandidateId)
    .sort((left, right) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Fingerprint of the Planner proposal the observation was produced against. */
export function planProposalFingerprint(proposal: {
  task: unknown;
  workGraph: WorkGraphProposal | null;
}): string {
  return createHash('sha256')
    .update(stableJsonStringify({ task: proposal.task, workGraph: proposal.workGraph }))
    .digest('hex');
}

function stableJsonStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJsonStringify(nested)}`)
    .join(',')}}`;
}
