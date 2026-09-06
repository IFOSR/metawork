import { describe, expect, it, vi } from 'vitest';
import {
  FeishuCardDeliveryMachine,
  FeishuCardDeliveryRegistry,
  type FeishuCardDeliveryOps,
  type FeishuCardUpdateFailureClass,
} from '../../src/integrations/feishu-card-delivery-machine.js';

interface Harness {
  machine: FeishuCardDeliveryMachine;
  created: string[];
  updates: Array<{ messageId: string; markdown: string }>;
  audit: Array<{ outcome: string; state: string }>;
  diagnostics: string[];
  failWith: { error: string; classification: FeishuCardUpdateFailureClass } | null;
  nowMs: () => number;
  setNow: (ms: number) => void;
}

function setup(options: { updateCooldownMs?: number; replacementCooldownMs?: number } = {}): Harness {
  const created: string[] = [];
  const updates: Array<{ messageId: string; markdown: string }> = [];
  const audit: Array<{ outcome: string; state: string }> = [];
  const diagnostics: string[] = [];
  let failWith: { error: string; classification: FeishuCardUpdateFailureClass } | null = null;
  let clock = 1_000_000;
  const nowMs = () => clock;
  const ops: FeishuCardDeliveryOps = {
    createCard: async markdown => {
      const id = `om_${created.length + 1}`;
      created.push(id);
      void markdown;
      return id;
    },
    updateCard: async (messageId, markdown) => {
      updates.push({ messageId, markdown });
      if (failWith) return { ok: false, ...failWith };
      return { ok: true };
    },
  };
  const machine = new FeishuCardDeliveryMachine('conv:task:gen', ops, {
    nowMs,
    updateCooldownMs: options.updateCooldownMs ?? 5_000,
    replacementCooldownMs: options.replacementCooldownMs ?? 300_000,
    onAudit: record => audit.push({ outcome: record.outcome, state: record.state }),
    onDiagnostic: message => diagnostics.push(message),
  });
  return {
    machine,
    created,
    updates,
    audit,
    diagnostics,
    get failWith() {
      return failWith;
    },
    set failWith(value) {
      failWith = value;
    },
    nowMs,
    setNow: ms => {
      clock = ms;
    },
  } as Harness;
}

