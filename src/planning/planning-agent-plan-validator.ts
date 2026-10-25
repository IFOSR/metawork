import type { PlannerConfigurationView } from '../configuration/index.js';
import {
  requiredModelCapabilitiesForRoutingCapabilities,
  type ConfigurationCatalogAgentClass,
} from '../routing/types.js';
import { PlanningAgentPlanSchema } from './planning-agent-plan-schema.js';
import type { PlanningAgentPlan, PlanningContext, SubtaskProposal } from './planning-types.js';
import { validateWorkGraph } from '../work-graph/index.js';

export interface PlanningAgentPlanValidationResult {
  valid: boolean;
  errors: string[];
}

const TASK_PRIORITIES = new Set(['normal', 'high', 'urgent']);

export function validatePlanningAgentPlan(
  value: unknown,
  configuration: PlannerConfigurationView,
  pendingAuthorizationRequest: { requestId: string; taskId: string } | null = null,
  replan?: PlanningContext['replan'],
): PlanningAgentPlanValidationResult {
  const parsed = PlanningAgentPlanSchema.safeParse(value);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues
        .map(issue => `${issue.path.join('.') || 'plan'}: ${issue.message}`)
        .sort(),
    };
  }

  const plan = parsed.data as PlanningAgentPlan;
  const errors: string[] = [];
  if (replan) {
    if (plan.action !== 'plan_work_graph' || plan.task.binding !== 'reference'
      || plan.task.taskId !== replan.taskId) {
      errors.push(`Replan must describe remaining work for existing Task ${replan.taskId}`);
    }
    const available = new Set(replan.taskEvidenceIds);
    for (const subtask of plan.workGraph?.subtasks ?? []) {
      for (const ref of subtask.contextRefs) {
        if (ref.kind === 'task_evidence' && !available.has(ref.evidenceId)) {
          errors.push(`Unavailable task_evidence ID: ${ref.evidenceId}. Copy an exact evidenceId from Completed evidence; do not shorten or reconstruct it.`);
        }
      }
    }
  }
  validateActionSemantics(plan, errors);
  validateTaskControlScope(plan, errors);
  validateTaskPriority(plan, errors);
  validateAuthorizationResolution(plan, pendingAuthorizationRequest, errors);
  validateWorkspaceIntent(plan, errors);

  if (plan.workGraph) {
    errors.push(...validateWorkGraph(plan.workGraph).map(
      violation => `${violation.code}: ${violation.path}: ${violation.message}`,
    ));
    validateConfigurationRevision(plan.workGraph.configurationRevision, configuration, errors);
    validateRouting(plan.workGraph.subtasks, configuration, errors);
  }

  return { valid: errors.length === 0, errors: errors.sort() };
}

/** Non-authoritative Planner feedback used to improve decomposition quality. */
export function collectWorkGraphQualityWarnings(plan: PlanningAgentPlan): string[] {
  if (plan.action !== 'plan_work_graph' || !plan.workGraph) return [];
  const subtasks = plan.workGraph.subtasks;
  const text = `${plan.reason} ${plan.task.title ?? ''} ${plan.task.goal ?? ''}`.toLowerCase();
  const complexitySignal = /(?:研究|分析|实现|开发|验证|测试|报告|并行|分工|拆解|多个|两项|多个交付物|research|implement|analy[sz]|verify|test|parallel|decompose)/u.test(text);
  const warnings: string[] = [];
  if (subtasks.length === 1 && complexitySignal) {
    warnings.push('work_graph_quality: complexity signals are present but the proposal contains one subtask; consider separate research, implementation, or verification handoffs');
  }
  if (subtasks.length > 8) {
    warnings.push('work_graph_quality: proposal contains more than 8 subtasks; keep the graph observable and bounded');
  }
  if (subtasks.length >= 3) {
    const roots = subtasks.filter(subtask => subtask.dependencies.length === 0);
    const hasParallelRoots = roots.length > 1;
    const allSingleChain = roots.length === 1
      && subtasks.every(subtask => subtask === roots[0] || subtask.dependencies.length === 1);
    if (allSingleChain && !text.includes('依赖') && !text.includes('depend')) {
      warnings.push('work_graph_quality: all subtasks form a single chain without an explicit dependency rationale');
    }
    if (hasParallelRoots && subtasks.some(subtask => subtask.dependencies.length > 0
      && subtask.contextRefs.length === 0)) {
      warnings.push('work_graph_quality: dependent subtasks should reference the predecessor handoff in contextRefs');
    }
  }
  return warnings;
}

