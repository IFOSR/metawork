# 飞书接入本机绑定/解绑实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让单台机器可以通过 CLI（`metawork server bind-feishu` / `unbind-feishu`）与飞书解绑/重绑，本机操作不影响其他机器。

**Architecture:** 解绑 = 通过权威 ConfigurationService 将本机 `gateway.platforms.feishu.enabled` 置 false 并激活；运行中的 Server 经既有 `FeishuRuntimeManager.applyConfiguration` 停掉长连接。凭据保留，重绑一键恢复。仅 CLI，不改 Web 端、不改热路径契约。

**Tech Stack:** Node 22.19+ TypeScript ESM、vitest。

**设计文档:** [飞书接入本机绑定/解绑机制设计](2026-09-19-feishu-gateway-bind-unbind-design.md)

**范围说明（2026-09-19 修订）：** Web 端开关与首次绑定向导已按用户决定移出范围；原计划的 `isHotPath` 热路径扩展随之取消（其唯一消费者是 Web 激活门控）。

---

### Task 1: FeishuRuntimeManager 解绑即停桥测试

**Files:**
- Test: `tests/gateway/feishu-runtime.test.ts`

**Step 1: Write the failing test**

在 `tests/gateway/feishu-runtime.test.ts` 的 `describe` 末尾追加（复用文件顶部 `baseConfig` 与 mock 模式）：

```ts
  it('stops the active bridge when this machine unbinds Feishu', async () => {
    const bridge = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const createBridge = vi.fn()
      .mockReturnValueOnce(bridge)
      .mockReturnValueOnce(null);
    const manager = new FeishuRuntimeManager({
      session: { appendSystemMessage: vi.fn() } as any,
      createBridge,
    });

    await manager.applyConfiguration(baseConfig);
    expect(bridge.start).toHaveBeenCalledTimes(1);

    await manager.applyConfiguration({
      ...baseConfig,
      integrations: {
        ...baseConfig.integrations,
        feishu: { ...baseConfig.integrations.feishu, enabled: false },
      },
    });

    expect(bridge.stop).toHaveBeenCalledTimes(1);
    await manager.stop();
    expect(bridge.stop).toHaveBeenCalledTimes(1);
  });
```

**Step 2: Run test**

Run: `npx vitest run tests/gateway/feishu-runtime.test.ts`
Expected: PASS。若失败，说明 `FeishuRuntimeManager.applyConfiguration` 对 `createBridge` 返回 null 的处理有 bug，修复 `src/gateway/feishu-runtime.ts`（fingerprint 变化时先 `stop()` 旧桥再将 `active` 置为 null）后再跑到 PASS。

**Step 3: Commit**

```bash
git add tests/gateway/feishu-runtime.test.ts src/gateway/feishu-runtime.ts
git commit -m "test: cover feishu bridge shutdown on machine unbind"
```

---

### Task 2: CLI 平台启停的配置激活函数

**Files:**
- Modify: `src/gateway/feishu-activation.ts`
- Test: `tests/gateway/feishu-platform-binding.test.ts`（新建）

**Step 1: Write the failing test**

新建 `tests/gateway/feishu-platform-binding.test.ts`（ConfigurationService + 临时仓库夹具模式参考 `tests/configuration/executor-manual-planner.test.ts:73-95`；配置校验参考 `tests/configuration/file-configuration-repository.test.ts:26-38` 的 `AnyFusionConfigurationV2Schema.parse`）：

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnyFusionConfigurationV2Schema } from '../../src/configuration/schema.js';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';
import { ConfigurationService } from '../../src/configuration/configuration-service.js';
import { withFeishuGatewayEnabled } from '../../src/gateway/feishu-activation.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function configuration() {
  return AnyFusionConfigurationV2Schema.parse({
    schemaVersion: 2,
    providers: {},
    models: {},
    harnesses: {},
    agentClasses: {},
    permissionProfiles: {},
    runtimePolicy: {},
    gateway: {
      platforms: {
        feishu: {
          enabled: true,
          domain: 'feishu',
          connection_mode: 'websocket',
          app_id: 'cli_test',
          app_secret_env: 'FEISHU_APP_SECRET',
        },
      },
    },
  });
}

