# Server 级 Memory 合并前修复方案

- 计划日期：2026-10-26
- 状态：待确认，尚未实施
- 适用分支：`IFOSR/metawork-memory-tdai`
- 目标：在不引入当前产品尚未支持的“同一 Server 多客户 Memory 隔离”前提下，完成 TDAI memory 与主干的安全合并。
- 关联设计：[TDAI memory integration design](2026-10-22-memory-system-tdai-integration-design.md)、[ADR-0031](../adr/0031-account-runtime-and-unified-client-gateway.md)、[ADR-0049](../adr/0049-long-term-memory-ownership-deposition-and-delivery.md)。

## 1. 部署前提与结论

MetaWork 当前是安装在客户自己电脑上的本地产品：

```text
一个客户安装
  └── 一个本地 Server
        ├── 本地 TUI / Web / Feishu 客户端
        └── 一个 local-default AccountRuntime
```

这个 Server 为同一客户的本机客户端提供服务，不是公有云 B/S 服务，也不是当前由多个客户共享的 Server。官方账号负责登录、订阅和授权；它不代表本地 SQLite、Workspace、Conversation 或 Memory 的跨客户共享边界。当前 ADR-0031 和 `CONTEXT.md` 已明确生产启动只激活 `local-default`，未来多账号是协议预留，不是当前部署形态。

因此，本次合并保留以下关系是正确的：

```text
Server
  └── MemoryRuntimeController
        ├── MemoryService
        ├── flush scheduler
        ├── recall read model
        ├── evidence materialization
        └── 一个本地 TDAI sidecar
```

Memory Runtime 不需要在本次合并前下沉到 `RuntimeRegistry` 的每个 AccountRuntime。`accountId` 仍然保留在数据库表、Memory Port、ContextRef eligibility 和 evidence 校验中，当前实现使用 `local-default`；它是持久化命名空间和未来扩展点，不代表当前 Server 内已经存在多个客户。

## 2. 本次合并不引入额外命令分类

memory 分支新增的 `startsBackgroundWork()` 及其命令路径不纳入本次合并：

- `/task resume`
- `/task unblock`
- `/task retry-result`
- `/task accept-result`
- `/task recovery resolve`
- `/task result retry`
- `/task result verify`

这些命令在当前主干已经经过精简处理。本次 Gateway 冲突解决时保留主干的 `isControlCommand()`、现有命令目录和 pending-work 展示语义；删除 memory 分支的 `startsBackgroundWork()` helper、命令路径常量及其专门测试。如果以后需要为某个命令增加后台工作提示，另行修改当前命令契约。

## 3. 保留 Server-owned Memory Runtime 的实施方式

### 3.1 Server composition

保留 [server-composition.ts](../../src/server/server-composition.ts) 中创建 `MemoryRuntimeController` 的位置，但按以下规则收敛：

1. controller 只创建一次，生命周期覆盖当前 Server。
2. 初始化时使用当前安装的 `accountPaths.memory`、Server 的 SQLite、SecretStore 和 `local-default` account identity。
3. `ConversationSession`、Planner MCP 和 Executor evidence 仍然通过窄 port/proxy 访问 controller，不直接访问 TDAI adapter。
4. Server shutdown 时执行一次最终 drain，再停止 scheduler 和 sidecar。
5. `accountRegistry.shutdown()` 和 memory controller shutdown 的顺序必须固定并测试，不能出现已停止 account runtime 仍向 memory 写入的情况。

当前 branch 的 `memoryEvidenceProxy` 可以保留为 Server-owned stable proxy，但每次 materialization 仍需校验 `task.accountId` 与 memory binding 的 `account_id`，不能因为 Server 只有一个本地账号就删除这层校验。

### 3.2 配置热激活

保留现有 `MemoryRuntimeController.applyConfiguration()` 机制：

```text
配置 revision 激活
  → memory section 发生变化
  → drain 当前 Server 的 pending turns
  → 停止旧 memory runtime
  → 创建新 runtime / sidecar
  → 失败时进入 degraded
```

因为当前 Server 只有一个客户，配置热激活不需要遍历多个 AccountRuntime。与 memory 无关的配置保存不应重启 sidecar；memory 关闭必须停止 sidecar、scheduler、请求和索引访问。