function validateConfigurationRevision(
  graphRevision: string,
  configuration: PlannerConfigurationView,
  errors: string[],
): void {
  if (configuration.routingCatalog.configurationRevision !== configuration.revisionId) {
    errors.push(
      `Planner configuration view revision ${configuration.revisionId} does not match routing catalog revision ${configuration.routingCatalog.configurationRevision}`,
    );
  }
  if (graphRevision !== configuration.revisionId) {
    errors.push(
      `work graph configurationRevision ${graphRevision} does not match Planner configuration revision ${configuration.revisionId}`,
    );
  }
}

function validateAuthorizationResolution(
  plan: PlanningAgentPlan,
  pending: { requestId: string; taskId: string } | null,
  errors: string[],
): void {
  if (plan.action !== 'authorization_resolution') return;
  if (!pending) {
    errors.push('authorization_resolution requires a pending authorization request');
    return;
  }
  if (plan.authorizationResolution?.requestId !== pending.requestId) {
    errors.push('authorization_resolution requestId must exactly match the pending request');
  }
  if (plan.task.binding !== 'reference' || plan.task.taskId !== pending.taskId) {
    errors.push('authorization_resolution must reference the pending request Task');
  }
}

function validateActionSemantics(plan: PlanningAgentPlan, errors: string[]): void {
  if (plan.action === 'clarification' && !plan.clarificationQuestion?.trim()) {
    errors.push('clarification requires clarificationQuestion');
  }
  if (plan.action === 'direct_reply' && !plan.response.directReply?.trim()) {
    errors.push('direct_reply requires a non-empty response.directReply');
  }
  if (plan.action === 'task_control' && plan.task.control === 'none') {
    errors.push('task_control requires a control kind');
  }
}

/**
 * Planner owns the Workspace semantics; this only rejects a proposal that
 * cannot be authorized mechanically. Ownership, containment and lease checks
 * stay in Kernel admission.
 */
function validateWorkspaceIntent(plan: PlanningAgentPlan, errors: string[]): void {
  const intent = plan.workspaceIntent ?? null;
  // Legacy schema 8 plans carry no intent; Kernel keeps the isolated safe
  // default for them instead of rejecting historical events on replay.
  if (plan.schemaVersion === 8) return;
  if (plan.action === 'plan_work_graph') {
    if (!intent) {
      errors.push('plan_work_graph requires workspaceIntent in PlanningAgentPlan schema 9');
      return;
    }
    if (intent.operation === 'ambiguous') {
      errors.push('an ambiguous Workspace intent cannot authorize plan_work_graph');
    }
    if (intent.operation === 'read_only') {
      const writes = plan.workGraph?.subtasks.some(
        subtask => subtask.deliveryKind !== 'report' || (subtask.fileOutputs?.length ?? 0) > 0,
      ) ?? false;
      if (writes) {
        errors.push('a read-only Workspace intent cannot authorize a write Work Graph');
      }
    }
    if (intent.operation !== 'read_only' && intent.targetPaths.length === 0) {
      errors.push('a writing Workspace intent must declare at least one target path');
    }
    if (intent.proposedMode === 'worktree' && !hasIsolationRationale(intent)) {
      errors.push(
        'proposedMode worktree requires an isolation, risk, candidate or acceptance rationale',
      );
    }
    if (intent.isolationPolicy === 'required' && intent.proposedMode === 'in_place') {
      errors.push('proposedMode in_place contradicts isolationPolicy required');
    }
    for (const path of intent.targetPaths) {
      if (path.startsWith('/') || path.includes('\\')
        || path.split('/').some(part => !part || part === '.' || part === '..')) {
        errors.push(`workspaceIntent.targetPaths must stay Workspace-relative: ${path}`);
      }
    }
    const targetPaths = intent.targetPaths;
    for (const output of plan.workGraph?.subtasks.flatMap(subtask => subtask.fileOutputs ?? []) ?? []) {
      if (output.startsWith('/') || output.includes('\\')
        || output.split('/').some(part => !part || part === '.' || part === '..')) {
        errors.push(`subtask.fileOutputs must stay Workspace-relative: ${output}`);
        continue;
      }
      if (!targetPaths.some(target => output === target || output.startsWith(`${target}/`))) {
        errors.push(`subtask.fileOutputs must be covered by workspaceIntent.targetPaths: ${output}`);
      }
    }
    if (intent.targetWorkspaceId !== null && !/^workspace_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(intent.targetWorkspaceId)) {
      errors.push('workspaceIntent.targetWorkspaceId must be a supplied Workspace identity');
    }
  }
  if (!intent) return;
  if (intent.operation === 'ambiguous' && plan.action !== 'clarification') {
    errors.push('an ambiguous Workspace intent requires action clarification');
  }
}

