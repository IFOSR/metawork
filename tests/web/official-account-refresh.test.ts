import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

const panelUrl = new URL('../../web/src/components/OfficialAccountPanel.tsx', import.meta.url);
const source = await readFile(panelUrl, 'utf8');
const panel = ts.createSourceFile('OfficialAccountPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects: ts.ArrowFunction[] = [];
function collect(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(panel) === 'useEffect'
    && node.arguments[0] && ts.isArrowFunction(node.arguments[0])) {
    effects.push(node.arguments[0]);
  }
  ts.forEachChild(node, collect);
}
collect(panel);

// Execute the real panel effects instead of a copy of their promise logic.
function runEffect(marker: string, scope: Record<string, unknown>): (() => void) | undefined {
  const effect = effects.find(item => item.getText(panel).includes(marker));
  if (!effect) throw new Error(`OfficialAccountPanel effect missing: ${marker}`);
  const { outputText } = ts.transpileModule(`(${effect.getText(panel)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return new Function(...Object.keys(scope), `return ${outputText.trim().replace(/;$/, '')}`)(...Object.values(scope))();
}

interface PanelStatus {
  state: string;
  account: { email: string } | null;
  entitlement: { plan: string | null; expiresAt: string | null } | null;
}
const active: PanelStatus = {
  state: 'active',
  account: { email: 'a@example.com' },
  entitlement: { plan: 'monthly', expiresAt: '2026-11-01T00:00:00.000Z' },
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('official account entitlement refresh', () => {
  it('refreshes the entitlement online when the client page is entered', async () => {
    const request = vi.fn(async (path: string) => {
      if (path === 'verify') return active;
      throw new Error(`unexpected request: ${path}`);
    });
    const setStatus = vi.fn();
    const onStatus = vi.fn();
    const cleanup = runEffect("request<OfficialStatus>('verify'", { request, setStatus, onStatus });

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('verify', {}));
    expect(setStatus).toHaveBeenCalledWith(active);
    expect(onStatus).toHaveBeenCalledWith(active);
    cleanup?.();
  });

  it('keeps the entitlement status when the page-entry refresh fails', async () => {
    const request = vi.fn(async () => { throw new Error('official service unreachable'); });
    const setStatus = vi.fn();
    const onStatus = vi.fn();
    const cleanup = runEffect("request<OfficialStatus>('verify'", { request, setStatus, onStatus });

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('verify', {}));
    expect(setStatus).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
    cleanup?.();
  });

  it('keeps the periodic projection poll on the local Server state', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (path: string) => {
      if (path !== 'status') throw new Error(`unexpected request: ${path}`);
      return active;
    });
    const setStatus = vi.fn();
    const onStatus = vi.fn();
    const refresh = vi.fn(async () => { const value = await request('status'); setStatus(value); onStatus(value); });
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, handler: () => void) => listeners.set(type, handler)),
      removeEventListener: vi.fn(),
      setTimeout,
      clearTimeout,
    });
    const cleanup = runEffect('setInterval(() => void refresh(), 5000)', {
      request, setStatus, onStatus, refresh, setInterval, clearInterval,
    });

    await vi.advanceTimersByTimeAsync(5000);
    // 周期轮询只读本机投影，不得产生官方权益核验流量。
    expect(refresh).toHaveBeenCalled();
    expect(request.mock.calls.map(call => call[0])).toEqual(['status', 'status']);
    cleanup?.();
  });
});