### 3.3 TDAI scope

当前 Server 的 TDAI scope 可以继续使用 `local-default` 派生的稳定 scope：

- `team_id` 使用当前 Server 的 account identity
- `user_id` 使用当前 Server 的 account identity
- `agent_id` 使用 Server 级统一 memory agent identity

这里的 `accountId` 是当前本地安装的稳定命名空间。不同客户安装拥有不同的 Server、数据目录和 SecretStore，不会共用 SQLite 或 sidecar data directory，因此不会跨客户共享 Memory。

默认保留一个 Server 对应一个 sidecar。没有必要为了尚未支持的同 Server 多客户场景引入多个 sidecar 实例。

## 4. 凭证与数据边界

### 4.1 固定 SecretStore reference 的重新定义

当前固定的 `MEMORY_USER_KEY_SECRET_REFERENCE` 在本地 Server 架构下可以保留，但应明确它是**安装级/Server 级 secret**，不是公共全局 secret：

- SecretStore 位于当前客户自己的安装数据目录。
- 不同客户安装不会读取同一个 SecretStore。
- sidecar 只接收当前 Server 的 user key、LLM credential 和 kernel auth token。
- Planner 进程树和 Server `process.env` 不可见这些 secret。

建议将常量重命名为 `MEMORY_INSTALLATION_USER_KEY_SECRET_REFERENCE`，降低“未来多账号 user key 已经实现”的误解。除非产品后续支持同一 Server 多本地客户，否则本次不引入 `accounts/<accountId>/memory/user-key` 层级。

### 4.2 SQLite Repository

Memory Repository 可以继续由 Server 组合根构造，但所有 SQL 仍必须保留 `account_id` 条件：

- `MemoryBindingsRepo`
- `MemoryFlushCursorRepo`
- `MemoryRecallRepo`
- `SqliteMemoryTurnSource`
- long-term memory evidence 查询

这是为了保证当前 `local-default` 数据正确，也为未来的 AccountRuntime 扩展保留安全边界。禁止新增无账号上下文的全表 memory 查询或跨账号缓存。

## 5. 本次合并前必须修复的问题

### 5.1 关闭 memory 后清理旧 recall candidates

当前 `MemoryRuntime.refreshRecall()` 在 service 不存在时直接返回，可能留下旧的 `memory_recall_candidates`。关闭 memory 后，Planner MCP 仍可能读取旧候选。

修复方式：

1. 当 runtime 为 disabled 或 needs-model 时，按 `accountId + conversationId` 清空 recall candidates。
2. 当 runtime 为 degraded 时清空候选，并写入 degraded 状态；Planner 只能看到“memory engine unavailable”，不能看到旧资产。
3. `search_memory` 和 `list_memory_assets` 在 runtime disabled/degraded 时继续做 runtime 状态门禁，不能只依赖本地 binding 表。
4. 增加关闭、重新开启、sidecar health gate 失败后的回归测试。

这是合并前必须修复的正确性问题，因为当前 Server 只有一个客户也不意味着旧候选可以继续使用。

### 5.2 degraded 管理面不能伪装成空资产

`MemoryManagementQuery.listAssets()` 当前在 service 不存在时返回空列表。对于 degraded 状态，这会把“引擎不可用”显示成“没有记忆资产”。

修复方式：

- disabled/needs-model 可以返回空资产列表，并携带当前 mode。
- degraded 应返回结构化 degraded 错误或带 `degraded: true` 的结果。
- Web 设置页显示“引擎不可用”和原因，不显示“暂无资产”。
- 添加管理 API、Web API 和组件测试。

### 5.3 保留并明确 deposition fallback

`listOverflowCandidates()` 当前只按未沉淀 completed turns 数量触发，设计还要求距离上次沉淀超过两小时的兜底条件。

修复方式：

- 使用 `memory_flush_state.updated_at` 作为最近一次成功沉淀时间；没有 cursor 时按首次待沉淀时间计算。
- overflow 条件变为：未沉淀 completed turns 达到阈值，或距上次成功沉淀超过两小时且存在 completed turns。
- 失败写入不能更新时间；成功后才推进 cursor 并更新时间。
- 增加“少于 20 轮但超过两小时”“失败重试不推进时间”“含失败/取消 turn”的测试。

