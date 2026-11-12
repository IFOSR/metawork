import { describe, expect, it, vi } from 'vitest';
import type { MemoryApiClient, MemoryAssetListView, MemoryAssetView } from '../../web/src/api/memory.js';
import { buildMemoryProfile, loadMemoryProfile } from '../../web/src/memory-profile.js';

const asset = (id: number, overrides: Partial<MemoryAssetView> = {}): MemoryAssetView => ({
  memoryId: `memory-${id}`, tdaiMemoryId: `upstream-${id}`, type: 'episodic',
  title: '记录', preview: '已记录的内容', layer: 'l1', enabled: true,
  source: 'conversation', workspaceId: null,
  createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', ...overrides,
});
const page = (items: MemoryAssetView[], total = items.length): MemoryAssetListView => ({
  items, total, mode: 'enabled', degraded: false,
});
const apiWith = (listAssets: MemoryApiClient['listAssets']) => ({ listAssets }) as MemoryApiClient;

describe('account memory profile', () => {
  it('counts all layers and disabled entries, and lets one memory describe several themes', () => {
    const profile = buildMemoryProfile([
      asset(1, { layer: 'l3', type: 'persona', preview: '个人背景：从事软件开发，关注黄金投资' }),
      asset(2, { layer: 'l2', type: 'instruction', enabled: false, preview: '偏好中文，表达简洁' }),
      asset(3, { type: 'unknown-a' }), asset(4, { type: 'unknown-b' }),
    ]);
    expect(profile.total).toBe(4);
    expect(profile.enabled).toBe(3);
    expect(profile.layers).toEqual({ l1: 2, l2: 1, l3: 1 });
    expect(profile.types).toContainEqual({ label: '其他', count: 2 });
    expect(profile.topics).toContainEqual({ label: '个人背景', count: 2 });
    for (const label of ['技术与工具', '投资与市场', '沟通与表达']) {
      expect(profile.topics).toContainEqual({ label, count: 1 });
    }
    expect(profile.topics).toContainEqual({ label: '其他内容', count: 2 });
  });

  it('prioritizes usable profile and experience excerpts without inventing content', () => {
    const memories = [asset(1), asset(2, { layer: 'l3', enabled: false }),
      asset(3, { layer: 'l2' }), asset(4, { layer: 'l3' }),
      asset(5, { layer: 'l2', updatedAt: '2026-11-12T00:00:00Z' })];
    expect(buildMemoryProfile(memories).highlights).toEqual([memories[3], memories[4], memories[2]]);
    expect(buildMemoryProfile([])).toMatchObject({ total: 0, enabled: 0, highlights: [], topics: [] });
  });

  it('loads every unfiltered page rather than profiling the visible list page', async () => {
    const memories = Array.from({ length: 215 }, (_, id) => asset(id));
    const listAssets = vi.fn<MemoryApiClient['listAssets']>(async input =>
      page(memories.slice(input!.offset, input!.offset + input!.limit), memories.length));
    const signal = new AbortController().signal;
    const result = await loadMemoryProfile(apiWith(listAssets), signal);
    expect(result.profile.total).toBe(215);
    expect(result.partial).toBe(false);
    expect(listAssets.mock.calls).toEqual([
      [{ limit: 200, offset: 0 }, signal], [{ limit: 200, offset: 200 }, signal],
    ]);
  });

  it('deduplicates repeated records and marks incomplete or changing snapshots honestly', async () => {
    const first = Array.from({ length: 200 }, (_, id) => asset(id));
    const duplicate = vi.fn().mockResolvedValueOnce(page(first, 201))
      .mockResolvedValueOnce(page([first[0]!], 201));
    const drift = vi.fn().mockResolvedValueOnce(page(first, 201))
      .mockResolvedValueOnce(page([asset(200)], 202));
    const short = vi.fn().mockResolvedValue(page([asset(0)], 100));
    for (const list of [duplicate, drift, short]) {
      expect((await loadMemoryProfile(apiWith(list), new AbortController().signal)).partial).toBe(true);
    }
    expect((await loadMemoryProfile(apiWith(vi.fn().mockResolvedValue(page([], 0))),
      new AbortController().signal)).partial).toBe(false);
  });

  it('bounds large account reads and labels the overview as partial', async () => {
    const list = vi.fn<MemoryApiClient['listAssets']>(async input => page(
      Array.from({ length: input!.limit }, (_, index) => asset(input!.offset + index)), 10_001));
    const result = await loadMemoryProfile(apiWith(list), new AbortController().signal);
    expect(result.profile.total).toBe(10_000);
    expect(result.partial).toBe(true);
    expect(list).toHaveBeenCalledTimes(50);
  });

  it('preserves service failures and aborts instead of presenting outages as empty memories', async () => {
    const degraded = apiWith(vi.fn().mockResolvedValue({ ...page([]), degraded: true,
      mode: 'degraded', degradedReason: 'engine_connection_refused' }));
    await expect(loadMemoryProfile(degraded, new AbortController().signal)).rejects.toThrow('engine_connection_refused');
    const controller = new AbortController();
    const list = vi.fn().mockImplementation(async () => { controller.abort(); return page([]); });
    await expect(loadMemoryProfile(apiWith(list), controller.signal)).rejects.toThrow();
    const notCalled = vi.fn();
    await expect(loadMemoryProfile(apiWith(notCalled), controller.signal)).rejects.toThrow();
    expect(notCalled).not.toHaveBeenCalled();
  });
});
