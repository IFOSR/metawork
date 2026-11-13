# P2-A：上游 Pi 集成 Spike 与差异清单

- 日期：2026-11-07
- 状态：完成（只读证据；未改动生产路径）
- 上位决策：[ADR-0055 Decision ledger](../adr/0055-no-kernel-target-architecture-and-contract-reset.md) D6
- 输入：[目标契约设计](2026-11-07-metawork-target-architecture-contract-design.md)、[重置实施方案](2026-11-07-metawork-target-architecture-contract-reset-implementation-plan.md)

## 1. 结论

1. **可以在不改上游包的前提下承载 Manager 与一个 Executor 路径。** 上游 1.5.0 提供了成熟的
   extension API（`pi.registerTool()`、`pi.registerCommand()`、`ctx.ui`、provider/MCP 注册、
   生命周期事件、自定义渲染）以及 `./rpc-entry` 导出，因此本仓 fork 里的 MetaWork 适配层
   应改为"平台扩展 + MetaWork 宿主桥"，而不是继续维护私有 fork。
2. **打包版本按产品决策取打包机上的 `pi`**（本机实测 `1.5.0`），版本与 integrity 必须写入
   release manifest，缺失即构建失败（D6/R12）。
3. **唯一真实风险是 0.80.2 → 1.5.0 的扩展 API/工具面差异**，逐项列在 §3，必须在 P2-B
   之前用可执行 spike 验证（§4）。

## 2. 两棵树的实测事实

| 事实 | vendored fork | 上游 1.5.0（本机安装） |
| --- | --- | --- |
| 包名/版本 | `@earendil-works/pi-coding-agent` 0.80.2 | 同包名，`1.5.0` |
| 子包 | agent / ai / coding-agent / tui | pi-agent-core / pi-ai / pi-codemode / pi-coding-agent / pi-mcp / pi-schema / pi-telemetry / pi-tui |
| `bin` | `anyfusion-planner` → `dist/cli.js` | `pi` → `dist/bundle/cli.js` |
| `exports` | 仅 `.` | `.` 与 `./rpc-entry` |
| 扩展 API | 私有补丁（`src/anyfusion/*` 直接进核心） | `docs/extensions.md`：custom tools、commands、`ctx.ui`、provider/MCP 注册、生命周期事件、自定义渲染 |
| MCP | fork 内自建 `planner-mcp-extension.ts` | 独立 `pi-mcp` 包 + `docs/mcp.md` |
| 运行引擎 | 未声明 | `engines.node >= 22.19.0`，`overrides.protobufjs 7.6.6` |
| 安装布局 | 仓库内源码 | `~/.pi/agent/install/releases/<version>` + `managed-install.json`（`releases-v1`），`pi --version` = 1.5.0 |
| 配置目录 | 自定义 | `piConfig.configDir = ".pi"` |

## 3. 差异清单与迁移动作

`planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/*` 的 18 个模块按下表处置。判定口径：
**能由上游扩展 API 表达 → 平台扩展**；**属于 MetaWork 宿主职责 → 移到 MetaWork 侧**；
**只服务已退役界面 → 删除**。

| fork 模块 | 职责 | 上游 1.5.0 承载方式 | 动作 |
| --- | --- | --- | --- |
| `planner-proposal-tool.ts` | Manager 产出结构化提案的工具 | `pi.registerTool()` 自定义工具 | 改为平台扩展 |
| `planner-proposal-types.ts` / `planner-proposal-gate.ts` | 提案结构与门禁 | 扩展内 schema 校验 + MetaWork 侧 validator（保留单一校验入口） | 扩展 + 宿主校验 |
| `planner-mcp-extension.ts` | MetaWork 工具面 MCP | `pi-mcp` + 扩展注册 MCP server | 改为平台扩展 |
| `planner-system-prompt.ts` | Manager 系统提示 | 扩展生命周期注入（需 spike 验证可注入点与优先级） | 改为平台扩展 |
| `planner-web-tools.ts` | 联网检索工具 | 上游工具面/`pi-codemode`（**待验证**是否等价） | spike 验证后决定扩展或保留专用 adapter |
| `planner-policy.ts` / `permission-review.ts` | 权限判定与人工复核 | 不属 Pi：交由 PermissionService/Manager（ADR-0055 §6.3） | 移到 MetaWork |
| `planner-host-client.ts` / `gateway-client.ts` / `gateway-socket-transport.ts` / `gateway-observation-client.ts` / `conversation-observation-protocol.ts` / `gateway-protocol.ts` | 与 MetaWork Server 的 socket/RPC/观测协议 | 不属 Pi：MetaWork `src/tui-bridge` + gateway 已拥有协议 | 移到 MetaWork |
| `executor-result-message.ts` / `metaclaw-command-autocomplete.ts` / `executor-registration-wizard.ts` | 结果消息渲染、命令补全、注册向导 | 扩展 `registerCommand()` / 自定义渲染 / `ctx.ui` | 改为平台扩展 |
| `planner-bootstrap.ts` | 启动装配 | MetaWork 宿主 + 扩展入口 | 移到 MetaWork |
| `modes/metawork-tui/*` | 唯一 MetaWork TUI | 退役（P5-C 删除） | 删除 |
| `modes/rpc/rpc-mode.ts` | Planner RPC 服务 | 上游 `./rpc-entry` | 改用上游入口，协议字段按 §5 断言 |

