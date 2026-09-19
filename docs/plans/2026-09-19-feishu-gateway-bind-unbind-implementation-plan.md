# 飞书接入本机绑定/解绑实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让单台机器可以通过 CLI（`bind-feishu`/`unbind-feishu`）和 Web 设置页开关与飞书解绑/重绑，本机操作不影响其他机器。

**Architecture:** 解绑 = 通过权威 ConfigurationService 将本机 `gateway.platforms.feishu.enabled` 置 false 并热激活；运行中的 Server 经既有 `FeishuRuntimeManager.applyConfiguration` 停掉长连接。凭据保留。Web 端复用现有 `http.activate()` 全量激活，不新增服务端 API。

**Tech Stack:** Node 22.19+ TypeScript ESM、vitest、React（web/）。

**设计文档:** [飞书接入本机绑定/解绑机制设计](2026-09-19-feishu-gateway-bind-unbind-design.md)

---

### Task 1: `gateway.platforms.feishu.` 标记为热路径

**Files:**
- Modify: `src/configuration/configuration-diff.ts`（`isHotPath`，约 108-121 行）
- Test: `tests/configuration/configuration-diff-classification.test.ts`

**Step 1: Write the failing test**

在 `tests/configuration/configuration-diff-classification.test.ts` 的 `describe` 末尾追加：

```ts
  it('classifies Feishu gateway platform binding changes as hot, but process-level gateway fields as restart', () => {
    const binding = classifyConfigurationDiff(
      { gateway: { platforms: { feishu: { enabled: true, app_id: 'cli_a' } } } },
      { gateway: { platforms: { feishu: { enabled: false, app_id: 'cli_a' } } } },
    );
    expect(binding.classification).toBe('hot');
    expect(binding.restartRequired).toBe(false);
    expect(binding.restartPaths).toEqual([]);

    const processLevel = classifyConfigurationDiff(
      { gateway: { port: 8788 } },
      { gateway: { port: 9999 } },
    );
    expect(processLevel.classification).toBe('restart_required');
    expect(processLevel.restartPaths).toEqual(['gateway.port']);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/configuration/configuration-diff-classification.test.ts`
Expected: FAIL — `binding.classification` 实际为 `'restart_required'`。

**Step 3: Write minimal implementation**

在 `src/configuration/configuration-diff.ts` 的 `isHotPath` 中追加一条（附注释）：

```ts
    // The Feishu platform bridge is recreated by FeishuRuntimeManager on any
    // fingerprint change during hot activation, so binding/unbinding this
    // machine (and other platform-scoped fields) is hot-safe. Process-level
    // gateway fields (port/bindHost) stay restart_required.
    || path.startsWith('gateway.platforms.feishu.')
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/configuration/configuration-diff-classification.test.ts`
Expected: PASS（全部用例）。

**Step 5: Commit**

```bash
git add src/configuration/configuration-diff.ts tests/configuration/configuration-diff-classification.test.ts
git commit -m "feat: classify feishu gateway platform changes as hot activation"
```

---

### Task 2: FeishuRuntimeManager 解绑即停桥测试

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

### Task 3: CLI 平台启停的配置激活函数

**Files:**
- Modify: `src/gateway/feishu-activation.ts`
- Test: `tests/gateway/feishu-platform-binding.test.ts`（新建）

**Step 1: Write the failing test**