### 5.4 以 memory 分支实现为准适配 `search_memory`

memory 分支已经定义了新的 TDAI 访问边界，本次合并应以该实现为准，主干没有同等功能可以覆盖它：

- Planner 不直接访问 TDAI，也不持有 TDAI credential。
- Server 在 Planner turn 前按当前 user query 调用 TDAI，并将结果写入当前 Conversation 的 bounded recall candidates。
- `search_memory` 只读取当前 Conversation 已投影、仍然 enabled 的候选，并返回可供 Planner 引用的 `memoryId`。
- Executor 仍然在 Runtime 阶段将 `ContextRef{kind:'memory'}` 物化为 evidence；memory body 不拼接进 Planner prompt。

因此，主干合并时必须把 memory 分支的 `PlannerDataReader.searchMemory()`、recall read model、degraded 状态和 `ContextRef{kind:'memory'}` 一起保留。主干侧如果有同名或相邻的旧上下文读取逻辑，只能在不破坏 Planner v9、WorkspaceIntent 和当前 Gateway 契约的前提下被替换。

工具描述要明确“搜索当前轮次的 bounded memory candidates”，不能宣称它是 TDAI 全量资产全文搜索。如果未来需要 Planner 在同一轮使用多个 query 重新搜索，应新增 Server-owned query port，由 Server 代替 MCP 发起受控 TDAI 查询；不能让 Planner 获得 TDAI credential 或直接访问 sidecar。

### 5.4.1 代码盘点基线

本节列出的旧链路首先来自当前 worktree 的 `IFOSR/metawork-memory-tdai` HEAD
`351209f9`。核对 `origin/main` HEAD `035594a2` 后，主干的共享宿主文件中也仍有同类
`MemoryEngine`、preferences 和 reflection 引用，因为 TDAI 分支尚未合入。因此合并时
不能把这份清单理解成“只修 memory 分支”：integration 分支必须同时清理两边的生产依赖，
再以当前 memory 分支的新 TDAI 行为接回主干宿主契约。

保留这些引用有明确的历史原因：当时的 [ADR-0049](../adr/0049-long-term-memory-ownership-deposition-and-delivery.md)
把旧 `preferences`、`context-recaller`、learning/reflection 和
`ContextRef{kind:'preference'}` 定义成兼容别名，所以 `351209f9` 采用了增量接入，新增
TDAI deposition/recall/evidence，同时保留旧命令和旧查询路径。它们不是 TDAI 可以复用的
实现，也不是当前设计要求的第二个引擎；它们是尚未完成退役的旧生产链路。本次用户决策
覆盖该历史兼容决定，因此实施前必须同步修订 ADR-0049、TDAI 设计文档和相关 schema/测试，
否则文档权威之间会互相矛盾。

### 5.5 彻底停用旧 MemoryEngine 链路

TDAI 是唯一自动记忆引擎。旧 `MemoryEngine`、preferences、learning/reflection 从生产组合根和正常对话路径移除，不再作为运行时能力存在：

- `server-composition`、`AccountRuntime`、`ConversationSession` 和 Planner context 不再构造或注入 `MemoryEngine`、`PreferenceRepo`、`ContextRecaller` 或旧 `MemoryContextService`。
- `preferences`、`learning_candidates`、reflection、promotion-gate 不再被自动写入、自动读取或投影给 Planner。
- `/memory`、`/learning` 记忆命令从当前命令目录和客户端联想中移除，不再触发旧存储写入。
- 正常对话的唯一沉淀路径是 `MemoryFlushScheduler → MemoryService → MemoryPort → TDAI`。
- 正常规划的唯一长期记忆路径是 `refreshRecall → memory_recall_candidates → search_memory → ContextRef{kind:'memory'}`。
- `src/memory/` 之外不得新增 TDAI 直连；TDAI 仍只能经过 Memory Port。

本次不保留历史兼容边界。旧表、旧类型和旧 ContextRef 都不再作为运行时输入：

