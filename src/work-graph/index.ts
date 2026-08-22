export type {
  ContextRef,
  ProposedExecutorBinding,
  ProposedModelSelection,
  WorkGraphAcceptanceCriterion,
  WorkGraphDependency,
  WorkGraphItemType,
  WorkGraphProposal,
  WorkGraphRequiredItem,
  WorkGraphSubtask,
} from './types.js';
export {
  deriveCancellationClosure,
  type CancellationGraph,
  type CancellationClosureResult,
  type WorkGraphCancellationFact,
  type WorkGraphCancellationStatus,
} from './cancellation.js';
export {
  deriveRunnableFrontier,
  type WorkGraphRuntimeFact,
  type WorkGraphRuntimeStatus,
} from './frontier.js';
export {
  contextRefKey,
  validateWorkGraph,
  WORK_GRAPH_KEY_PATTERN,
  type WorkGraphViolation,
  type WorkGraphViolationCode,
} from './validation.js';
export {
  buildEligibleContextRefKeys,
  isEligibleInteractionRef,
} from './context-ref-eligibility.js';
