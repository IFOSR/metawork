import { extractInlineResourceMatches, stripInlineResourceMatches } from './inline-resource-normalizer.js';

export interface InlineResourceNormalizationResult {
  normalizedGoal: string;
  resources: string[];
}

/**
 * Normalizes inline resources in a planning goal. This is intent parsing only;
 * it has no memory-engine dependency.
 */
export function normalizeInlineResources(input: string, resources: string[], stripResource: (text: string) => string): InlineResourceNormalizationResult {
  return {
    normalizedGoal: stripResource(input) || input,
    resources,
  };
}

export function normalizeInlineResourcesFromInput(input: string, cwd = process.cwd()): InlineResourceNormalizationResult {
  const matches = extractInlineResourceMatches(input, cwd);
  return {
    normalizedGoal: stripInlineResourceMatches(input, matches) || input,
    resources: matches.map(match => match.resolvedPath),
  };
}
