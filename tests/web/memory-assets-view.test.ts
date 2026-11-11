import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryApiClient,
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
  it('requests explicit pagination and can read subsequent asset pages', async () => {
    const request = vi.fn().mockResolvedValue(view());
    const api = createMemoryApiClient(request);
    await api.listAssets();
    await api.listAssets({ limit: 50, offset: 50 });
    expect(request.mock.calls).toEqual([
      ['/api/memory/assets?limit=50&offset=0', undefined],
      ['/api/memory/assets?limit=50&offset=50', undefined],
    ]);
  });
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

describe('memory asset list presentation', () => {
  it('pages ten assets at a time, shows the time and colours the layer badge', async () => {
    const panel = await (await import('node:fs/promises')).readFile(
      new URL('../../web/src/components/MemoryAssetsPanel.tsx', import.meta.url), 'utf8');
    expect(panel).toContain('const ASSET_PAGE_SIZE = 10;');
    // The list row carries the update time, so users need not open the detail.
    expect(panel).toContain('dateLabel(asset.updatedAt)');
    // Layer identity is a coloured badge, not only a text prefix.
    expect(panel).toContain('memory-layer-badge');
    // Bodies are Markdown; the one-line preview must not print its syntax.
    expect(panel).toContain('<MarkdownContent value={currentDetail.content} />');
    expect(panel).toContain('markdownPreview(asset.preview');
  });
});