- 从当前 schema 定义中移除 `preferences`、`preference_usage`、`reflection_events`、`learning_candidates` 及其索引、Repository 和生产查询。
- 在新 migration 中删除已经存在的上述表，并清理 `tasks.injected_prefs_json`、旧 preference evidence 和旧 preference ContextRef；清理后的历史 Task 只能按普通历史事实读取，不能再次驱动旧记忆链路。
- 删除 `MemoryEngine`、`ContextRecaller`、`MemoryContextService`、`PreferenceRepo`、旧 vault exporter 及其 active import；不保留只读恢复分支，不把旧数据转换成新的 TDAI binding。
- 删除 `/memory`、`/learning`、profile preference 命令及 completion、客户端命令联想和对应的生产测试。旧命令返回 unknown command，不得写入任何旧表或 TDAI。
- 删除 Planner `get_planning_context` 的 `confirmedPreferences` 字段和描述；删除 Executor 的 preference 自动注入以及 `ContextRef{kind:'preference'}` 物化分支。
- 删除旧 learning/reflection/promotion 自动路径及其启动、调度和存储依赖；skill governance 若仍有独立产品需求，必须迁移到单独的非记忆契约，不能继续复用这些旧表。

迁移不要求恢复旧 Memory 资产，也不把旧偏好重新投影给 Planner。对包含旧 ContextRef 的持久化 Planner payload，迁移时将其标记为不可执行并要求重新规划；运行时遇到旧引用必须 fail-closed，而不是尝试读取已删除的 preference 表。

实施顺序按以下清单执行，避免只删掉一个类而留下第二条自动链路：

1. 先从 `src/server/server-composition.ts`、`src/account/account-planner-services.ts`、`src/session/conversation-session.ts`、`src/session/metaclaw-session.ts` 移除旧对象的构造、注入和 shutdown wiring。
2. 再从 `src/planning/planner-mcp-server.ts`、`src/execution/subtask-execution-context.ts`、`src/work-graph/context-ref-eligibility.ts` 和 execution/delivery 类型中移除 `confirmedPreferences`、preference evidence、`injectedPreferences` 和 `ContextRef{kind:'preference'}`。
3. 从 `src/commands/catalog.ts`、`src/commands/command-tree.ts`、`src/commands/memory-commands.ts`、`src/commands/profile-commands.ts`、`src/commands/learning-commands.ts` 移除命令注册、completion 和旧操作；删除 `src/memory/memory-engine.ts`、`context-recaller.ts`、`memory-context-service.ts`、`memory-vault-exporter.ts` 与 `src/storage/preference-repo.ts`，并清理 learning/reflection Repository、Engine、PromotionGate 的生产引用。
4. 最后修改 `src/storage/migrations.ts` 和相关 schema/fixture 测试：fresh schema 不创建旧表，升级 migration 删除旧表和索引，并验证旧 payload 会失效而不是恢复旧 preference。

验收要求：

- 正常对话只触发 TDAI deposition。
- 生产代码没有 `MemoryEngine`、旧 `ContextRecaller`、`MemoryContextService`、`PreferenceRepo` 或 reflection 自动链路的 active import。
- `/memory`、`/learning` 和 profile preference 命令不存在，命令解析器将它们视为 unknown command，不得双写 TDAI 和旧表。
- 旧 SQLite 表在 migration 后不存在；旧数据不会被新 TDAI 流程转换或误读为 memory binding。
- 旧 `ContextRef{kind:'preference'}` 只能使历史 Planner payload 失效并触发重新规划，不能被物化为 evidence。
- 架构边界测试禁止旧 memory 依赖重新进入 Server、Planner 或 Executor 生产组合。

## 6. 合并时的权威边界

本次不是“主干整体覆盖 memory 分支”，也不是“memory 分支整体覆盖主干”。两者的权威范围要分开：

| 范围 | 权威来源 | 合并规则 |
| --- | --- | --- |
| TDAI MemoryPort、adapter、沉淀、召回、治理、sidecar、memory management | 当前 memory 分支 | 保留 memory 分支的行为和测试；主干只能提供必要的宿主接口适配 |
| `search_memory`、memory recall projection、long-term memory evidence | 当前 memory 分支 | 以 TDAI pull/evidence 契约为准，不恢复旧 preferences/context-recaller 语义 |
| Planner v9、`workspaceIntent`、Gateway、六态 Task、in-place Workspace、publication、recovery | 最新主干 | memory 接入必须适配这些契约，不能用旧分支文件覆盖 |
| schema 版本与 migration 51→58 | 最新主干 | memory 增量接到 schema 59；不保留分支的 schema 53 owner 语义 |
| Web 设置宿主、配置 revision、AccountRuntime/Server 生命周期 | 最新主干 | 手工加入 Server-owned memory controller 和 TDAI 管理面 |