function hasIsolationRationale(intent: NonNullable<PlanningAgentPlan['workspaceIntent']>): boolean {
  return intent.isolationPolicy === 'requested'
    || intent.isolationPolicy === 'required'
    || intent.operation === 'isolated_experiment'
    || intent.operation === 'high_risk_change'
    || intent.originalFilePolicy === 'must_preserve'
    || /(候选|接受|审核|隔离|保留原文件)/u.test(intent.reason);
}

function validateTaskControlScope(plan: PlanningAgentPlan, errors: string[]): void {
  if (plan.task.publicProjectDirectory && (plan.task.binding !== 'new' || plan.task.publicProjectDirectory.startsWith('/')
    || plan.task.publicProjectDirectory.includes('\\') || plan.task.publicProjectDirectory.split('/').some(part => !part || part === '.' || part === '..'))) {
    errors.push('publicProjectDirectory requires an explicitly selected Workspace-relative project on a new Task');
  }
  if (plan.task.startServiceAfterPublish && (plan.action !== 'plan_work_graph' || plan.task.binding !== 'new')) errors.push('startServiceAfterPublish requires a new implementation Task');
  if (plan.action !== 'task_control') return;
  if (plan.task.control.startsWith('service_')) {
    if (plan.task.binding !== 'reference' || !plan.task.taskId) errors.push('service control requires an exact reference Task');
    if (plan.task.control === 'service_start' ? plan.task.scope !== null : !/^[a-zA-Z0-9_-]{1,100}$/u.test(plan.task.scope ?? '')) errors.push('service_start requires null scope; stop/restart require the exact serviceId');
  }
  if (plan.task.control === 'status_query' && !['dashboard', 'blocked', 'running'].includes(plan.task.scope ?? '')) {
    errors.push('status_query requires scope dashboard, blocked, or running');
  }
  if (plan.task.control === 'clear_tasks' && !['all', 'parked', 'blocked'].includes(plan.task.scope ?? '')) {
    errors.push('clear_tasks requires scope all, parked, or blocked');
  }
  if (
    (plan.task.control === 'resume_task'
      || plan.task.control === 'recover_blocked'
      || plan.task.control === 'abandon_task')
    && plan.task.scope !== null
  ) {
    errors.push(`${plan.task.control} requires scope null`);
  }
  if (plan.task.control === 'abandon_task' && plan.task.taskId === null) {
    errors.push('abandon_task requires the exact old Task id (taskId)');
  }
}

function validateTaskPriority(plan: PlanningAgentPlan, errors: string[]): void {
  const schedulable = plan.action === 'plan_work_graph'
    || (plan.action === 'task_control'
      && (plan.task.control === 'resume_task' || plan.task.control === 'recover_blocked'));
  const priority = plan.task.priority;
  if (!schedulable) {
    if (priority !== null) errors.push('task.priority must be null for non-schedulable actions');
    return;
  }
  if (!priority || !TASK_PRIORITIES.has(priority.level) || !priority.reason.trim()) {
    errors.push('schedulable actions require task.priority with valid level and non-empty reason');
  }
}

function validateRouting(
  subtasks: SubtaskProposal[],
  configuration: PlannerConfigurationView,
  errors: string[],
): void {
  const catalog = configuration.routingCatalog;
  const capabilityIds = new Set(catalog.capabilities.map(capability => capability.id));
  const agentClassesByRef = new Map(catalog.agentClasses.map(agentClass => [agentClass.id, agentClass]));
  const modelRefs = new Set(configuration.models.map(model => model.id));

  for (const subtask of subtasks) {
    collectDuplicateErrors(
      subtask.id,
      'Routing Capability',
      subtask.requiredCapabilities,
      errors,
    );
    collectDuplicateErrors(
      subtask.id,
      'executor binding',
      subtask.executorBindings.map(executorBindingKey),
      errors,
    );

    if (subtask.requiredCapabilities.length === 0) {
      errors.push(`subtask ${subtask.id} requires at least one Routing Capability`);
    }
    const unknownCapabilities = subtask.requiredCapabilities.filter(capability => !capabilityIds.has(capability));
    for (const capability of unknownCapabilities) {
      errors.push(`subtask ${subtask.id} references unknown Routing Capability: ${capability}`);
    }

    const required = new Set(subtask.requiredCapabilities);
    const eligible = catalog.agentClasses.filter(
      agentClass => [...required].every(capability =>
        agentClass.routingCapabilities.includes(capability)),
    );

    if (required.size > 0 && unknownCapabilities.length === 0 && eligible.length === 0) {
      errors.push(`no_capable_agent_class: subtask ${subtask.id} must be split at a Routing Capability handoff`);
    }

    for (const binding of subtask.executorBindings) {
      const agentClass = agentClassesByRef.get(binding.agentClassRef);
      if (!agentClass) {
        errors.push(
          `subtask ${subtask.id} references unavailable AgentClass in revision ${configuration.revisionId}: ${binding.agentClassRef}`,
        );
        continue;
      }
      const uncovered = [...required]
        .filter(capability => !agentClass.routingCapabilities.includes(capability))
        .sort();
      if (uncovered.length > 0) {
        errors.push(
          `subtask ${subtask.id} AgentClass ${binding.agentClassRef} does not cover required capabilities: ${uncovered.join(', ')}`,
        );
      }
      validateModelSelection(
        subtask.id,
        binding,
        agentClass,
        modelRefs,
        subtask.requiredCapabilities,
        configuration,
        errors,
      );
    }
  }
}

