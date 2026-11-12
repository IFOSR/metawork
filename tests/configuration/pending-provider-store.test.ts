import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePendingProviderStore } from '../../src/configuration/pending-provider-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'pending-provider-'));
  roots.push(root);
  return { root, pending: new FilePendingProviderStore(root) };
}

const provider = {
  providerRef: 'custom-model-1',
  baseUrl: 'https://api.kimi.com/coding/v1',
  protocol: 'openai-compatible',
  apiKeyRef: 'file-secret:anyfusion/providers/custom-model-1',
  savedAt: '2026-11-12T00:00:00.000Z',
};

describe('FilePendingProviderStore', () => {
  it('returns an empty list when nothing was staged', async () => {
    const { pending } = await store();
    expect(await pending.read()).toEqual([]);
  });

  it('remembers a staged provider and reads it back', async () => {
    const { pending } = await store();
    await pending.remember(provider);
    expect(await pending.read()).toEqual([provider]);
  });

  it('replaces the same provider instead of duplicating it', async () => {
    const { pending } = await store();
    await pending.remember(provider);
    await pending.remember({ ...provider, baseUrl: 'https://api.deepseek.com/v1' });
    const stored = await pending.read();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.baseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('forgets providers that entered the active configuration', async () => {
    const { pending } = await store();
    await pending.remember(provider);
    await pending.remember({ ...provider, providerRef: 'custom-model-2' });
    await pending.forget(['custom-model-1']);
    const stored = await pending.read();
    expect(stored.map(item => item.providerRef)).toEqual(['custom-model-2']);
  });

  it('ignores malformed content instead of failing the caller', async () => {
    const { root, pending } = await store();
    await rm(join(root, 'pending-providers.json'), { force: true });
    expect(await pending.read()).toEqual([]);
  });
});
