import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, it } from 'vitest';

class FakeElement {
  hidden = false;
  disabled = false;
  textContent = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  private listeners = new Map<string, () => void>();
  setAttribute(): void {}
  removeAttribute(): void {}
  addEventListener(type: string, listener: () => void): void { this.listeners.set(type, listener); }
  click(): void { this.listeners.get('click')?.(); }
}

describe('desktop shell error actions', () => {
  it('offers quit instead of retrying an older Desktop against a newer Runtime', async () => {
    const ids = ['status', 'heading', 'retry', 'quit', 'upgrade', 'update-status', 'update-progress'];
    const elements = new Map(ids.map(id => [id, new FakeElement()]));
    const calls: string[] = [];
    const state = { phase: 'error' as const, retryable: false, action: 'quit' as const,
      message: '当前 Desktop 版本低于已安装的后台运行时。' };
    const bridge = {
      state: () => Promise.resolve(state),
      retry: async () => { calls.push('retry'); },
      quit: async () => { calls.push('quit'); },
      upgrade: async () => undefined,
      onState: () => () => undefined,
    };
    const document = {
      body: { dataset: {} as Record<string, string> },
      getElementById: (id: string) => elements.get(id)!,
    };
    const context = { document, window: { metaworkShell: bridge }, setTimeout };
    const shell = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'shell', 'shell.js'), 'utf8');
    vm.runInNewContext(shell, context);
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(elements.get('retry')!.hidden, true);
    assert.equal(elements.get('quit')!.hidden, false);
    assert.equal(elements.get('heading')!.textContent, '需要更新桌面应用');
    elements.get('quit')!.click();
    assert.deepEqual(calls, ['quit']);
  });
});
