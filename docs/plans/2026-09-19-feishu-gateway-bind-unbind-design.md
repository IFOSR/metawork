# 飞书接入本机绑定/解绑机制设计

- 文档日期：2026-09-19
- 状态：设计已确认，待编写实施计划
- 已确认范围：本机解绑/绑定走权威 ConfigurationService 激活路径；解绑保留本机凭据（仅停用）；Web 设置页高级设置中提供勾选开关，随「保存并激活」生效
- 已确认边界：飞书后台应用凭据不做任何变更；`gateway.port`/`bindHost` 等进程级字段不纳入热路径，仍要求重启

## 1. 背景与问题

同一个飞书应用的凭据（`app_id`/`app_secret`）是应用级别的，不是机器级别的。
多台机器各自运行 MetaWork 并使用同一应用凭据时，每台机器都会建立独立的
WebSocket 长连接，飞书会在活跃连接之间分发事件。因此"把智能体绑定到另一台
机器"并不会让当前机器停止收消息——当前机器只要本地配置中
`gateway.platforms.feishu.enabled: true` 且持有凭据，就会持续接收飞书消息。

现状只有"绑定"链路（`metawork server setup-feishu` 向导 →
`activateFeishuGatewayPlatform` → 热激活 → `FeishuRuntimeManager` 建立长连接），
缺少对称的"解绑"机制。用户需要一种产品化的方式让**某一台机器**与飞书解绑，
且不影响其他机器。

## 2. 核心语义

- **绑定（bind）**：本机配置中 `gateway.platforms.feishu.enabled = true`，
  本机建立长连接接收飞书消息。
- **解绑（unbind）**：本机配置中 `gateway.platforms.feishu.enabled = false`，
  本机停止长连接。**凭据（`app_id`/`secret`）保留在本机**，重绑无需重新走向导。
- 绑定状态是**机器本地**的：每台机器有独立的配置仓库（`~/.metawork/`），
  一台机器的解绑/绑定对其他机器零感知。
- 飞书后台的应用、凭据、事件订阅不做任何变更（变更它们才会波及其他机器）。

## 3. CLI：`bind-feishu` / `unbind-feishu`

与 `setup-feishu` 对称，挂在 `metawork server` 命名空间下：

- `metawork server unbind-feishu`：新增 `deactivateFeishuGatewayPlatform`
  （镜像 `src/gateway/feishu-activation.ts` 的 `activateFeishuGatewayPlatform`），
  克隆当前激活配置、将 `gateway.platforms.feishu.enabled` 置为 `false`，
  通过 ConfigurationService 激活新 revision。运行中的 Server 热激活后由
  `FeishuRuntimeManager.applyConfiguration` 停掉本机桥接；Server 未运行时
  仅落盘，下次启动即不建连。
- `metawork server bind-feishu`：同一激活路径将 `enabled` 置回 `true`。
  本机从未配置过飞书平台（无 `gateway.platforms.feishu` 定义）时，
  报错并提示先运行 `metawork server setup-feishu`。
- 未配置时运行 `unbind-feishu`：视为无操作并明确提示"本机未绑定飞书"。

两个命令均复用配置激活门控：系统不空闲时按既有门控语义处理（与 Web 端一致）。

## 4. 热路径契约变更

`classifyConfigurationDiff`（`src/configuration/configuration-diff.ts` 的
`isHotPath`）目前不覆盖 gateway 路径，开关会被分类为 `restart_required`。

`FeishuRuntimeManager` 已挂在配置激活成功与回滚回调上
（`src/server/server-composition.ts`），对任何飞书平台 fingerprint 变化执行
全量停旧建新，因此 `gateway.platforms.feishu.` 子树的热激活是安全的。

变更：

- `isHotPath` 仅新增 `gateway.platforms.feishu.` 前缀；`gateway.enabled`、
  `gateway.port`、`gateway.bindHost` 等进程级字段维持 `restart_required`。
- 同步更新 ADR-0033 的热路径清单与 `CONTEXT.md` 的运行时不变量说明。

## 5. Web 设置页：高级设置中的「飞书接入」区块

位置：设置面板「高级设置」（`advanced-settings`）内，与「并行与队列」、
规划设置并列。

内容与交互：

- 展示当前绑定状态：应用 `app_id`（掩码显示）、连接模式（长连接/Webhook）、
  当前启用/停用状态。
- 一个「在本机启用飞书接入」勾选框，编辑进设置草稿（draft）。
- **生效方式：勾选本身不立即生效，随底部「保存并激活」一起提交**（用户已确认）。
  因此主激活流程的提交范围需要从"模型列表、智能体路由与运行时策略"扩展为
  包含 `gateway.platforms.feishu.enabled` 这一处变更；footer 提示文案同步更新。
- 复用现有激活门控：系统不空闲时勾选框禁用，并沿用既有
  `activationState.blockingReasons` 提示。
- 本机未配置过飞书平台时：不显示勾选框，显示引导文案
  "本机尚未绑定飞书，请先运行 `metawork server setup-feishu`"。

实现要点：Web `ConfigSnapshot.config` 已是完整 `AnyFusionConfigurationV2`
（含 `gateway`），无需新增服务端 API；设置草稿克隆配置后翻转
`gateway.platforms.feishu.enabled`，走现有 `http.activate()`。

## 6. 错误处理

- CLI 激活失败（revision 冲突、校验失败）：沿用
  `activateFeishuGatewayPlatform` 的错误语义，原样抛出并提示重试。
- Web 激活结果复用现有 `result-banner`：成功提示"配置已热激活"；
  `restart_required`（理论上不应再出现于本开关）按既有文案提示重启。
- 解绑后本机不再接收飞书消息；飞书侧已发出的消息由其他活跃连接
  （如 Linux 服务器）继续接收，本机不做消息迁移或补偿。

## 7. 测试

- `configuration-diff`：`gateway.platforms.feishu.enabled` 分类为 hot；
  `gateway.port` 仍为 `restart_required`。
- CLI：`deactivateFeishuGatewayPlatform` / 重新启用的 ConfigurationService
  路径（镜像现有 feishu-activation 测试的双层仓库结构）。
- `FeishuRuntimeManager`：`enabled` 翻转时停止/重建桥接（复用现有
  feishu-runtime 测试模式）。
- Web：勾选进入草稿、「保存并激活」提交包含 gateway 变更、门控禁用态、
  未配置态引导文案（vitest 组件测试）。

## 8. 明确不做

- 不改动飞书开放平台的应用、凭据或事件订阅。
- 不引入跨机器的绑定协调/抢占机制（如"哪台机器独占接入"）。
- 不迁移 CLI 其余配置命令（与本次范围无关）。
- `gateway.port`/`bindHost`/webhook `event_port` 变更仍要求重启，不在本次
  热路径扩展范围内。
