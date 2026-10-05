import type { ModelCapability } from '../configuration/types.js';

/** Broad performance labels are not executable requirements or quality scores. */
export function isModelExecutionConstraint(capability: ModelCapability): boolean {
  return capability !== 'coding'
    && capability !== 'planning'
    && capability !== 'long-context';
}