describe('Feishu platform bind/unbind', () => {
  it('flips enabled while preserving credentials and the rest of the definition', () => {
    const unbound = withFeishuGatewayEnabled(configuration(), false);
    const feishu = unbound.gateway.platforms!.feishu!;
    expect(feishu.enabled).toBe(false);
    expect(feishu.app_id).toBe('cli_test');
    expect(feishu.app_secret_env).toBe('FEISHU_APP_SECRET');
    expect(feishu.connection_mode).toBe('websocket');
    // 原对象不被修改
    expect(configuration().gateway.platforms!.feishu!.enabled).toBe(true);
  });

  it('rejects bind/unbind when this machine has no Feishu platform definition', () => {
    const bare = configuration();
    delete bare.gateway.platforms;
    expect(() => withFeishuGatewayEnabled(bare, false))
      .toThrow(/setup-feishu/);
  });

  it('activates the unbound revision through ConfigurationService', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-binding-'));
    roots.push(root);
    const service = new ConfigurationService({
      repository: new FileConfigurationRepository(join(root, 'config')),
      probe: async () => ({ ok: true }),
    });
    await service.initialize();
    const initial = service.createDraft(configuration(), null);
    service.validateDraft(initial.revisionId);
    service.compileDraft(initial.revisionId);
    await service.probeDraft(initial.revisionId);
    await service.activateDraft(initial.revisionId, null);

    const candidate = withFeishuGatewayEnabled(
      structuredClone((await service.getActiveSnapshot()).config), false,
    );
    const draft = service.createDraft(candidate, initial.revisionId);
    expect(service.validateDraft(draft.revisionId).ok).toBe(true);
    service.compileDraft(draft.revisionId);
    await service.probeDraft(draft.revisionId);
    const activated = await service.activateDraft(draft.revisionId, initial.revisionId);
    expect(activated.ok).toBe(true);
    const active = await service.getActiveSnapshot();
    expect(active.config.gateway.platforms!.feishu!.enabled).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gateway/feishu-platform-binding.test.ts`
Expected: FAIL — `withFeishuGatewayEnabled` 未导出。

**Step 3: Write minimal implementation**

在 `src/gateway/feishu-activation.ts` 追加导出（纯函数，不做 IO）：

```ts
/**
 * Returns a copy of the configuration with this machine's Feishu platform
 * enabled/disabled. Credentials and the rest of the platform definition are
 * preserved so rebinding does not require the setup wizard.
 */
export function withFeishuGatewayEnabled(
  config: AnyFusionConfigurationV2,
  enabled: boolean,
): AnyFusionConfigurationV2 {
  const feishu = config.gateway?.platforms?.feishu;
  if (!feishu) {
    throw new Error('本机尚未绑定飞书，请先运行 `metawork server setup-feishu`');
  }
  const next = structuredClone(config);
  next.gateway = {
    ...next.gateway,
    platforms: { ...next.gateway.platforms, feishu: { ...feishu, enabled } },
  };
  return next;
}
```

并新增与 `activateFeishuGatewayPlatform` 对称的入口（两者公共的仓库/SecretStore/Service 装配提取为内部 helper 以保持 DRY）：

```ts
export interface SetFeishuGatewayBindingInput {
  enabled: boolean;
  installRoot?: string;
  revisionPrefix?: string;
}

export async function setFeishuGatewayBinding(
  input: SetFeishuGatewayBindingInput,
): Promise<{ revisionId: string | null; changed: boolean }> {
  // 与 activateFeishuGatewayPlatform 相同的装配；mutate 为：
  //   next = withFeishuGatewayEnabled(snapshot.config, input.enabled)
  // changed = 原 feishu.enabled !== input.enabled
  // changed === false 时不创建新 revision，返回 { revisionId: null, changed: false }
  // 校验/编译/探针/激活失败时抛出带「飞书绑定状态」前缀的错误，语义同现有函数。
}
```

注意：`setFeishuGatewayBinding` 的 probe 复用 `createProductionConfigurationProbe` 即可；`enabled: false` 时飞书平台字段仍在 schema 内，校验不受影响。

**Step 4: Run tests**

Run: `npx vitest run tests/gateway/feishu-platform-binding.test.ts tests/gateway/feishu-runtime.test.ts`
Expected: PASS。

**Step 5: Commit**

```bash
git add src/gateway/feishu-activation.ts tests/gateway/feishu-platform-binding.test.ts
git commit -m "feat: add feishu platform bind/unbind activation entry"
```

---

### Task 3: CLI 命令接入 `server bind-feishu` / `server unbind-feishu`

**Files:**
- Modify: `src/cli/args.ts`（`ServerAction`、`SERVER_ACTIONS`、`formatCliHelp`）
- Modify: `src/index.ts`（action 分派）
- Test: `tests/cli/args.test.ts`

**Step 1: Write the failing test**

在 `tests/cli/args.test.ts` 的 setup-feishu 用例（约 98-101 行）后追加：

```ts
  it('parses Feishu bind and unbind as Server actions', () => {
    expect(parseCliArgs(['server', 'bind-feishu']))
      .toEqual({ kind: 'server', action: 'bind-feishu' });
    expect(parseCliArgs(['server', 'unbind-feishu']))
      .toEqual({ kind: 'server', action: 'unbind-feishu' });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/args.test.ts`
Expected: FAIL — `未知 server 子命令: bind-feishu`。

**Step 3: Write minimal implementation**

`src/cli/args.ts`：

```ts
export type ServerAction = 'start' | 'stop' | 'restart' | 'status' | 'doctor'
  | 'setup-feishu' | 'bind-feishu' | 'unbind-feishu';

const SERVER_ACTIONS: readonly ServerAction[] = [
  'start', 'stop', 'restart', 'status', 'doctor',
  'setup-feishu', 'bind-feishu', 'unbind-feishu',
];
```

`formatCliHelp` 的 Server 列表中 `setup-feishu` 后补两行：

```
  metawork server bind-feishu       重新启用本机飞书接入（保留凭据）
  metawork server unbind-feishu     停用本机飞书接入（保留凭据，不影响其他机器）
```

`src/index.ts`：在 setup-feishu 分派旁新增：

```ts
: command.kind === 'server' && (command.action === 'bind-feishu' || command.action === 'unbind-feishu')
  ? runSetFeishuBinding(command.action === 'bind-feishu')
```

并实现（静态 import `setFeishuGatewayBinding`，与同文件 `activateFeishuGatewayPlatform` 的 import 风格一致）：

```ts
async function runSetFeishuBinding(enabled: boolean): Promise<void> {
  const result = await setFeishuGatewayBinding({ enabled });
  process.stdout.write(
    !result.changed
      ? `本机飞书接入已处于${enabled ? '启用' : '停用'}状态，无需变更。\n`
      : enabled
        ? `本机飞书接入已启用（revision ${result.revisionId}）。\n`
        : `本机飞书接入已停用（revision ${result.revisionId}）。凭据保留在本机，其他机器不受影响。\n`,
  );
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/cli/args.test.ts && npm run lint`
Expected: PASS + 无类型错误。

**Step 5: Commit**

```bash
git add src/cli/args.ts src/index.ts tests/cli/args.test.ts
git commit -m "feat: add server bind-feishu and unbind-feishu commands"
```

---

### Task 4: 文档同步与全量验证

**Files:**
- Modify: `CONTEXT.md`
- Modify: `docs/plans/2026-09-19-feishu-gateway-bind-unbind-design.md`（状态行与实施记录）

**Step 1: 更新 CONTEXT.md**

在网关/运行时不变量相关小节补一条：飞书绑定状态是机器本地的
（`gateway.platforms.feishu.enabled`），通过 `metawork server bind-feishu` /
`unbind-feishu` 切换；解绑保留凭据、不影响其他机器；Web 端不提供该操作。

**Step 2: 设计文档收尾**

状态行改为"已实现"，填写完成日期、验证命令与收尾 commit hash。

**Step 3: 全量验证**

```bash
npm run lint
npx vitest run tests/gateway/feishu-platform-binding.test.ts \
  tests/gateway/feishu-runtime.test.ts \
  tests/cli/args.test.ts
npm run build
```

Expected: 全部通过。

**Step 4: Commit**

```bash
git add CONTEXT.md docs/plans/2026-09-19-feishu-gateway-bind-unbind-design.md
git commit -m "docs: record feishu bind/unbind machine-local contract"
```

---

### 验收清单

- [ ] `metawork server unbind-feishu` 后本机不再接收飞书消息；运行中的 Server 热停桥；Linux 机器不受影响
- [ ] `metawork server bind-feishu` 一键恢复，无需重新走 `setup-feishu` 向导
- [ ] 未绑定过的机器执行两个命令均报错并提示 `setup-feishu`
- [ ] 重复执行同状态命令时不创建新 revision，输出"已处于…状态"
- [ ] `npm run lint` 与上述聚焦测试全部通过
