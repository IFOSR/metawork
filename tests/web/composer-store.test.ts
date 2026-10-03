import { describe, expect, it } from 'vitest';
import { ComposerStore } from '../../web/src/observation/composer-store.js';

describe('bounded Conversation drafts', () => {
  it('rejects overflow without evicting user work and releases empty slots', () => {
    const store = new ComposerStore();
    for (let n = 0; n < 64; n++) store.set(String(n), { draft: `draft ${n}`, attachments: [] });
    expect(() => store.set('extra', { draft: 'new', attachments: [] })).toThrow('64');
    expect(store.get('0')?.draft).toBe('draft 0');
    store.set('0', { draft: '', attachments: [] });
    store.set('extra', { draft: 'new', attachments: [] });
    expect(store.get('extra')?.draft).toBe('new');
  });
  it('accounts for UTF-8 bytes and preserves the last valid edit', () => {
    const store = new ComposerStore();
    store.set('a', { draft: 'saved', attachments: [] });
    expect(() => store.set('a', { draft: '汉'.repeat(16385), attachments: [] })).toThrow('过长');
    expect(store.get('a')?.draft).toBe('saved');
    store.clear(); expect(store.get('a')).toBeUndefined();
  });
});
