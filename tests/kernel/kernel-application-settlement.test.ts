import { describe, expect, it } from 'vitest';
import {
  formatApplicationSettlement,
  isEffectFreeSettlement,
  parseApplicationSettlement,
} from '../../src/kernel/kernel-application-settlement.js';

describe('Kernel application settlement', () => {
  it('tags a summary with the classification recovery reads back', () => {
    const summary = formatApplicationSettlement({
      kind: 'rejected_without_effect',
      code: 'service_not_startable',
      detail: '代码尚未发布到用户任务目录',
    });
    expect(summary).toBe('kernel_settlement/rejected_without_effect:service_not_startable 代码尚未发布到用户任务目录');
    expect(parseApplicationSettlement(summary)).toEqual({
      kind: 'rejected_without_effect',
      code: 'service_not_startable',
      detail: '代码尚未发布到用户任务目录',
    });
    expect(isEffectFreeSettlement(summary)).toBe(true);
  });

  it('does not treat a settled operation with an error as effect free', () => {
    const summary = formatApplicationSettlement({
      kind: 'operation_settled',
      code: 'service_operation_failed',
      detail: '监听端口已被占用',
    });
    expect(parseApplicationSettlement(summary)).toMatchObject({ kind: 'operation_settled' });
    expect(isEffectFreeSettlement(summary)).toBe(false);
  });

  it('rejects legacy free-text summaries so historical rows are never auto-converged', () => {
    expect(parseApplicationSettlement('服务与任务归属不匹配')).toBeNull();
    expect(parseApplicationSettlement(null)).toBeNull();
    expect(parseApplicationSettlement('kernel_settlement/unknown_kind:code detail')).toBeNull();
    expect(parseApplicationSettlement('kernel_settlement/rejected_without_effect:BAD CODE')).toBeNull();
    expect(isEffectFreeSettlement('代码尚未发布到用户任务目录')).toBe(false);
  });

  it('bounds the stored summary and strips newlines', () => {
    const summary = formatApplicationSettlement({
      kind: 'rejected_without_effect',
      code: 'service_not_startable',
      detail: `line one\nline two ${'x'.repeat(1_000)}`,
    });
    expect(summary.length).toBeLessThanOrEqual(320);
    expect(summary).not.toContain('\n');
    expect(parseApplicationSettlement(summary)?.code).toBe('service_not_startable');
  });
});
