import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../../web/src/', import.meta.url);

describe('Web billing presentation', () => {
  it('keeps the conversation bill card after the task result and opens the billing tab', async () => {
    const [turn, card, app] = await Promise.all([
      readFile(new URL('components/ConversationTurn.tsx', root), 'utf8'),
      readFile(new URL('components/TurnBillCard.tsx', root), 'utf8'),
      Promise.all(['App.tsx', 'observation/use-workspace-controller.ts'].map(path => readFile(new URL(path, root), 'utf8'))).then(parts => parts.join('\n')),
    ]);

    expect(turn.indexOf('className="final-answer"')).toBeLessThan(
      turn.indexOf('<TurnBillCard'),
    );
    expect(card).toContain('onOpenBilling');
    expect(card).toContain('阶段与模型用量');
    expect(card).toContain('查看账单详情');
    expect(card).not.toContain('<details');
    expect(app).toContain('setTab(\'billing\')');
    expect(app).toContain('selectedBillingTurnId');
  });

  it('binds the billing tab to the selected Query instead of loading historical records', async () => {
    const [billingView, app] = await Promise.all([
      readFile(new URL('components/BillingView.tsx', root), 'utf8'),
      Promise.all(['App.tsx', 'observation/use-workspace-controller.ts'].map(path => readFile(new URL(path, root), 'utf8'))).then(parts => parts.join('\n')),
    ]);

    expect(billingView).toContain('bill: QueryBillProjection | null');
    expect(billingView).toContain('<QueryBill');
    expect(billingView).not.toContain('getBillingRecords');
    expect(billingView).not.toContain('getBillingTasks');
    expect(app).toContain('<ObservedTurnDetails');
    const details = await readFile(new URL('observation/ObservedTurnDetails.tsx', root), 'utf8');
    expect(details).toContain("kind: 'get_query_bill_for_turn', turnId");
    expect(details).toContain('<BillingView bill={turn.queryBill ?? null}');
  });
});