新建 `tests/gateway/feishu-platform-binding.test.ts`（夹具模式参考 `tests/configuration/executor-manual-planner.test.ts:73-95` 的 ConfigurationService + 临时仓库用法，配置校验参考 `tests/configuration/file-configuration-repository.test.ts:26-38` 的 `AnyFusionConfigurationV2Schema.parse`）：

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

  it('activates the unbound revision through ConfigurationService as a hot change', async () => {
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

并新增与 `activateFeishuGatewayPlatform` 对称的入口（复用其仓库/SecretStore/Service 装配；可将两者公共部分提取为内部 helper `activateFeishuPlatformMutation(installRoot, revisionPrefix, mutate)` 以保持 DRY）：

```ts
export interface SetFeishuGatewayBindingInput {
  enabled: boolean;
  installRoot?: string;
  revisionPrefix?: string;
}

export async function setFeishuGatewayBinding(
  input: SetFeishuGatewayBindingInput,
): Promise<{ revisionId: string; changed: boolean }> {
  // 与 activateFeishuGatewayPlatform 相同的装配，mutate 为：
  //   next = withFeishuGatewayEnabled(snapshot.config, input.enabled)
  // changed = feishu.enabled 原值 !== input.enabled
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

### Task 4: CLI 命令接入 `server bind-feishu` / `server unbind-feishu`

**Files:**
- Modify: `src/cli/args.ts`（`ServerAction`、`parseServerArgs`、`formatCliHelp`）
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
  metawork server setup-feishu
  metawork server bind-feishu       重新启用本机飞书接入（保留凭据）
  metawork server unbind-feishu     停用本机飞书接入（保留凭据，不影响其他机器）
```

`src/index.ts`：在 setup-feishu 分派旁新增：

```ts
: command.kind === 'server' && (command.action === 'bind-feishu' || command.action === 'unbind-feishu')
  ? runSetFeishuBinding(command.action === 'bind-feishu')
```

并实现：

```ts
async function runSetFeishuBinding(enabled: boolean): Promise<void> {
  const { setFeishuGatewayBinding } = await import('./gateway/feishu-binding.js');
  // 或在 feishu-activation.ts 顶部静态 import，风格与同文件其他 import 一致
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

实现位置：把 `setFeishuGatewayBinding` 留在 `src/gateway/feishu-activation.ts` 并静态 import（与 `activateFeishuGatewayPlatform` 一致），不新建文件。

**Step 4: Run tests**

Run: `npx vitest run tests/cli/args.test.ts && npm run lint`
Expected: PASS + 无类型错误。

**Step 5: Commit**

```bash
git add src/cli/args.ts src/index.ts tests/cli/args.test.ts
git commit -m "feat: add server bind-feishu and unbind-feishu commands"
```

---

### Task 5: Web 纯逻辑模块 `gateway-binding.ts`

**Files:**
- Create: `web/src/gateway-binding.ts`
- Test: `tests/web/gateway-binding.test.ts`（新建）

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  applyFeishuGatewayEnabled,
  maskAppId,
  readFeishuGatewayBinding,
} from '../../web/src/gateway-binding.js';

const boundConfig = {
  gateway: {
    port: 8788,
    platforms: {
      feishu: {
        enabled: true,
        domain: 'feishu',
        connection_mode: 'websocket',
        app_id: 'cli_aa13c101a4389bea',
        app_secret_env: 'FEISHU_APP_SECRET',
      },
    },
  },
};

describe('Feishu gateway binding (web)', () => {
  it('reads the current binding state without exposing secrets', () => {
    const binding = readFeishuGatewayBinding(boundConfig);
    expect(binding).toEqual({
      configured: true,
      enabled: true,
      appId: 'cli_aa13c101a4389bea',
      maskedAppId: maskAppId('cli_aa13c101a4389bea'),
      connectionMode: 'websocket',
    });
    expect(JSON.stringify(binding)).not.toContain('app_secret');
  });

  it('reports unconfigured machines without a platform definition', () => {
    expect(readFeishuGatewayBinding({ gateway: {} })).toEqual({ configured: false, enabled: false });
    expect(readFeishuGatewayBinding({})).toEqual({ configured: false, enabled: false });
  });

  it('applies enabled flips immutably while preserving credentials and other gateway fields', () => {
    const next = applyFeishuGatewayEnabled(boundConfig, false) as typeof boundConfig;
    expect(next.gateway.platforms.feishu.enabled).toBe(false);
    expect(next.gateway.platforms.feishu.app_id).toBe('cli_aa13c101a4389bea');
    expect(next.gateway.port).toBe(8788);
    expect(boundConfig.gateway.platforms.feishu.enabled).toBe(true);
  });

  it('masks app ids keeping prefix and suffix recognizable', () => {
    expect(maskAppId('cli_aa13c101a4389bea')).toBe('cli_aa13…9bea');
    expect(maskAppId('short')).toBe('short');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web/gateway-binding.test.ts`
Expected: FAIL — 模块不存在。

**Step 3: Write minimal implementation**

新建 `web/src/gateway-binding.ts`（`RawRecord` 处理方式参考 `web/src/settings-model.ts` 中的 `asRecord` 模式）：

```ts
type RawRecord = Record<string, unknown>;

const asRecord = (value: unknown): RawRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as RawRecord : {};

export interface FeishuGatewayBinding {
  configured: boolean;
  enabled: boolean;
  appId?: string;
  maskedAppId?: string;
  connectionMode?: string;
}

export function maskAppId(appId: string): string {
  return appId.length > 10 ? `${appId.slice(0, 8)}…${appId.slice(-4)}` : appId;
}

export function readFeishuGatewayBinding(config: RawRecord): FeishuGatewayBinding {
  const feishu = asRecord(asRecord(asRecord(config.gateway).platforms).feishu);
  const appId = typeof feishu.app_id === 'string' && feishu.app_id ? feishu.app_id : undefined;
  if (!appId && Object.keys(feishu).length === 0) return { configured: false, enabled: false };
  return {
    configured: true,
    enabled: feishu.enabled !== false,
    ...(appId ? { appId, maskedAppId: maskAppId(appId) } : {}),
    ...(typeof feishu.connection_mode === 'string' ? { connectionMode: feishu.connection_mode } : {}),
  };
}

export function applyFeishuGatewayEnabled(config: RawRecord, enabled: boolean): RawRecord {
  const gateway = asRecord(config.gateway);
  const platforms = asRecord(gateway.platforms);
  const feishu = asRecord(platforms.feishu);
  return {
    ...config,
    gateway: {
      ...gateway,
      platforms: { ...platforms, feishu: { ...feishu, enabled } },
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/web/gateway-binding.test.ts`
Expected: PASS。

**Step 5: Commit**

```bash
git add web/src/gateway-binding.ts tests/web/gateway-binding.test.ts
git commit -m "feat: add web feishu gateway binding helpers"
```

---

### Task 6: SettingsPanel 高级设置中的「飞书接入」区块

**Files:**
- Modify: `web/src/components/SettingsPanel.tsx`
- Test: `tests/web/settings-workbench.test.ts`

**Step 1: Write the failing test**

在 `tests/web/settings-workbench.test.ts` 追加（该文件已有 `readFile` + `webRoot` 的源码断言模式，参考 "keeps internal revision identifiers out of the primary Settings UI" 用例）：

```ts
  it('exposes a Feishu binding toggle in advanced settings that ships with save-and-activate', async () => {
    const source = await readFile(new URL('components/SettingsPanel.tsx', webRoot), 'utf8');
    expect(source).toContain('飞书接入');
    expect(source).toContain('在本机启用飞书接入');
    expect(source).toContain('applyFeishuGatewayEnabled');
    expect(source).toContain('readFeishuGatewayBinding');
    // 勾选不立即激活：区块内不允许出现独立的 activate 调用按钮文案
    expect(source).not.toContain('立即解绑');
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web/settings-workbench.test.ts`
Expected: FAIL — 不包含 `飞书接入`。

**Step 3: Write minimal implementation**

`web/src/components/SettingsPanel.tsx`：

1. 顶部 import：

```ts
import {
  applyFeishuGatewayEnabled,
  readFeishuGatewayBinding,
  type FeishuGatewayBinding,
} from '../gateway-binding';
```

2. 状态（放在 `runtimePolicy` state 旁，约 361 行）：

```ts
const [feishuBinding, setFeishuBinding] = useState<FeishuGatewayBinding | null>(null);
const [feishuEnabled, setFeishuEnabled] = useState<boolean>(false);
```

3. `applyConfigSnapshot`（约 386 行）中在 `setRuntimePolicy(loadRuntimePolicy(config))` 后同步基线：

```ts
const binding = readFeishuGatewayBinding(config);
setFeishuBinding(binding);
setFeishuEnabled(binding.enabled);
```

4. `buildCandidateConfiguration` 的返回 config 中（约 754-765 行，`runtimePolicy` 之后）追加：

```ts
        ...(feishuBinding?.configured && feishuEnabled !== feishuBinding.enabled
          ? { gateway: applyFeishuGatewayEnabled(originalConfig, feishuEnabled) }
          : {}),
```

5. 在「高级设置」的 `advanced-settings-body` 内、`runtime-policy-section` 之后、`{plannerSection}` 之前插入新区块：

```tsx
<section className="runtime-policy-section feishu-binding-section">
  <div className="section-heading">
    <div>
      <div className="settings-eyebrow">GATEWAY</div>
      <h3>飞书接入</h3>
      <p>绑定状态只影响本机；停用后本机不再接收飞书消息，其他机器不受影响。</p>
    </div>
  </div>
  {feishuBinding?.configured ? (
    <>
      <div className="runtime-policy-grid">
        <label className="settings-field feishu-binding-toggle">
          <span>
            应用 {feishuBinding.maskedAppId}
            {feishuBinding.connectionMode
              ? ` · ${feishuBinding.connectionMode === 'websocket' ? '长连接' : 'Webhook'}`
              : ''}
          </span>
          <label className="executor-enable-row">
            <input
              type="checkbox"
              checked={feishuEnabled}
              disabled={editingDisabled}
              onChange={event => setFeishuEnabled(event.target.checked)}
            />
            <span>在本机启用飞书接入</span>
          </label>
          <small>勾选后随「保存并激活」一起生效；凭据保留在本机。</small>
        </label>
      </div>
    </>
  ) : (
    <div className="routing-section-note">
      本机尚未绑定飞书，请先运行 `metawork server setup-feishu` 完成初始绑定。
    </div>
  )}
</section>
```

6. footer 提示文案（两处，约 1779-1783 行）把「只应用模型列表、智能体路由与运行时策略」改为「应用模型列表、智能体路由、运行时策略与飞书接入开关」。

注意：`editingDisabled` 为文件内既有变量（含门控判断）；若名称不同以实际为准。

**Step 4: Run tests**

Run: `npx vitest run tests/web/settings-workbench.test.ts tests/web/gateway-binding.test.ts && cd web && npx tsc --noEmit && cd ..`
Expected: PASS + web 类型检查无错误。

**Step 5: Commit**

```bash
git add web/src/components/SettingsPanel.tsx tests/web/settings-workbench.test.ts
git commit -m "feat: add feishu binding toggle to advanced settings"
```

---

### Task 7: 文档同步（ADR-0033 / CONTEXT.md）

**Files:**
- Modify: `docs/adr/0033-hot-configuration-activation-and-auto-model-routing.md`
- Modify: `CONTEXT.md`
- Modify: `docs/plans/2026-09-19-feishu-gateway-bind-unbind-design.md`（状态行）

**Step 1: 更新 ADR-0033**

在热路径清单中补充：`gateway.platforms.feishu.` 前缀为热路径，理由是
`FeishuRuntimeManager` 在激活成功/回滚回调中对任何平台 fingerprint 变化执行
全量停旧建新；`gateway.port`/`bindHost` 等进程级字段仍为 restart_required。
同时记录新增的 `server bind-feishu` / `server unbind-feishu` 命令语义。

**Step 2: 更新 CONTEXT.md**

在运行时不变量/网关节中补一条：飞书绑定状态是机器本地的
（`gateway.platforms.feishu.enabled`），解绑保留凭据、不影响其他机器。

**Step 3: 设计文档状态行**改为"已实现"，并填写实施记录（完成日期、验证命令、收尾 commit）。

**Step 4: 全量验证**

```bash
npm run lint
npx vitest run tests/configuration/configuration-diff-classification.test.ts \
  tests/gateway/feishu-platform-binding.test.ts \
  tests/gateway/feishu-runtime.test.ts \
  tests/cli/args.test.ts \
  tests/web/gateway-binding.test.ts \
  tests/web/settings-workbench.test.ts
npm run build
```

Expected: 全部通过。

**Step 5: Commit**

```bash
git add docs/adr/0033-hot-configuration-activation-and-auto-model-routing.md CONTEXT.md docs/plans/2026-09-19-feishu-gateway-bind-unbind-design.md
git commit -m "docs: record feishu bind/unbind hot path contract"
```

---

### 验收清单

- [ ] `metawork server unbind-feishu` 后本机日志出现桥接停止、不再收飞书消息；Linux 机器不受影响
- [ ] `metawork server bind-feishu` 一键恢复，无需重新走向导
- [ ] Web 高级设置中勾选/取消勾选后「保存并激活」热生效，系统不空闲时开关禁用
- [ ] 未配置飞书的机器显示引导文案而非开关
- [ ] `npm run lint` 与上述聚焦测试全部通过