## 4. P2-B 之前必须跑通的 spike（验收条件）

全部在隔离进程内执行，且**不读取用户 `~/.pi`**：

1. 以打包的 `pi` 启动一个 RPC 进程：独立 `HOME`、`PI_CODING_AGENT_DIR`、session 根；断言
   未读取用户配置、扩展、session、auth。
2. 一次真实规划回合：扩展注册的 Manager 提案工具被调用，输出通过 MetaWork 现有
   planning schema（v9/Work Graph v7）校验；非法输出被拒绝。
3. RPC 契约：protocol version、request id、超时、取消、消息大小上限、结构化错误、异常退出；
   断言 stop/kill 后无残留进程（沿用 `process-group-reaper`）。
4. 完整 usage 回调：每个模型调用产生 `ModelUsageFact`（`providerId/modelId/inputTokens/
   outputTokens/occurredAt/usageSource`），缺失时按 D4 记 `provider_unavailable`。
5. 工具面：扩展注册的工具全部可调用；不给 Pi 任何 PATH 上的用户全局 `pi`。
6. 版本/完整性：release manifest 记录 `pi.version` 与包 integrity；构建机无 `pi` 时构建失败。

## 5. 已知风险与处置

| 风险 | 处置 |
| --- | --- |
| 0.80.2 的私有补丁在 1.5.0 无对应扩展点（尤其系统提示注入与工具面） | spike 第 2/5 项先验证；无法承载时按技术方案 §5.1 记入"明确阻塞"，不得在 MetaWork 内再建 fork 绕行 |
| 上游升级改变扩展 API | release manifest 固定版本；升级视为独立批次，需重跑全部 spike 断言 |
| 用户全局 `pi` 污染 | 打包副本 + 独立 HOME/config/session + 不调用 PATH；spike 第 1 项为回归断言 |
| `./rpc-entry` 协议与现有 Planner RPC 不一致 | spike 第 3 项产出差异表；MetaWork 侧适配，不改上游 |

## 6. 证据命令

```text
pi --version                                  # 1.5.0（打包机）
node -e "require('./planner/AnyFusion-Pi/packages/coding-agent/package.json')"   # 0.80.2
ls ~/.pi/agent/install/releases/1.5.0         # releases-v1 安装布局
ls ~/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works
cat ~/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/package.json
sed -n '1,40p' ~/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md
```

## 7. P2-B1 关闭记录（打包期 Pi 版本固定）

- 变更：`scripts/lib/pi-runtime-pin.mjs`（探针：版本、managed 布局、release `package.json`、
  lockfile 哈希、Node engine 校验）、`scripts/build-release.mjs`（构建即校验，缺 Pi/版本不符/
  Node 过旧直接失败，并把 pin 写入 `<out-dir>/pi-runtime-pin.json`）、
  `tests/installation/pi-runtime-pin.test.ts`（5 项，含真实宿主 Pi 断言）。
- 回滚点：上述三个文件之前的提交。
- 证据：
  ```text
  npx vitest run tests/installation/pi-runtime-pin.test.ts        # 5 passed
  node -e "import('./scripts/lib/pi-runtime-pin.mjs').then(m=>console.log(m.assertPiRuntimePin({command:'pi'})))"
  # { version: '1.5.0', packageVersion: '1.5.0', nodeEngine: '>=22.19.0', lockSha256: 'd3d2…' }
  npx tsc --noEmit                                                 # 通过
  ```
- 说明：`PI_MANAGED_INSTALL_ROOT` 只作为回退；实际执行的 launcher 位置优先（否则会读到
  另一个 release），该行为由单测覆盖。
- 未做：把 `pi` 段写进签名 manifest —— 属于 P2-B4（真正打包 Pi 归档时），当前 manifest
  仍只有 vendored planner。
