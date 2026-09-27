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

/** Fixed Span advisor model; the UI never offers a model/provider picker. */
export const SPAN_ROUTING_MODEL = 'respan/span-01-lite';
export const SPAN_ROUTING_DEFAULT_TIMEOUT_MS = 3_000;
export const SPAN_ROUTING_MIN_TIMEOUT_MS = 500;
export const SPAN_ROUTING_MAX_TIMEOUT_MS = 10_000;

/** Editable Span state; `apiKey` is a transient input and is never persisted. */
export interface SpanRoutingDraft {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  apiKey: string;
}

export function loadSpanRoutingDraft(
  config: Record<string, unknown>,
): SpanRoutingDraft {
  const routing = asPlainRecord(config.routing);
  const span = asPlainRecord(routing?.span);
  const timeoutMs = typeof span?.timeoutMs === 'number' && Number.isFinite(span.timeoutMs)
    ? span.timeoutMs
    : SPAN_ROUTING_DEFAULT_TIMEOUT_MS;
  return {
    enabled: span?.enabled === true,
    model: SPAN_ROUTING_MODEL,
    timeoutMs,
    apiKey: '',
  };
}

/**
 * Materializes the `routing.span` section for an activation payload.
 *
 * Returns `undefined` when the user never touched Span and the revision did not
 * already carry the section, so an unrelated save never rewrites it. A blank
 * key keeps the existing `apiKeyRef` (the Server owns the stored credential).
 */
export function buildSpanRoutingSection(
  draft: SpanRoutingDraft,
  originalConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const originalRouting = asPlainRecord(originalConfig.routing);
  const originalSpan = asPlainRecord(originalRouting?.span);
  if (!draft.enabled && !originalSpan && draft.apiKey.trim().length === 0) {
    return undefined;
  }
  const apiKeyRef = typeof originalSpan?.apiKeyRef === 'string' && originalSpan.apiKeyRef
    ? originalSpan.apiKeyRef
    : undefined;
  return {
    ...originalRouting,
    span: {
      ...originalSpan,
      enabled: draft.enabled,
      model: SPAN_ROUTING_MODEL,
      timeoutMs: clampTimeout(draft.timeoutMs),
      ...(apiKeyRef ? { apiKeyRef } : {}),
    },
  };
}

export function clampTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return SPAN_ROUTING_DEFAULT_TIMEOUT_MS;
  return Math.min(
    SPAN_ROUTING_MAX_TIMEOUT_MS,
    Math.max(SPAN_ROUTING_MIN_TIMEOUT_MS, Math.floor(timeoutMs)),
  );
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

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
