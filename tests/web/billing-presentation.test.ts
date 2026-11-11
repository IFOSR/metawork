import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../../web/src/', import.meta.url);

describe('Web token usage presentation', () => {
  it('opens account-wide token usage without adding an amount card to a Turn', async () => {
    const [turn, app, usage] = await Promise.all([
      readFile(new URL('components/ConversationTurn.tsx', root), 'utf8'),
      readFile(new URL('App.tsx', root), 'utf8'),
      readFile(new URL('components/TokenUsageView.tsx', root), 'utf8'),
    ]);
    expect(app).toContain('<TokenUsageView http={http} />');
    expect(turn).not.toContain('TurnBillCard');
    expect(usage).toContain('Total tokens');
    expect(usage).toContain('Included');
    expect(usage).toContain('On-demand');
  });

  it('offers period and Provider grouping controls over the token timeline', async () => {
    const [usage, http] = await Promise.all([
      readFile(new URL('components/TokenUsageView.tsx', root), 'utf8'),
      readFile(new URL('api/http.ts', root), 'utf8'),
    ]);
    expect(usage).toContain('时间区间');
    expect(usage).toContain('Group By');
    expect(usage).toContain('按 Provider');
    expect(usage).toContain('按天用量趋势');
    expect(http).toContain('/api/usage/timeline');
    expect(http).not.toContain('getBillingRecords');
  });

  it('drops the meaningless period-quota card and shows the real provider directory', async () => {
    const usage = await readFile(new URL('components/TokenUsageView.tsx', root), 'utf8');
    // The quota window/limit/remaining block was noise in the account bill view.
    expect(usage).not.toContain('本周期 Included');
    expect(usage).not.toContain('quotaWindow');
    // The maintained third-party provider keeps its own identity and logo.
    expect(usage).toContain('第三方供应商');
    expect(usage).toContain('provider.logoUrl');
  });
});