function validateModelSelection(
  subtaskId: string,
  binding: SubtaskProposal['executorBindings'][number],
  agentClass: ConfigurationCatalogAgentClass,
  modelRefs: ReadonlySet<string>,
  requiredRoutingCapabilities: SubtaskProposal['requiredCapabilities'],
  configuration: PlannerConfigurationView,
  errors: string[],
): void {
  const selection = binding.modelSelection;
  const policy = agentClass.modelPolicy;
  let selectedModelRef: string | null = null;

  if (policy.mode === 'fixed') {
    if (selection.mode !== 'fixed-by-agent-class') {
      errors.push(
        `subtask ${subtaskId} AgentClass ${binding.agentClassRef} uses fixed ModelPolicy and requires fixed-by-agent-class selection`,
      );
    } else {
      validateModelAvailability(
        subtaskId,
        policy.modelRef,
        modelRefs,
        configuration.revisionId,
        errors,
      );
      selectedModelRef = policy.modelRef;
    }
  } else if (selection.mode === 'fixed-by-agent-class') {
    errors.push(
      `subtask ${subtaskId} AgentClass ${binding.agentClassRef} uses auto ModelPolicy and cannot use fixed-by-agent-class selection`,
    );
  } else if (selection.mode === 'proposed') {
    validateModelAvailability(
      subtaskId,
      selection.modelRef,
      modelRefs,
      configuration.revisionId,
      errors,
    );
    if (!policy.allowedModelRefs.includes(selection.modelRef)) {
      errors.push(
        `subtask ${subtaskId} Model ${selection.modelRef} is not allowed by AgentClass ${binding.agentClassRef}`,
      );
    } else {
      selectedModelRef = selection.modelRef;
    }
  } else if (!policy.defaultModelRef) {
    errors.push(
      `subtask ${subtaskId} AgentClass ${binding.agentClassRef} has no default Model`,
    );
  } else {
    validateModelAvailability(
      subtaskId,
      policy.defaultModelRef,
      modelRefs,
      configuration.revisionId,
      errors,
    );
    // The Auto default is a resolver preference, not the final binding. Kernel
    // may select another allowed model to satisfy mandatory capabilities.
  }

  if (!selectedModelRef) return;
  const selectedModel = configuration.models.find(model => model.id === selectedModelRef);
  if (!selectedModel) return;
  const effectiveCapabilities = agentClass.modelCapabilities?.[selectedModelRef]
    ?? selectedModel.capabilities;
  const requiredModelCapabilities = requiredModelCapabilitiesForRoutingCapabilities(
    requiredRoutingCapabilities,
  );
  const unsupported = requiredModelCapabilities
    .filter(capability => !effectiveCapabilities.includes(capability as never));
  if (unsupported.length > 0) {
    errors.push(
      `subtask ${subtaskId} Model ${selectedModelRef} does not support required Routing Capabilities: `
      + requiredRoutingCapabilities.filter(capability => (
        requiredModelCapabilitiesForRoutingCapabilities([capability])
          .some(required => unsupported.includes(required))
      )).join(', '),
    );
  }
}

function validateModelAvailability(
  subtaskId: string,
  modelRef: string,
  modelRefs: ReadonlySet<string>,
  configurationRevision: string,
  errors: string[],
): void {
  if (!modelRefs.has(modelRef)) {
    errors.push(
      `subtask ${subtaskId} references unavailable Model in revision ${configurationRevision}: ${modelRef}`,
    );
  }
}

function executorBindingKey(
  binding: SubtaskProposal['executorBindings'][number],
): string {
  if (binding.modelSelection.mode === 'proposed') {
    return `${binding.agentClassRef}:${binding.modelSelection.mode}:${binding.modelSelection.modelRef}`;
  }
  return `${binding.agentClassRef}:${binding.modelSelection.mode}`;
}

function collectDuplicateErrors(
  subtaskId: string,
  label: string,
  values: readonly string[],
  errors: string[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) errors.push(`subtask ${subtaskId} contains duplicate ${label}: ${value}`);
    seen.add(value);
  }
}