describe('FeishuCardDeliveryMachine (2026-09-06 plan §5.1/§5.2)', () => {
  it('creates the card once and throttles ordinary progress into in-place updates', async () => {
    const harness = setup();
    await harness.machine.paintProgress({ markdown: 'v1' });
    expect(harness.machine.state).toBe('card_created');
    expect(harness.created).toHaveLength(1);

    harness.setNow(harness.nowMs() + 1_000);
    await harness.machine.paintProgress({ markdown: 'v2' });
    expect(harness.machine.state).toBe('card_update_throttled');
    expect(harness.updates).toHaveLength(0);
    expect(harness.created).toHaveLength(1);

    harness.setNow(harness.nowMs() + 5_000);
    const flushed = await harness.machine.paintProgress({ markdown: 'v3' });
    expect(flushed.operation).toBe('updated');
    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0]!.markdown).toBe('v3');
    expect(harness.created).toHaveLength(1);
    expect(harness.audit.some(record => record.outcome === 'updated')).toBe(true);
  });

  it('degrades to create-only immediately on a contract-incompatible update failure', async () => {
    const harness = setup();
    await harness.machine.paintProgress({ markdown: 'v1' });
    harness.failWith = { error: '230001 invalid msg_type', classification: 'contract' };

    harness.setNow(harness.nowMs() + 10_000);
    const failed = await harness.machine.paintProgress({ markdown: 'v2' });
    expect(harness.machine.state).toBe('create_only_degraded');
    expect(failed.operation).toBe('suppressed');
    expect(harness.diagnostics).toHaveLength(1);

    // Replacement cards only under the replacement cooldown — never a flood.
    harness.setNow(harness.nowMs() + 10_000);
    const stillSuppressed = await harness.machine.paintProgress({ markdown: 'v3' });
    expect(stillSuppressed.operation).toBe('suppressed');
    expect(harness.created).toHaveLength(1);

    // After the cooldown the replacement shows the LATEST snapshot.
    harness.setNow(harness.nowMs() + 300_000);
    const replaced = await harness.machine.paintProgress({ markdown: 'v4' });
    expect(replaced.operation).toBe('replaced');
    expect(harness.created).toHaveLength(2);
    // One diagnostic per delivery scope even after repeated failures.
    expect(harness.diagnostics).toHaveLength(1);
  });

  it('keeps the update path armed for transient failures and retries the next paint', async () => {
    const harness = setup();
    await harness.machine.paintProgress({ markdown: 'v1' });
    harness.failWith = { error: 'network timeout', classification: 'transient' };

    harness.setNow(harness.nowMs() + 10_000);
    await harness.machine.paintProgress({ markdown: 'v2' });
    expect(harness.machine.state).toBe('card_update_failed');
    expect(harness.created).toHaveLength(1);
    expect(harness.diagnostics).toHaveLength(1);

    harness.failWith = null;
    harness.setNow(harness.nowMs() + 10_000);
    const retried = await harness.machine.paintProgress({ markdown: 'v3' });
    expect(retried.operation).toBe('updated');
    expect(harness.machine.state).toBe('card_created');
    expect(harness.diagnostics).toHaveLength(1);
  });

  it('suppresses duplicate event keys and paints terminal milestones immediately', async () => {
    const harness = setup();
    await harness.machine.paintProgress({ markdown: 'v1', eventKey: 'trace-1' });
    const duplicate = await harness.machine.paintProgress({
      markdown: 'v1-again',
      eventKey: 'trace-1',
    });
    expect(duplicate.operation).toBe('suppressed');

    // Immediate milestone bypasses the update cooldown.
    harness.setNow(harness.nowMs() + 1_000);
    const terminal = await harness.machine.paintTerminal({ markdown: '✔ 完成' });
    expect(terminal.operation).toBe('terminal');
    expect(harness.machine.state).toBe('terminal_painted');
    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0]!.markdown).toBe('✔ 完成');

    const after = await harness.machine.paintProgress({ markdown: 'late' });
    expect(after.operation).toBe('suppressed');
  });

  it('serializes concurrent paints so a card update never races its own create', async () => {
    const harness = setup();
    const ops: Array<Promise<{ operation: string }>> = [
      harness.machine.paintProgress({ markdown: 'a' }),
      harness.machine.paintProgress({ markdown: 'b' }),
      harness.machine.paintProgress({ markdown: 'c' }),
    ];
    await Promise.all(ops);
    expect(harness.created).toHaveLength(1);
  });

  it('shares card slots across requests through the bridge-level registry', async () => {
    const created: string[] = [];
    const registry = new FeishuCardDeliveryRegistry({
      opsFor: () => ({
        createCard: async markdown => {
          void markdown;
          const id = `om_${created.length + 1}`;
          created.push(id);
          return id;
        },
        updateCard: async () => ({ ok: true }),
      }),
      options: { nowMs: () => 5_000_000 },
    });
    const first = registry.machineFor('conv-1:task-1:gen-1');
    const second = registry.machineFor('conv-1:task-1:gen-1');
    expect(first).toBe(second);
    await first.paintProgress({ markdown: 'v1' });
    await second.paintProgress({ markdown: 'v2' });
    expect(created).toHaveLength(1);
    expect(registry.size()).toBe(1);
    registry.release('conv-1:task-1:gen-1');
    expect(registry.size()).toBe(0);
  });
});

describe('FeishuCardDeliveryMachine degraded terminal paint (2026-09-06 closure)', () => {
  it('never suppresses a terminal receipt inside the replacement cooldown', async () => {
    const created: string[] = [];
    let clock = 5_000_000;
    const machine = new FeishuCardDeliveryMachine('conv:task:gen', {
      createCard: async () => {
        const id = `om_${created.length + 1}`;
        created.push(id);
        return id;
      },
      updateCard: async () => ({ ok: false, error: '230001', classification: 'contract' }),
    }, { nowMs: () => clock, replacementCooldownMs: 300_000, updateCooldownMs: 5_000 });

    await machine.paintProgress({ markdown: 'v1' });
    // Update fails -> create_only_degraded, replacement suppressed within the
    // 5-min cooldown...
    clock += 10_000;
    const failed = await machine.paintProgress({ markdown: 'v2' });
    expect(failed.operation).toBe('suppressed');
    expect(machine.state).toBe('create_only_degraded');
    // ...but the terminal receipt still paints immediately.
    const terminal = await machine.paintTerminal({ markdown: '✔ 完成' });
    expect(terminal.operation).toBe('terminal');
    expect(created).toHaveLength(2);
  });
});
