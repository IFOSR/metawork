# 飞书接入本机绑定/解绑机制设计

- 文档日期：2026-09-19
- 状态：已实现（2026-09-19）
- 实施记录：验证命令 `npm run lint`、`npx vitest run tests/gateway/feishu-platform-binding.test.ts tests/gateway/feishu-runtime.test.ts tests/cli/args.test.ts`、`npm run build` 全部通过；收尾 commit 见分支 `feat/executor-idle-management` 上 `feat: add server bind-feishu and unbind-feishu commands` 及其前后提交
- 已确认范围：仅在 CLI 提供本机绑定/解绑（`metawork server bind-feishu` / `unbind-feishu`）；走权威 ConfigurationService 激活路径；解绑保留本机凭据（仅停用）
- 已确认边界：Web 端不提供任何绑定/解绑操作（含开关与首次绑定向导，2026-09-19 用户确认砍掉）；飞书后台应用凭据不做任何变更；不新增热路径契约
- 决策记录：曾设计"Web 高级设置勾选开关（随保存并激活生效）"与"Web 首次绑定向导"，用户于 2026-09-19 明确改为仅 CLI；`gateway.platforms.feishu.` 的 `isHotPath` 扩展随之不再需要（无 Web 激活消费者，CLI 激活与 `setup-feishu` 同路）

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

- `metawork server unbind-feishu`：新增 `setFeishuGatewayBinding({ enabled: false })`
  （装配镜像 `src/gateway/feishu-activation.ts` 的 `activateFeishuGatewayPlatform`），
  克隆当前激活配置、将 `gateway.platforms.feishu.enabled` 置为 `false`，
  通过 ConfigurationService 激活新 revision。运行中的 Server 通过既有
  `FeishuRuntimeManager.applyConfiguration`（挂在激活成功/回滚回调上）停掉
  本机桥接；Server 未运行时仅落盘，下次启动即不建连。
- `metawork server bind-feishu`：同一激活路径将 `enabled` 置回 `true`。
  本机从未配置过飞书平台（无 `gateway.platforms.feishu` 定义）时，
  报错并提示先运行 `metawork server setup-feishu`。
- 未配置时运行 `unbind-feishu`：同样报错并提示（与 bind 一致），不静默成功。
- 已处于目标状态时：不创建新 revision，输出"已处于启用/停用状态"。

纯配置变换抽为可测试的纯函数 `withFeishuGatewayEnabled(config, enabled)`：
不可变克隆、保留凭据与平台定义其余字段、无平台定义时抛出带
`setup-feishu` 提示的错误。

## 4. 不需要的变更（明确排除）

- **不扩展 `isHotPath`**：`configuration-diff.ts` 的热路径清单维持现状。
  热分类的消费者是 Management API 的激活门控（Web 激活）；CLI 的
  ConfigurationService 激活与 `setup-feishu` 完全同路，不经过该分类拒绝逻辑。
- **不改 Web 端**：设置页不出现飞书绑定/解绑开关，也不提供首次绑定向导。
  首次绑定仍由 `metawork server setup-feishu` 完成。
- **不改 ADR-0033**：热路径契约无变化。

## 5. 错误处理

- CLI 激活失败（revision 冲突、校验失败、探针失败）：沿用
  `activateFeishuGatewayPlatform` 的错误语义，抛出带「飞书绑定状态」前缀的
  错误并提示重试。
- 解绑后本机不再接收飞书消息；飞书侧已发出的消息由其他活跃连接
  （如 Linux 服务器）继续接收，本机不做消息迁移或补偿。

## 6. 测试

- `withFeishuGatewayEnabled` 纯函数：翻转 enabled、保留凭据/其余字段、
  不可变性、无平台定义时报错（提示含 `setup-feishu`）。
- ConfigurationService 集成：临时仓库中激活 unbound revision 成功且
  active snapshot 的 `enabled` 为 false（夹具模式参考
  `tests/configuration/executor-manual-planner.test.ts`）。
- `FeishuRuntimeManager`：`enabled` 翻转时停止/重建桥接（复用
  `tests/gateway/feishu-runtime.test.ts` 现有模式）。
- CLI 参数解析：`server bind-feishu` / `server unbind-feishu`
  （`tests/cli/args.test.ts`）。

## 7. 明确不做

- Web 端的飞书绑定/解绑开关与首次绑定向导。
- 改动飞书开放平台的应用、凭据或事件订阅。
- 跨机器的绑定协调/抢占机制（如"哪台机器独占接入"）。
- `isHotPath` / ADR-0033 的热路径契约变更。
- 迁移 CLI 其余配置命令（与本次范围无关）。