共享文件必须按这张表手工移植。不能因为某个文件位于 `src/memory/` 目录就直接替换整个主干文件，也不能把主干旧的 preferences 依赖重新接回 TDAI 链路。

## 7. 主干合并冲突处理

### 7.1 schema

主干 schema 58 保持权威，memory 增量进入 schema 59：

- 保留主干 51→58 migration 链。
- memory binding、flush state、recall state 在 58→59 增加。
- fresh install 同时创建主干 schema 58 对象和 memory 对象，并写入 schema 59。
- 对当前 memory 分支 schema 53 的旧数据库增加明确识别；如果数据库缺少主干六态 Task/Workspace 事实，不得静默把 memory 分支的 53 当作主干 53。
- 58→59 migration 同时删除旧 `preferences`、`preference_usage`、`reflection_events`、`learning_candidates` 表和索引，清理旧 preference evidence/context refs；fresh database 不再创建这些表。
- 增加 schema 53、schema 58、旧 ContextRef 失效和 fresh database 的迁移测试，并断言 schema 59 不存在旧表。

### 7.2 Planner

保留主干 Planner v9、`workspaceIntent` 和主干生成脚本，只把 `ContextRef{kind:'memory'}` 合入 v9 schema、validator、eligibility 和 Planner MCP。重新生成 v9 schema fixture，不保留 memory 分支的 v8 references。

### 7.3 Execution

保留主干的六态 Task、in-place Workspace、checkpoint、publication、recovery 和当前 attempt runner。memory 只在 attempt context 构建前通过 evidence port materialize，不覆盖主干 execution 文件。

### 7.4 Gateway

Gateway 冲突使用主干当前命令语义，删除 memory 分支 `startsBackgroundWork()` helper、路径常量和对应测试改动。普通用户消息、查询、取消、配置和现有主干 control command 的 pending-work 行为以主干测试为准。

## 8. 合并与验证顺序

1. 基于当前 `351209f9` 创建临时 integration worktree。
2. 合并 `origin/main`，优先解决 migration、Planner v9、Gateway 和 fixture 冲突。
3. 保留 Server-owned `MemoryRuntimeController`，不做 AccountRuntime per-account controller 重构。
4. 以 memory 分支为准接入 `search_memory`、recall projection 和 long-term memory evidence。
5. 移除旧 MemoryEngine、preferences、learning/reflection 的生产依赖、schema 表和命令入口；旧历史引用 fail-closed 并要求重新规划。
6. 修复 disabled/degraded recall、degraded management、deposition fallback 和旧链路残留。
7. 重新生成 Planner v9 schema fixture，清理文档末尾空行。
8. 运行主干和 memory 的联合测试。
9. integration 验收通过后，再提交最终合并到主干的 PR。

必要验证：

```text
npm run lint
npm run build
npm test
npm run test:memory-e2e
git diff --check
```

重点测试：

- schema 53/58 → 59 和 fresh install
- Planner v9、`workspaceIntent`、memory ContextRef
- 主干六态 Task 与 in-place Workspace/publication/recovery
- memory disabled、needs-model、degraded、sidecar health gate
- recall candidates 清理和旧候选不可见
- 两小时 deposition fallback、cursor 幂等和 shutdown drain
- 管理 API/Web degraded 状态
- TDAI 唯一自动记忆链路

## 9. 后续扩展边界

如果未来产品真的支持同一 Server 内多个本地客户，再单独启动 account-scoped memory 设计：届时需要把 controller、sidecar、user key、MCP read model 和 shutdown 生命周期下沉到 AccountRuntime，并更新 ADR-0031、CONTEXT、当前技术总览和本方案。

在当前“一台客户机器一个 Server 一个本地客户”的产品边界下，提前引入该重构会扩大合并范围，且与现有 Server composition、local-default 数据根和部署模型不一致。
