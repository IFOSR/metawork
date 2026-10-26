import { describe, expect, it } from 'vitest';
import {
  memoryAssetViewState,
  type MemoryAssetListView,
} from '../../web/src/api/memory.js';

function view(overrides: Partial<MemoryAssetListView> = {}): MemoryAssetListView {
  return {
    items: [],
    total: 0,
    mode: 'enabled',
    degraded: false,
    ...overrides,
  };
}

describe('memory asset view state', () => {
  it('shows a loading state before the first response', () => {
    expect(memoryAssetViewState(null)).toEqual({ kind: 'loading' });
  });

  it('shows the engine reason instead of an empty asset list when degraded', () => {
    expect(memoryAssetViewState(view({
      mode: 'degraded',
      degraded: true,
      degradedReason: 'memory_engine_unreachable',
    }))).toEqual({ kind: 'degraded', reason: 'memory_engine_unreachable' });
  });

  it('falls back to a stable degraded reason when the server omits one', () => {
    expect(memoryAssetViewState(view({ mode: 'degraded', degraded: true })))
      .toEqual({ kind: 'degraded', reason: 'memory_engine_unavailable' });
  });

  it('keeps disabled and needs-model as an honest empty list with their mode', () => {
    expect(memoryAssetViewState(view({ mode: 'disabled' }))).toEqual({ kind: 'empty' });
    expect(memoryAssetViewState(view({ mode: 'needs-model' }))).toEqual({ kind: 'empty' });
  });

  it('lists assets only when the runtime is healthy', () => {
    const asset = {
      memoryId: 'mem_1',
      tdaiMemoryId: 'tdai_1',
      type: 'instruction',
      preview: '偏好中文表格',
      source: 'conversation',
      workspaceId: null,
      enabled: true,
      createdAt: '',
      updatedAt: '',
    };
    expect(memoryAssetViewState(view({ items: [asset], total: 1 })))
      .toEqual({ kind: 'list', items: [asset] });
  });
});
