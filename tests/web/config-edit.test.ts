import { describe, expect, it } from 'vitest';
import {
  MODEL_CAPABILITIES,
  buildMemorySection,
  buildSpanRoutingSection,
  clampTimeout,
  loadMemoryDraft,
  loadSpanRoutingDraft,
  selectModelPolicy,
} from '../../web/src/config-edit.js';

describe('Web configuration editing', () => {
  it('offers exactly the model capabilities accepted by schema v2', () => {
    expect(MODEL_CAPABILITIES).toEqual([
      'coding',
      'long-context',
      'planning',
      'structured-output',
      'tools',
      'vision',
    ]);
  });

  it('converts a fixed policy to a complete automatic policy', () => {
    expect(selectModelPolicy(
      'auto',
      ['model-a', 'model-b'],
      { mode: 'fixed', modelRef: 'model-b' },
    )).toEqual({
      mode: 'auto',
      allowedModelRefs: ['model-b'],
      defaultModelRef: 'model-b',
    });
  });

  it('converts an automatic policy to a strict fixed policy', () => {
    expect(selectModelPolicy(
      'model-b',
      ['model-a', 'model-b'],
      {
        mode: 'auto',
        allowedModelRefs: ['model-a', 'model-b'],
        defaultModelRef: 'model-a',
        fallback: { enabled: true, order: ['model-b'] },
      },
    )).toEqual({
      mode: 'fixed',
      modelRef: 'model-b',
    });
  });

  it('preserves an existing automatic policy when auto remains selected', () => {
    const current = {
      mode: 'auto' as const,
      allowedModelRefs: ['model-a'],
      defaultModelRef: 'model-a',
      fallback: { enabled: false, order: [] },
    };

    expect(selectModelPolicy('auto', ['model-a', 'model-b'], current)).toBe(current);
  });
});

describe('Span routing advanced settings draft', () => {
  it('defaults to disabled with the fixed model when the revision predates Span', () => {
    expect(loadSpanRoutingDraft({})).toEqual({
      enabled: false,
      model: 'inception/mercury-decide:free',
      providerRef: '',
      modelRef: '',
      fallbackModelRefs: [],
      timeoutMs: 8_000,
      apiKey: '',
    });
  });

  it('loads an existing Span section without exposing any stored key', () => {
    const draft = loadSpanRoutingDraft({
      routing: { span: { enabled: true, model: 'inception/mercury-decide:free', apiKeyRef: 'file-secret:anyfusion/internal/routing-span', timeoutMs: 4_000 } },
    });
    expect(draft).toEqual({
      enabled: true,
      model: 'inception/mercury-decide:free',
      providerRef: '',
      modelRef: '',
      fallbackModelRefs: [],
      timeoutMs: 4_000,
      apiKey: '',
    });
  });

  it('writes nothing when Span was never touched and did not exist', () => {
    const draft = loadSpanRoutingDraft({});
    expect(buildSpanRoutingSection(draft, {})).toBeUndefined();
  });

  it('materializes the fixed model, timeout and the existing credential reference', () => {
    const section = buildSpanRoutingSection(
      { enabled: true, model: 'inception/mercury-decide:free', providerRef: '', modelRef: '', fallbackModelRefs: [], timeoutMs: 2_000, apiKey: '' },
      { routing: { span: { enabled: false, apiKeyRef: 'file-secret:anyfusion/internal/routing-span' } } },
    );
    expect(section).toEqual({
      span: {
        enabled: true,
        model: 'inception/mercury-decide:free',
        timeoutMs: 2_000,
        apiKeyRef: 'file-secret:anyfusion/internal/routing-span',
      },
    });
    expect(JSON.stringify(section)).not.toContain('sk-');
  });

  it('keeps a disabled Span section so the stored key survives a toggle', () => {
    const section = buildSpanRoutingSection(
      { enabled: false, model: 'inception/mercury-decide:free', providerRef: '', modelRef: '', fallbackModelRefs: [], timeoutMs: 3_000, apiKey: '' },
      { routing: { span: { enabled: true, model: 'inception/mercury-decide:free', apiKeyRef: 'file-secret:anyfusion/internal/routing-span', timeoutMs: 3_000 } } },
    );
    expect(section).toMatchObject({ span: { enabled: false, apiKeyRef: 'file-secret:anyfusion/internal/routing-span' } });
  });

  it('clamps the timeout into the server-accepted range', () => {
    expect(clampTimeout(10)).toBe(500);
    expect(clampTimeout(999_999)).toBe(10_000);
    expect(clampTimeout(Number.NaN)).toBe(8_000);
  });
});

describe('Web long-term memory editing', () => {
  it('reads a revision without a memory section as disabled', () => {
    expect(loadMemoryDraft({})).toEqual({ enabled: false, providerRef: '', modelRef: '' });
  });

  it('reads the stored provider and model', () => {
    expect(loadMemoryDraft({
      memory: { enabled: true, providerRef: 'openai-like', modelRef: 'extraction-model' },
    })).toEqual({ enabled: true, providerRef: 'openai-like', modelRef: 'extraction-model' });
  });

  it('does not add a memory section for a revision that never had one', () => {
    expect(buildMemorySection(
      { enabled: false, providerRef: '', modelRef: '' },
      {},
    )).toBeUndefined();
  });

  it('writes an explicit provider and model when memory is enabled', () => {
    const section = buildMemorySection(
      { enabled: true, providerRef: ' openai-like ', modelRef: ' extraction-model ' },
      {},
    );
    expect(section).toEqual({
      enabled: true,
      providerRef: 'openai-like',
      modelRef: 'extraction-model',
    });
  });

  it('never auto-fills an extraction model', () => {
    const section = buildMemorySection(
      { enabled: true, providerRef: '', modelRef: '' },
      {},
    );
    // An empty reference must be omitted, not written as '': the schema rejects
    // an empty ref, and "enabled but no model yet" is a valid persisted state.
    expect(section).toEqual({ enabled: true });
  });

  it('keeps the stored section so a toggle does not drop it', () => {
    const section = buildMemorySection(
      { enabled: false, providerRef: 'openai-like', modelRef: 'extraction-model' },
      { memory: { enabled: true, providerRef: 'openai-like', modelRef: 'extraction-model', retrieval: { maxResults: 8 } } },
    );
    expect(section).toMatchObject({
      enabled: false,
      providerRef: 'openai-like',
      modelRef: 'extraction-model',
      retrieval: { maxResults: 8 },
    });
  });
});
