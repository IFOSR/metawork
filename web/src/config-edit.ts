export const MODEL_CAPABILITIES = [
  'coding',
  'long-context',
  'planning',
  'structured-output',
  'tools',
  'vision',
] as const;

export type FixedModelPolicy = {
  mode: 'fixed';
  modelRef: string;
};

export type AutoModelPolicy = {
  mode: 'auto';
  allowedModelRefs: string[];
  defaultModelRef?: string;
  fallback?: {
    enabled: boolean;
    order: string[];
  };
};

export type EditableModelPolicy = FixedModelPolicy | AutoModelPolicy;

export function selectModelPolicy(
  selection: string,
  modelRefs: string[],
  current: EditableModelPolicy,
): EditableModelPolicy {
  if (selection !== 'auto') {
    return { mode: 'fixed', modelRef: selection };
  }
  if (current.mode === 'auto') return current;
  const defaultModelRef = modelRefs.includes(current.modelRef)
    ? current.modelRef
    : modelRefs[0];
  return {
    mode: 'auto',
    allowedModelRefs: defaultModelRef ? [defaultModelRef] : [],
    ...(defaultModelRef ? { defaultModelRef } : {}),
  };
}
