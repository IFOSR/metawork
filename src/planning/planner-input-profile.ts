import type { ModelCapability } from '../configuration/types.js';
import type { PlanningContext } from './planning-types.js';

export interface PlannerInputProfile {
  textTokens: number;
  imageCount: number;
  imageMimes: string[];
  imageBytes: number;
  attachmentCount: number;
  continuation: boolean;
  requiredCapabilities: ModelCapability[];
  contextTokens: number;
  requiresStructuredOutput: true;
}

/** Builds routing facts from message shape only; it never interprets intent. */
export function buildPlannerInputProfile(context: Pick<PlanningContext, 'userInput' | 'images'> & {
  continuation?: boolean;
  attachmentCount?: number;
}): PlannerInputProfile {
  const textTokens = Math.max(1, Math.ceil(context.userInput.length / 4));
  const imageCount = context.images?.length ?? 0;
  const imageMimes = [...new Set((context.images ?? []).map(image => image.mimeType).sort())];
  const imageBytes = (context.images ?? []).reduce(
    (total, image) => total + Math.ceil((image.data.length * 3) / 4),
    0,
  );
  const attachmentCount = Math.max(context.attachmentCount ?? 0, imageCount);
  const requiredCapabilities: ModelCapability[] = ['planning', 'structured-output'];
  if (imageCount > 0) requiredCapabilities.push('vision');
  if (textTokens > 16_000) requiredCapabilities.push('long-context');
  return {
    textTokens,
    imageCount,
    imageMimes,
    imageBytes,
    attachmentCount,
    continuation: context.continuation === true,
    requiredCapabilities,
    contextTokens: Math.max(1_024, textTokens + imageCount * 2_048),
    requiresStructuredOutput: true,
  };
}
