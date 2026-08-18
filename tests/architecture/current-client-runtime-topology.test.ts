import { describe, expect, it } from 'vitest';

/**
 * ADR-0031 迁移前的现状表征。
 *
 * 记录当前多表面各自独立的 Session 基数。这些不兼容的 Session 模型正是
 * ADR-0031 要移除的对象：每个表面最终都要通过统一的 Gateway 接入同一个
 * AccountRuntime，而不再各自持有专属 Session。
 *
 * 该 helper 目前只是一个测试内的现状描述；当表面切换完成后（Phase 6），
 * 此处应改为对生产拓扑的断言（Task 18 的 unified-server-composition 测试）。
 */
interface CurrentClientTopology {
  gateway: 'per_connection_session';
  web: 'single_active_web_session';
  feishu: 'single_shared_session';
}

function currentClientTopology(): CurrentClientTopology {
  return {
    gateway: 'per_connection_session',
    web: 'single_active_web_session',
    feishu: 'single_shared_session',
  };
}

describe('current client runtime topology', () => {
  it('documents current incompatible session cardinalities', () => {
    expect(currentClientTopology()).toEqual({
      gateway: 'per_connection_session',
      web: 'single_active_web_session',
      feishu: 'single_shared_session',
    });
  });
});
