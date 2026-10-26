# MetaWork 记忆系统接入 TencentDB Agent Memory 设计方案

**Status:** 已实施（Accepted / Implemented），2026-10-22

**Plan date:** 2026-10-22

**Completion date:** 2026-10-22

**Scope:** MetaWork 记忆体系现状审计、TencentDB Agent Memory（以下简称 TDAI）接入形态、记忆生产与沉淀契约、召回与证据投递、管理面与开关、凭证与生命周期、ADR 影响与分阶段实施。

**Related authority:** ADR-0015（修订）、ADR-0020（微调）、ADR-0021（保持不变）、ADR-0031、ADR-0033、ADR-0042、ADR-0045、ADR-0047，以及本方案新拟 [ADR-0049](../adr/0049-long-term-memory-ownership-deposition-and-delivery.md)。

**外部依赖：** [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)（MIT，Tencent）。本方案只使用其 MemoryCore 的 L0/L1/L2/L3 数据面与 `/v3/meta/*` 元数据面；不引入 MemoryProxy、MemoryPanel、MemoryKnowledge。

---

## 1. 目标与非目标

### 1.1 目标

1. 让 MetaWork 具备**真正可用**的长期记忆：跨会话的经验、偏好与做法能被沉淀、被召回、被用户看见与关闭。
2. 以 TDAI 作为**唯一记忆引擎**（生产 + 检索），不保留两套记忆实现。
3. 保留 MetaWork 已有的**上下文契约**：Planner 选、MetaWork 验、Executor 用；记忆进入 Executor 只走证据通道。
4. 记忆是**可选能力**：设置里一个开关；关闭时零进程、零请求、零成本。
5. 抽取所需模型**复用用户已配置的 Provider**，不新增供应商、不新增固定业务 prompt。

### 1.2 非目标

1. 不做自然语言即时记忆捕获（"记住这句"当场变偏好）——ADR-0015 已废止该 fast path。
2. 不把 TDAI 的 LLM 代理（MemoryProxy）接入 Planner/Executor 链路，不改模型流量路径。
3. 不引入 TDAI 面板（MemoryPanel）与知识服务（MemoryKnowledge），管理面由 MetaWork 自建薄视图。
4. 不引入第二个语义路由器；MetaWork 不做语义选择，不做记忆排序。
5. 不把 Task 作为记忆的一等粒度（见 §5.2）。
6. 不做抽取模型的自动推荐或自动降级；模型由用户显式选择（见 §7.3）。
7. 不引入 TDAI Skill 资产（见附录 B）。

---

## 2. 现状审计

审计结论：**MetaWork 的记忆体系是"骨架齐全、管道未接电"**。存储层、治理层、审计层都在，但生产链路上三根线断开，因此重度用户完全感知不到记忆存在。

### 2.1 触发点审计表

| 部件 | 设计触发点 | 实际状态 | 证据 |
|---|---|---|---|
| `preferences` 写入 | `/memory add` | 仅 CLI 可写；TUI/Web/Desktop 中该指令被当普通消息转发给 Planner | `src/session/conversation-session.ts:1382-1403`（Gateway slash 白名单只有 `/task dashboard\|show\|list` 与 `/status`） |
| `preferences` → Planner | `get_planning_context` 返回 `confirmedPreferences` | 通道通，但表通常为空；是否调用由模型自决 | `src/planning/planner-mcp-server.ts:287-313`；`planner/AnyFusion-Pi/.../metaclaw-planner/SKILL.md:39` |
| `preferences` → Executor（自动） | 按 `task.injectedPreferences` / `preference.sourceTasks` 注入 | **死代码**：前者只在 `src/task/task-engine.ts:85` 初始化为 `[]` 且无写入点；后者在 `addManual` 写死 `[]` 且 `recordUsage` 不更新 | `src/execution/subtask-execution-context.ts:274-285` |
| `preferences` → Executor（显式） | Planner 在 proposal 中写 `contextRefs:[{kind:'preference'}]` | 可行但要求 Planner 恰好引用某条偏好 | `src/execution/subtask-execution-context.ts:470-476` |
| `task_memory_cards` | 任务完成 → reflection → candidate → 人工 promote | 不自动：`reflectOnTaskCompletion` 生产代码零调用；落库仅在 `/learning promote` 手动命令 | `src/learning/reflection-engine.ts:23`；`src/commands/learning-commands.ts:286-300` |
| `learning_candidates` | 任务完成自动产生 | 不自动；`reflectOnSkillUsage` 仅在 `/learning` 命令中被调用 | `src/commands/learning-commands.ts:138` |
| `learning_candidate` → `preferences` | promote 写入偏好 | **该分支不存在**：`promote` 只处理 `task_memory_card` 与 `skill*` | `src/commands/learning-commands.ts:286-300` |
| `context-recaller`（确定性历史召回） | 规划初始上下文 | **未被调用**（103 行死代码） | `src/memory/context-recaller.ts` |
| `MemoryContextService.preparePlanningInitialContext` | 规划初始上下文 | **未被调用**；该类实际只被用于 `normalizeInlineResourcesFromInput` | `src/memory/memory-context-service.ts`；`src/session/session-kernel-runtime.ts:386` |
| `preference_usage` | 记录记忆使用审计 | **只写不读**，无任何 reader | `src/storage/preference-repo.ts:114` |
| `safety-scanner` | 候选内容安全过滤 | 仅被 `reflection-engine` 调用（因上游死链而失效） | `src/learning/safety-scanner.ts` |
| `memory vault` 导出 | `/memory vault export` | CLI 可用 | `src/commands/memory-commands.ts:128` |

### 2.2 三个断点

```
断点① 采集：任务/会话结束后，没有任何自动环节把经历写入记忆。
断点② 晋级：learning_candidate → preferences 的通道不存在；审核入口只有 CLI。
断点③ 送达：即使有 confirmed 偏好，Executor 侧自动注入是死代码；
          只有 Planner 恰好显式引用才会送达。
```

### 2.3 同时确认：会话连贯性不依赖记忆系统

同一会话内的连续追问由三个更专门的机制承担，**记忆系统不参与**：

| 层 | 机制 | 证据 |
|---|---|---|
| 主力 | Pi 持久化会话（原生对话历史 + compaction） | `plannerSessionId = conversationId`（`src/server/server-composition.ts:1377,1434`）；`planner/AnyFusion-Pi/packages/coding-agent/src/core/compaction/` |
| 事实桥 | Context Bridge `get_current_session_context`（投影 interactions / Kernel 决策 / Executor 结果 / Artifact 元数据） | `src/planning/planner-mcp-server.ts:108-140`；ADR-0038 明确它不做排序、不做指代消解、不做检索 |
| 精确引用 | `ContextRef{kind:'interaction'}` → 物化为证据 | `src/execution/subtask-execution-context.ts:485-495`；`src/work-graph/context-ref-eligibility.ts:117-134` |

**推论**：TDAI 补的是**跨会话的连续性**，不是同会话的连续性。同会话内引入 TDAI 只会造成重复与噪声。

### 2.4 能力边界（必须诚实）

| 用户想要的东西 | TDAI 能否提供 | 归属 |
|---|---|---|
| 上次处理类似问题时的做法/坑 | ✅ 能（L1/L2/L3） | TDAI |
| 跨会话的用户偏好与习惯 | ✅ 能（L1 偏好 + L3 画像） | TDAI |
| "上次那个报告文件"这类**对象引用** | ❌ 不能 | Artifact + `ContextRef{kind:'artifact'}` + 任务历史（账号/会话范围） |

**记忆提供背景，不提供引用。**

---

## 3. 决策摘要

| # | 决策 | 理由 |
|---|---|---|
| D1 | 引入 TDAI MemoryCore 作为**唯一记忆引擎**；MetaWork 不再自研抽取与检索 | 现有实现是死管道；TDAI 提供成熟的分层抽取与 BM25/向量/RRF 召回 |
| D2 | **换脑不换契约**：保留 `ContextRef` 与 `task_execution_evidence` 通道，退役其余记忆实现 | 这两个是 ADR-0021 管辖的活契约；ADR-0021 因此完全不用改 |
| D3 | 记忆隔离域是**账号**：TDAI `team_id = account_id`（一人团队），`user_id = account_id`，`agent_id` 使用**账号级统一记忆代理标识**（不按 AgentClass 拆分） | 用户可拥有多个工作区与多个智能体，经验应当服务“理解用户意图”，而非服务角色边界；TDAI 的 team+agent 隔离键要求同一账号共用同一 agent 标识才能实现全角色共享 |
| D4 | 管理面为 **MetaWork 薄视图**（Web 设置内），不部署 TDAI Panel | Panel 是无状态控制台且要求二次登录与 Docker/Node 构建；MetaWork 已有账号、权限与登录 |
| D5 | 记忆是**设置开关**：`memory.enabled=false` 时无 sidecar、无请求、无成本、无索引 | 明确的产品边界 |
| D6 | 抽取模型**由用户从已有 Provider 中显式选择**；系统只做硬约束校验，不自动推荐、不自动降级、不代填 | TDAI 只支持 OpenAI chat completions；选择权与额度透明度归用户 |
| D7 | 不使用 `InternalLlmService` 承载抽取；改为向 sidecar 注入 `TDAI_LLM_*` | 官方 AI 是"固定 operation + 固定 prompt + 固定 JSON schema"模型，与 TDAI 的可版本化 prompt 家族结构性不兼容 |
| D8 | **记忆沉淀**（批量写入 L0）：会话空闲 ≥ 阈值后，把自上次沉淀后的全部 turn 一次性写入 | 整段对话才能抽出指代明确的偏好；逐轮写会产出碎片 |
| D9 | L0 session = **Conversation**；写入单位 = **Turn**；**不引入 Task 粒度** | Task 是执行域概念，会随取消/重试/归档抖动；Turn/Conversation 是稳定的用户心智单位 |
| D10 | 记忆进入 Executor **只经证据通道**（新增 `kind='long_term_memory'`），禁止 prompt 注入式 push | 保持 ADR-0038 的 pull 三段式与 ADR-0021 的预算/审计 |
| D11 | 保留 `safety-scanner`，但改造为**沉淀前净化器**（脱敏 + 拒绝入库），退役逐条人工审核流 | 记忆会让敏感内容长期留存并被注入未来任务，风险放大；但逐条审核过重 |
| D12 | TDAI 交互**只在 `src/memory/` 拥有的 Memory Port 之后**；方向单一（MetaWork → TDAI） | 防腐层；TDAI 从不回调，挂了只影响召回 |
| D13 | 沉淀**只包含 `status='completed'` 的 turn**；失败、取消、阻塞的轮次一律不沉淀 | 不把失败过程固化成长期经验，避免误导后续任务 |
| D14 | 共享边界 = **账号**（唯一）；工作区、智能体角色、会话都不是边界 | 记忆的目的在于让系统更好地理解用户并从经验中提取价值；智能体只是分工不同，不应各自为政 |

---

## 4. 目标架构

```text
┌─ TDAI MemoryCore（唯一记忆引擎，Node 进程，127.0.0.1:8420）────────────┐
│  L0 对话 / L1 原子 / L2 场景 / L3 画像 / Skill                        │
│  抽取（用户所选 Provider 的模型）+ BM25 召回 + /v3/meta/* 资产元数据    │
└────▲──────────────────────┬─────────────────────────────────────────┘
     │ ①沉淀（批量写 L0）      │ ②召回（L1/L3）③资产元数据
┌────┴──────────────────────▼─────────────────────────────────────────┐
─ MetaWork                                                        ─┐
│  src/memory/                                                        │
│    ├─ MemoryPort（接口）                                             │
│    ├─ TdaiMemoryAdapter（HTTP 防腐层，约 200 行）                     │
│    ├─ MemoryService（沉淀编排 + 净化 + 降级）                        │
│    ├─ MemoryFlushScheduler（后台 tick + 空闲/兜底判定）              │
│    └─ MemoryBindingsRepo（memory_bindings 表：归属 + 开关 + 索引）    │
│  src/planning/  Planner MCP：search_memory / list_memory_assets      │
│  src/execution/ resolveEvidenceRef 新增 kind='memory' 分支            │
│  Web 设置：记忆开关 + 抽取模型选择 + 记忆资产视图                     │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.1 保留 / 退役 / 新增

**保留（契约与骨架）**

```
✓ task_execution_evidence 通道（新增 kind='long_term_memory'）
✓ ContextRef 契约（新增 kind='memory'；preference 保留为兼容别名）
✓ ADR-0021 的 4k/24k 预算、截断标记、executor_evidence_accessed 审计
✓ safety-scanner（改造为沉淀前净化器）
✓ revisioned configuration（新增 memory 段）+ 设置面板
✓ Provider / Model 目录与凭证体系
```

**退役**

```
✗ preferences / preference_usage 表 + preference-repo + memory-engine
✗ memory-vault-exporter（可由新的记忆导出替代）
✗ learning_candidates 表 + learning-candidate-repo + promotion-gate
✗ reflection-engine + learning-weekly-review-builder
✗ context-recaller + memory-context-service 的未使用部分
✗ task.injectedPreferences 失效路径
✗ /memory 与 /learning 的记忆子命令（由设置页与薄视图替代）
```

**新增**

```
+ memory_bindings 表
+ TdaiMemoryAdapter（防腐层）
+ MemoryService / MemoryFlushScheduler / MemoryBindingsRepo
+ 设置：记忆开关、抽取模型选择、记忆资产视图
+ 记忆沉淀前的净化器（复用 safety-scanner 规则）
```

### 4.2 `memory_bindings`（唯一的本地记忆索引）

```sql
CREATE TABLE memory_bindings (
  memory_id       TEXT PRIMARY KEY,   -- 本地稳定 ID，供 ContextRef 引用
  tdai_memory_id  TEXT NOT NULL,      -- TDAI 侧 ID
  account_id      TEXT NOT NULL,      -- 账号归属：唯一隔离边界（ADR-0031）
  workspace_id    TEXT,               -- 来源工作区：仅作来源展示，不是边界
  source          TEXT,               -- 来源类型：conversation
  enabled         INTEGER NOT NULL DEFAULT 1,   -- 用户开关
  confidence      REAL,
  content_digest  TEXT,               -- 摘要/指纹，不存正文
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_memory_bindings_account ON memory_bindings(account_id, enabled);
CREATE UNIQUE INDEX idx_memory_bindings_tdai ON memory_bindings(tdai_memory_id);
```

**不存正文**：正文在 TDAI；本地只存归属、开关与索引。这样 TDAI 侧整体可丢弃、可重建，MetaWork 权威库不承载记忆内容。

### 4.3 共享边界

**账号是唯一边界。** 工作区、智能体角色、会话都不是边界：

| 维度 | 是否构成边界 | 说明 |
|---|---|---|
| **账号** | ✅ 是 | 记忆归属域。跨账号永不共享（ADR-0031） |
| 工作区 | ❌ 否 | 同一账号的多个工作区共享记忆；`workspace_id` 只作来源展示 |
| 智能体角色 | ❌ 否 | 同一账号的所有 AgentClass 共享记忆；记忆服务于“理解用户”，不服务于角色分工 |
| 会话 | ❌ 否 | 会话是沉淀单元，不是共享边界 |

实现上，跨工作区与跨角色共享由 TDAI 的 team + agent 隔离**天然实现**：同一账号的记忆全部落在同一个 TDAI team、且共用同一个 agent 标识下，召回按该作用域过滤，因此 MetaWork 侧不需要做跨作用域检索或结果合并。

**代价**：一个工作区沉淀的偏好会影响该账号的其他工作区与智能体。这是目标行为，不是缺陷。记忆只存对话中提炼的偏好与做法，不存文件正文与产物内容。

---

## 5. 记忆沉淀契约（L0 摄取）

### 5.1 三个时刻

| 时刻 | 责任方 | 动作 | 状态 |
|---|---|---|---|
| ① Turn 结束 | MetaWork 现有逻辑 | 写 `conversation_read_turns` | 已有 |
| ② **记忆沉淀** | 新增 | 批量写 TDAI L0 | 新增 |
| ③ 抽取（L0→L1/L2/L3） | TDAI 内部 | TDAI 自带 pipeline | 外部能力 |

**回答过程中不沉淀**：此时 `finalAnswer` 未定稿、产物可能未发布、且 MetaWork 存在"先接受请求、后台继续执行"的模式（`src/gateway/background-result-delivery.ts`），中途写入会得到半成品。

### 5.2 沉淀契约

| 项 | 决定 | 说明 |
|---|---|---|
| 触发 | 会话空闲 ≥ 阈值（默认 10 分钟） | 空闲 = 该会话最近无新增 turn |
| 兜底 | 未沉淀 turn ≥ 20 轮；距上次沉淀 ≥ 2 小时；对话归档；Server 关闭 | 防止长会话永不沉淀 |
| 写入单位 | Turn（`userInput` + `finalAnswer`） | 数据源：`conversation_read_turns` |
| 写入批次 | 一次写入"自上次沉淀后的全部 turns"，≤ 100 条/批 | TDAI `/v3/conversation/add` 的 `messages` 上限为 100 |
| L0 session | `session_id = conversationId` | 一个会话一个 L0 session；L2 场景不被切碎 |
| 幂等 | per-conversation 的 `last_sequence` 游标；**写入成功后才推进** | TDAI 侧 L0 无幂等键，顺序必须守住 |
| 游标存储 | `conversation_history_streams` 增 `kind='memory'` 一行，或独立极简表 | 该表 PK 含 `kind`，可零 schema 变更扩展 |
| 过滤 | **只沉淀 `status='completed'` 的 turn** | 失败、取消、阻塞的轮次一律不沉淀（D13）；第一期如此 |
| 净化 | 沉淀前过 `safety-scanner`：密钥类脱敏后写入，命中危险命令标记来源 | 见 §8 |
| 失败处理 | fire-and-forget；失败只记日志，游标不推进，下个 tick 重试 | 绝不影响会话与执行 |
| **Task 依赖** | **无** | 不引入 Task 粒度，不改 `ConversationTurn` |

### 5.3 为什么必须成批沉淀

逐轮写入会让 TDAI 的 `l1IdleTimeoutSeconds`（默认 600s，本方案建议 30s）在用户每次停顿时触发抽取，此时抽取只看到孤立的一轮：

```text
Q1: 帮我看下这份销售数据        A1: 好的，数据概览是……
Q2: 那把华东区单独拆出来        A2: （"华东区"在 A1 中根本没出现）
```

逐轮写 → 抽出"用户关注华东区"这类指代不明或语义漂移的事实；成批写 → TDAI 能识别"华东区"是用户引入的限定条件，抽出"用户做销售分析时会按大区拆分"——这才是有价值的记忆。

同理，用户说"以后都用中文表格"几乎总是夹在具体对话中间；只有整段一起看，才抽得出这是**用户偏好**而不是**本次任务要求**。这是 L1 质量的分水岭。

### 5.4 与 TDAI 内部触发的配合

TDAI 侧配置（`tdai-gateway.standalone.yaml` 的 `memory.pipeline`）需与本契约配合：

| 配置项 | 默认 | 建议 | 理由 |
|---|---|---|---|
| `everyNConversations` | 5 | 1 | MetaWork 已按段批量写入，不应再等轮数 |
| `enableWarmup` | true | false | 指数退避对"成段沉淀"是反效果 |
| `l1IdleTimeoutSeconds` | 600 | 30 | 写完后 30s 内完成抽取 |
| `l2DelayAfterL1Seconds` | 90 | 90 | L2 场景延迟 |
| `l2MinIntervalSeconds` | 900 | 900 | L2 最密 15 分钟一次 |
| `persona.triggerEveryN` | 50 | 50 | L3 低频 |
| `embedding.provider` | none | none | 纯 BM25，零额外 embedding 成本 |
| `bm25.language` | zh | zh | 中文分词 |

> **FTS5 前置校验**：`GET /health` 的 `stores.ftsAvailable` 必须为真。FTS5 缺失时 BM25 **静默返回空**，召回会无声失效。这是上线前的阻断性检查项。

---

## 6. 交互层次与协议

### 6.1 四个接缝

| # | 接缝 | 消费者 | TDAI 接口 | 时机 | 同步性 | 失败行为 |
|---|---|---|---|---|---|---|
| S1 | 沉淀（写 L0） | MetaWork Server | `POST /v3/conversation/add` | 会话空闲后 | 异步 fire-and-forget | 丢弃 + 记日志，不影响任何主链路 |
| S2 | 召回候选 | Planner MCP 工具 | `POST /v3/atomic/search`（+ `/v3/core/read` 取 L3） | Planner 主动调用 | 同步 ≤ 2s | 返回空 + `degraded` 标记，Planner 照常规划 |
| S3 | 正文物化 | 执行上下文构建（host 侧） | `POST /v3/atomic/get` | Planner 引用 memory ref、Runtime 物化证据时 | 同步 ≤ 3s | 该证据**不可用并明确报错**，绝不塞空内容冒充证据 |
| S4 | 资产治理 | Web 设置 ← Gateway | `/v3/meta/*`、`/v3/atomic/update|delete` | 用户操作 | 同步 | 页面显示错误 |

**全部收敛在 `src/memory/` 的一个 Memory Port 之后。** 换后端、换协议、超时/重试/降级策略只动这一处。

### 6.2 明确不做的交互

| 不做 | 原因 |
|---|---|
| Planner 进程直连 TDAI | ADR-0015 的 tool-mediated 原则；Planner 进程树继承 Server 的 `process.env`（`src/utils/env-file.ts:21-26`、`src/planning/planner-process-supervisor.ts:1002,1014`），凭证下放会扩大泄漏面 |
| Executor 容器访问 TDAI | 容器是 `--network=none` 或仅内部控制网络（`src/execution/docker-cli-attempt-execution-backend.ts:81,127`），物理上不可达 |
| MemoryProxy 接入 | 会改模型流量路径，撞 ADR-0033/0047 与计费；其 push 注入与 ADR-0038 冲突；且只覆盖 Pi 一条后端腿 |
| MemoryPanel 部署 | 需二次登录与额外部署；管理面改为薄视图 |
| MCP 连 TDAI | TDAI 无 MCP server 端；MCP 只用于 MetaWork 内部（Planner ↔ MetaWork） |

### 6.3 协议选型

- **HTTP + JSON**，v3 RPC 风格，统一信封 `{code, message, request_id, data}`。
- **不引入** `@tencentdb-agent-memory/memory-sdk-ts-v2`（1.0.1-beta.1）：它直接暴露 v3 路径与 data-shape，TDAI 契约变化会直接波及 MetaWork；且其错误模型不统一（meta 层 `"{error_code}: {detail}"`、skill 层 5 位数字 code、数据面纯文本，见 TDAI v3 文档 §1.6），`atomic/update` 与 `atomic/query` 的 `version` 类型还不一致（文档已标 ⚠️）。
- **自写约 200 行 `TdaiMemoryAdapter`**：fetch + 信封解析 + 超时 + 错误归一 + 重试，作为防腐层。
- **方向单一**：TDAI 从不回调 MetaWork。

### 6.4 凭证拓扑

| 凭证 | 存放 | 下发 |
|---|---|---|
| `KERNEL_AUTH_TOKEN`（Bearer 闸门） | SecretStore | **仅**注入 sidecar 启动 env；**绝不放进 Server `process.env`**（会被 Planner 继承） |
| `x-tdai-service-id` | 配置 | 同上，随 sidecar env |
| `x-tdai-user-key`（账号级，只读） | SecretStore + 账号映射 | 按需读取，不落 env，不进入前端；可吊销 |
| 抽取模型凭证 | 既有 `ProviderDefinition.apiKeyRef` → SecretStore | 仅注入 sidecar env |
| Executor 容器 | — | **零凭证、零网络** |

### 6.5 作用域标识

TDAI v3 数据面**强制 team + agent + user 三元组隔离**（缺省回落 `default` 桶），因此 MetaWork 必须为每个账号提供**固定的一组作用域标识**，并在所有写入与召回中使用同一组：

| 标识 | MetaWork 取值 | 说明 |
|---|---|---|
| `team_id` | 账号级记忆团队 | 一个账号一个 team；不按工作区拆分 |
| `agent_id` | 账号级统一记忆代理 | **所有 AgentClass 共用**；按角色拆分会导致跨角色不共享 |
| `user_id` | 账号 | |

**待 Phase 0 验证**：数据面接口是否接受**未在 meta 层注册**的 `team_id` / `agent_id` 字符串。若接受，则无需注册与持久化作用域；若不接受（部分接口返回 403），则需在首次使用时经 `/v3/meta/*` 为账号创建 team 与 agent，并持久化其 ID（一张 3 列小表即可）。

### 6.6 八条交互契约

1. **端口唯一**：跨进程记忆访问只经 Memory Port，禁止任何模块直连 TDAI。
2. **方向单一**：MetaWork 是唯一客户端；TDAI 不回调。
3. **进程边界**：Executor 容器零凭证零网络；记忆正文只在 host 侧物化。
4. **凭证纪律**：外部服务凭证只经 SecretStore 按需读取，禁止进入 Server `process.env`。
5. **pull 语义**：记忆进入 Executor 只经 `task_execution_evidence`；禁止 prompt 注入式 push。
6. **降级契约**：TDAI 不可用时召回为空且带 `degraded` 标记，任务链路不失败。
7. **权限纪律**：用户级 user key 只读、账号范围；不进入前端；可吊销。
8. **单向写入**：MetaWork 只写 L0；L1/L2/L3 由 TDAI 生成，MetaWork 只索引。

---

## 7. 记忆开关与 Provider 配置

### 7.1 配置形态

放入既有 **revisioned configuration**（`AnyFusionConfigurationV2` 新增 `memory` 段），走既有严格空闲期设置事务（ADR-0027/0033），**不新造配置系统**：

```ts
memory?: {
  enabled: boolean;
  providerRef: string;   // 必须 protocol==='openai-compatible' 且 enabled
  modelRef: string;      // 必须属于该 provider
  retrieval: { maxResults: number; maxChars: number };
  sidecar: { port: number; dataDir: string; autoStart: boolean };
}
```

### 7.2 三态

| 状态 | 行为 |
|---|---|
| `enabled: false` | 无 sidecar、无请求、无 LLM 成本、无记忆索引 |
| `enabled: true`，未选 provider/model | 设置页提示"需选择抽取模型"；不启动抽取 |
| `enabled: true`，已选 | 全功能 |

### 7.3 Provider 选择器的三条硬约束

| 约束 | 依据 | UI 行为 |
|---|---|---|
| 协议必须 `openai-compatible` | `ProviderProtocol = 'openai-compatible' \| 'openai-responses' \| 'anthropic'`（`src/configuration/types.ts:11`）；TDAI 只支持 `{baseUrl}/chat/completions` | 只列出 `openai-compatible` 且 `enabled` 的 provider；其他标注"不支持记忆抽取" |
| 模型需结构化输出能力 | `ModelProfile.capabilities` 含 `'structured-output'`（`src/configuration/types.ts:31`）；TDAI 的 L1/L2/L3 均要求结构化 JSON 输出 | 标注该能力；**不做自动推荐**，由用户显式选择 |
| 额度归属透明 | 抽取消耗用户 Provider 额度 | 设置项旁明示"记忆抽取将使用该 Provider 的额度"，并展示该模型价格 |

**选择方式**：完全由用户显式选择（provider + model）。系统**不自动推荐、不自动降级、不代填**；用户切换模型后立即生效，下一次沉淀使用新模型。

### 7.4 与官方 AI 的关系

`InternalLlmService` 的生产路径是官方 AI，其 operation 是硬编码三元组（`src/authorization/types.ts:81`、`src/configuration/internal-llm-service.ts:9-27`），prompt 与输出 schema 固定在 `official-server/prompts.js`。TDAI 需要自己的 prompt 家族（L1/L2/L3 × chat/code）且可版本化、可按 Agent/Team/Instance 覆盖（`/v3/memory-prompt/*`），二者**结构性不兼容**。因此抽取走**用户所选 Provider**，不复用官方 AI。

---

## 8. 安全与净化

### 8.1 为什么净化不能省

`src/learning/safety-scanner.ts` 现拦三类：密钥（`sk-xxx`、`api_key=…`）、危险命令（`rm -rf /`、`chmod 777`、`curl … | sh`），并已能返回 `redactedContent`。

在记忆场景下风险被放大：用户随口贴出的 API key 或命令若被抽成长期记忆，就会**长期留存并被注入未来任务**。

### 8.2 改造后的净化契约

| 阶段 | 动作 |
|---|---|
| 沉淀前（写入 TDAI 之前） | 密钥类**脱敏**后写入 → TDAI 侧也干净 |
| 索引时 | 仍含密钥的候选**不落** `memory_bindings` → 不可能被召回 |
| 危险命令类 | 允许入库，但标记 `source='sanitized'` |
| 跨账号 | 永不跨：`memory_bindings.account_id` 强制过滤 |
| 跨工作区 / 跨智能体 | 允许（账号内共享，D14）；仅在索引上保留来源工作区供展示 |

### 8.3 退役"逐条人工审核"

D3 决定治理采用团队模型，MetaWork 不再维护候选审核队列。相应退役 `learning_candidates` 表、`promotion-gate`、`reflection-engine` 与 `/learning` 记忆子命令。**用户否决权由 TDAI 团队资产的可见性 + `memory_bindings.enabled` 开关提供。**

---

## 9. 管理面（薄视图）

在既有 Web 设置面板内新增「记忆」分区（`web/src/components/SettingsPanel`），包含三部分：

| 视图 | 能力 | TDAI 依赖 |
|---|---|---|
| 记忆总开关 | 启用/停用 | 本地配置 |
| 抽取模型 | 从已有 Provider 中选择 | 本地配置 + SecretStore |
| 记忆资产 | 按账号列出 / 禁用 / 删除 / 查看来源工作区 | `/v3/meta/*`、`/v3/atomic/update\|delete` |

**身份与登录全部复用 MetaWork 现有体系**（ADR-0031）：Gateway 服务端持有账号级 TDAI user key 并注入请求头，前端不接触任何 TDAI 凭证。

TDAI 的团队 ACL（private/team/restricted）作为**第二层**资产级可见性叠加在 MetaWork 的账号隔离之上；**工作区不是可见性边界**（见 §4.3）。

---

## 10. 证据投递（pull 语义）

```
Planner 在 proposal 中引用 memory ref
  → Runtime 解析并复核（账号归属、enabled、预算）
  → 取回正文（TDAI /v3/atomic/get，host 侧）
  → 物化为 task_execution_evidence(kind='long_term_memory')
  → Executor 在 selectedEvidence 中收到（title/content/truncated）
  → 需要更多时用 evidence 工具按 ID 取
```

保留既有预算与审计：**单条 ≤ 4000 字符，任务总计 ≤ 24000**，超长截断并附 `[TRUNCATED: use evidence get for remaining content]`；每次证据访问写 `executor_evidence_accessed` Task 事件。

**为什么不能拼进 prompt 正文**：那会绕过 Planner 选择与 Runtime 授权复核，形成第二条无审计、无预算的上下文通道，直接违反 ADR-0038 与 ADR-0021。

**顺带修掉一个缺陷**：`src/execution/subtask-execution-context.ts:274` 的 `injected.has(preference.content)` 用 content 比对 id 集合，逻辑本身错误。

---

## 11. 生命周期与降级

| 事件 | 行为 |
|---|---|
| Server 启动（`memory.enabled=true`） | 读 SecretStore → 拉起 sidecar → `GET /health` 探活（**必须校验 `stores.ftsAvailable`**）→ 就绪后才开放 S1–S4 |
| TDAI 不可用 | S1 丢弃、S2 空结果 + degraded、S3 明确失败、S4 报错；**任务执行不受影响** |
| sidecar 崩溃 | Server 检测 → 降级模式 → 按既有 managed-Pi 修复模式做有限次串行自动重启（与 update lock 串行） |
| Server 停止 / Desktop 退出 | sidecar 随 Server 停止；纳入 Desktop 退出恢复事务（ADR-0045 的有界清理：身份不变、锁撤销、无打开文件） |
| 升级 | sidecar 版本与 MetaWork 版本解耦单独 pin |

---

## 12. ADR 影响清单

| ADR | 处置 | 原因 |
|---|---|---|
| **ADR-0015** | ⚠️ **修订**（不能只加新 ADR） | 原文 `:37` 废止自然语言记忆捕获 fast path；`:45` 明写 "Cross-session semantic search remains unavailable"——TDAI 引入的自动抽取与跨会话语义召回正好命中这两句 |
| **新 ADR** | 拟写 | 记忆归属/开关/投递模型、沉淀契约、pull 语义、凭证纪律、降级契约、sidecar 生命周期、Provider 约束 |
| ADR-0021 | ✅ **不动** | 保留 preferences 投影替代物 + evidence 通道，预算与审计不变 |
| ADR-0020 | 微调 | `src/memory/` 领域归属从"自研记忆"改为"记忆绑定、治理与投递" |
| ADR-0031 / 0047 | 对齐 | 记忆隔离域 = 账号（跨工作区共享、跨账号不共享）、记忆内容数据边界、抽取模型出口与计费归属 |
| ADR-0034 / 0045 | 对齐 | sidecar 纳入安装/升级/停止/Desktop 生命周期 |
| ADR-0042 | 复用 | 外部消费（抽取模型）单独记账口径 |

---

## 13. 实施阶段与验收指标

### Phase 0｜可行性验证（半天，不改仓库代码、不写生产库）

1. 以 Node 直接运行 TDAI MemoryCore standalone（`node --import tsx src/gateway/server.ts`，**无需 Docker**），只起 core，不起 hub、不起 proxy。
2. 只读取样例：取一个**真实多轮会话**的全部 turn，原样回灌 `/v3/conversation/add`。
3. 观察 L1/L3 抽取质量是否命中"这段对话里隐含的偏好/做法"，而非碎片或任务摘要废话。
4. 校验 `GET /health` 的 `stores.ftsAvailable` 与中文 BM25 命中。
5. 验证数据面是否接受未在 meta 层注册的 `team_id` / `agent_id`（见 §6.5），以及同一 team+agent 下跨工作区的召回是否天然成立。

**门槛**：若 L1 质量不成立或 BM25 静默失效，方案前提不成立，停止推进。

### Phase 1｜ADR（1 天，纯文档）

ADR-0015 修订草案 + 新 ADR 草案（含 §6.6 八条契约与 §5.2 沉淀契约）。

### Phase 2｜实现（2~3 周）

`TdaiMemoryAdapter` → `memory_bindings` → `kind='memory'` 的 ContextRef → 沉淀调度器 → 设置开关与 Provider 选择 → 记忆资产薄视图。

### Phase 3｜体感与治理（1~2 周）

记忆来源标注、记忆开关、导出、`/memory` 系列指令的 Gateway 白名单或设置页替代。

### 验收指标

| 指标 | 目标 | 当前状态 |
|---|---|---|
| L1 抽取可用率 | 抽出的候选中用户保留（未禁用）比例 ≥ 60% | Phase 0 实测 1/1（真实模型抽 1 条跨轮偏好，无噪声）；比例需真实账号长期观察 |
| 召回有效率 | Planner 实际引用记忆的任务占比 ≥ 15%；低于此说明记忆是噪声 | 待真实账号观察（自动化验证了链路可达，未验证体感） |
| 降级可用性 | sidecar 被杀时 Planner turn 成功率与基线差 < 1%，且任务视图出现 degraded 标记 | 已自动化验证：引擎被 SIGKILL 后召回返回空 + `degraded`，沉淀失败被吞掉，任务链路不受影响 |
| 预算合规 | 100% 注入走证据通道，单条 ≤ 4000、任务总计 ≤ 24000 | 已自动化验证：单条 ≤ 4000 含截断标记；与既有 ADR-0021 共用同一预算代码 |
| 权威层污染 | 未经过净化与归属过滤的记忆入库数 = 0 | 已自动化验证：`memory_bindings` 无正文字段；跨账号/已停用资产在资格校验与物化两处均被拒绝 |
| 凭据卫生 | Server `process.env` 中不含任何 TDAI 凭证；Executor 容器内无 TDAI 凭证与网络 | 已自动化验证：引擎凭证只进 sidecar env 与 SecretStore；Planner/planning 目录无引擎导入；Executor 零改动 |
| 沉淀时效 | 会话沉淀到 L1 抽取完成 ≤ 2 分钟 | 已实测：mock 模型 1 秒内完成；真实模型 Phase 0 约 6 秒完成 L1 |
| 重建成本 | 从 MetaWork 重建记忆索引 < 10 分钟（对 10k turns） | 未验证（引擎侧能力，不在本期范围） |

---

## 14. 风险与开放问题

| # | 风险 | 缓解 |
|---|---|---|
| R1 | TDAI v3 契约仍在演进（beta SDK、错误码三型不统一、`version` 类型不一致） | 自写防腐层；不使用其 SDK；契约变更被挡在一处 |
| R2 | FTS5 缺失导致召回**静默失效** | 上线阻断性检查 `stores.ftsAvailable`；健康检查纳入探活 |
| R3 | 抽取质量不确定 | Phase 0 门槛；不达标即停 |
| R4 | 外部服务成为 Planner 召回的依赖 | 降级契约 + sidecar 独立生命周期 + 不进入模型流量路径 |
| R5 | 记忆内容外送第三方部署 | TDAI 本机 sidecar，数据不出机器；抽取模型走用户自选 Provider；记忆正文不落 MetaWork 权威库 |
| R6 | 中文分词与 BM25 效果 | `bm25.language: zh` + jieba；Phase 0 实测；必要时开 embedding（成本另计） |
| R7 | sidecar 引入新的进程生命周期面 | 纳入 ADR-0034/0045 的安装/升级/停止事务与有界清理 |
| R8 | 退役 `preferences` 影响既有 Planner 行为 | `ContextRef` 的 `preference` kind 保留为兼容别名，过渡期后再评估清理 |
| R9 | 用户体感仍弱（记忆不可见） | 薄视图与开关是 Phase 3 必交付项，不因技术链路完成而顺延 |
| R10 | 跨工作区与跨智能体共享使一个上下文的偏好影响账号内所有上下文 | 这是目标行为；记忆只存对话中提炼的偏好与做法，不存文件正文与产物内容；记忆资产视图显示来源并可禁用 |
| R11 | 账号即作用域意味着每个账号需一组固定的 team + agent 标识 | 若数据面接受未注册标识则无需注册；否则首次使用时经 `/v3/meta/*` 创建并持久化（见 §6.5） |

**已关闭的开放问题（2026-10-22 决策）**

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 抽取模型的默认选择策略 | **用户自己选择配置模型**；系统只做协议与能力硬约束校验，不做自动推荐（D6、§7.3） |
| Q2 | 记忆资产是否允许跨工作区共享 | **允许**；隔离域改为账号，`team_id = account_id`，工作区只作来源标签（D3、§4.3） |
| Q3 | 失败/取消任务的对话是否沉淀 | **不沉淀**；只沉淀 `status='completed'` 的 turn（D13、§5.2） |
| Q4 | TDAI Skill 资产是否纳入 | **不纳入**；本方案范围只含 L0/L1/L2/L3 与 `/v3/meta/*`（附录 B） |

---

## 附录 A｜关键代码证据索引

**记忆现状**

| 结论 | 位置 |
|---|---|
| 偏好读取（Planner 侧） | `src/planning/planner-mcp-server.ts:287-313` |
| 会话事实桥 | `src/planning/planner-mcp-server.ts:108-140` |
| 偏好 ContextRef 资格校验 | `src/work-graph/context-ref-eligibility.ts:87-93` |
| Executor 自动注入死路径 + content/id 比对缺陷 | `src/execution/subtask-execution-context.ts:274-285` |
| 偏好/交互证据物化 | `src/execution/subtask-execution-context.ts:470-476, 485-495` |
| 证据渲染进 prompt | `src/executor/prompt-builder.ts:127-133` |
| 证据访问审计事件 | `src/execution/execution-evidence-port.ts:237` |
| ContextRef 联合类型 | `src/work-graph/types.ts:24` |
| Planner proposal 的 zod schema | `src/planning/planning-agent-plan-schema.ts:82` |
| Gateway slash 白名单 | `src/session/conversation-session.ts:1382-1403` |
| 任务完成落点 `completeTask` | `src/execution/kernel-execution-runtime.ts:3821-3950` |
| Kernel `complete_task` 决策 | `src/kernel/control-kernel.ts:1183`（action 类型 `:723`） |
| `plannerSessionId = conversationId` | `src/server/server-composition.ts:1377, 1434` |
| turn 记录带 taskId | `src/gateway/background-result-delivery.ts:46-57` |
| turn→task 查询已存在 | `src/storage/conversation-read-model-repo.ts:174-177` |
| turn 历史表 / 流游标 | `src/storage/migrations.ts:126` / `:121` |
| Provider 协议与定义 | `src/configuration/types.ts:11, 13-22, 56-75` |
| 官方 AI operation 三元组 | `src/authorization/types.ts:81`、`src/configuration/internal-llm-service.ts:9-27` |
| 固定业务 prompt | `official-server/prompts.js` |
| Planner env 继承 Server process.env | `src/utils/env-file.ts:21-26`、`src/planning/planner-process-supervisor.ts:1002, 1014` |
| Executor 容器无外网 | `src/execution/docker-cli-attempt-execution-backend.ts:81, 127` |
| 后台 tick 现有模式 | `src/server/server-composition.ts:1698` |

**TDAI 侧**

| 结论 | 位置 |
|---|---|
| v3 接口总览与鉴权分层、错误码三型 | `MemoryCore/v3-api-memorycore-doc.md`（§1.4、§1.6） |
| L0 写入契约（session_id + messages ≤ 100） | 同上 §3.1 `/v3/conversation/add` |
| pipeline 默认配置 | `MemoryCore/tdai-gateway.standalone.yaml` |
| L1/L2/L3 注入与召回实现 | `MemoryCore/src/core/hooks/auto-recall.ts`、`auto-capture.ts` |
| 触发与 warmup 逻辑 | `MemoryCore/src/utils/pipeline-manager.ts` |
| 存储引擎（node:sqlite + sqlite-vec） | `MemoryCore/src/core/store/sqlite/memory-store.ts` |
| Panel 为无状态控制台 | `MemoryPanel/README.md` |
| Pi 适配器（push 模型示例） | `MemoryProxy/src/agent-adapters/pi.ts` |
| 官方 Pi 扩展（push 模型示例） | `MemoryCore/pi-plugin/` |

---

## 附录 B｜TDAI 能力与限制备忘

**可用**：`/v3/conversation/*`（L0）、`/v3/atomic/*`（L1）、`/v3/scenario/*`（L2）、`/v3/core/*`（L3）、`/v3/skill/*`（17 个）、`/v3/meta/*`（55 个）、`/v3/memory-prompt/*`（7 个）、`/v3/knowledge/*`（5 个）；TS/Python SDK；MemoryCore 可纯 Node 进程运行；存储后端 SQLite（默认）/ MongoDB（试验）/ 腾讯云 VDB。

**限制**：默认关闭远程 Embedding（纯 BM25）；BM25 依赖 SQLite FTS5，缺失时静默返回空；抽取需要 OpenAI 兼容 LLM；prompt 家族固定为 chat/code 且按 Agent/Team/Instance 可覆盖；错误码三型并存且 `version` 类型不一致；Skill 资产另有独立模块。

**不采用**：MemoryProxy（模型代理与 push 注入）、MemoryPanel（第二套管理台）、MemoryKnowledge（Wiki/CodeGraph，独立立项评估）。

---

## 实施记录（2026-10-22）

### Phase 0｜可行性验证：通过

真实多轮会话回灌 `/v3/conversation/add`，使用用户已配置的 openai-compatible Provider（`deepseek-chat`）作为抽取模型：

- `GET /health` 的 `stores.ftsAvailable = true` → BM25 前置校验通过（R2 关闭）。
- 数据面接受未在 meta 层注册的 `team_id` / `agent_id` / `user_id`（写入、计数、检索均返回 200）→ **R11 关闭**，无需注册与持久化作用域。
- 成批沉淀的抽取质量达标：8 条消息的整段会话只抽出 1 条 L1 原子
  `{"type":"instruction","content":"用户要求 AI 以后都用中文表格输出，因为要直接贴到周报里。"}`，
  背景为 `我在帮用户分析销售数据并拆分区域指标`。
  “华东区”“退货率”等一次性任务细节**未被**抽成记忆，正是设计 §5.3 期望的“宁缺毋滥”。
- 中文 BM25 命中：`中文表格`、`周报` 命中该原子；`华东区`、`退货率` 无命中。

门槛结论：**L1 质量成立、BM25 未静默失效，方案前提成立。**

### Phase 1｜ADR：完成

- 新增 [ADR-0049](../adr/0049-long-term-memory-ownership-deposition-and-delivery.md)：记忆归属/开关/投递模型、沉淀契约、pull 语义、凭证纪律、降级契约、sidecar 生命周期、Provider 约束，以及 §6.6 八条契约。
- 修订 [ADR-0015](../adr/0015-planner-owned-semantics-and-tool-mediated-context.md)：废止 “Cross-session semantic search remains unavailable”；自然语言记忆捕获 fast path 仍然废止；补写记忆不是第二语义路由器、不是第二上下文通道。
- 微调 [ADR-0020](../adr/0020-core-module-ownership-and-dependency-direction.md)：`src/memory/` 领域归属改为“记忆绑定、治理与投递”，不拥有自研抽取与检索实现。
- ADR-0021 不动：证据通道、4k/24k 预算、截断标记与审计原样适用。

### Phase 2｜实现：完成

| 交付 | 位置 |
|---|---|
| Memory Port 契约 | `src/memory/memory-port.ts`、`src/memory/memory-types.ts` |
| TDAI 防腐层（信封解析、超时、错误归一、重试） | `src/memory/tdai-memory-adapter.ts` |
| 账号作用域派生 | `src/memory/memory-scope.ts` |
| 沉淀编排 + 净化 + 降级 | `src/memory/memory-service.ts`、`src/memory/memory-sanitizer.ts` |
| 后台 tick 调度器 | `src/memory/memory-flush-scheduler.ts` |
| 证据投递 | `src/memory/memory-evidence-service.ts` |
| 本地索引 `memory_bindings` + 召回读模型 | `src/storage/memory-bindings-repo.ts`、`src/storage/memory-recall-repo.ts` |
| 沉淀游标 + Turn 数据源 | `src/storage/memory-flush-cursor-repo.ts`、`src/storage/memory-turn-source.ts` |
| 开关与抽取模型约束 | `src/configuration/types.ts`、`src/configuration/schema.ts`、`src/memory/memory-runtime-policy.ts` |
| sidecar 生命周期与 FTS5 闸门 | `src/memory/memory-sidecar.ts`、`src/memory/memory-runtime.ts`、`src/memory/memory-sidecar-config.ts` |
| `ContextRef{kind:'memory'}` 与资格校验 | `src/work-graph/types.ts`、`src/work-graph/context-ref-eligibility.ts`、`src/planning/planning-agent-plan-schema.ts` |
| Planner 工具 `search_memory` / `list_memory_assets` | `src/planning/planner-mcp-server.ts` |
| 证据物化接线 | `src/execution/subtask-execution-context.ts`、`src/execution/subtask-attempt-runner.ts` |
| 管理面 API | `src/management/memory-management.ts`、`src/management/server.ts` |
| Web 记忆分区 | `web/src/components/MemorySettingsPanel.tsx`、`web/src/api/memory.ts` |

**与设计的偏差（已记录）**

1. **S3 接口**：TDAI v3 没有 `/v3/atomic/get`（L1 原子只能按 id 更新/删除）。物化改为对 `/v3/atomic/query` 的**有界分页扫描**（最多 10 页 × 100 条），找不到即报 `memory_asset_not_found`，绝不返回空正文。偏差被完全收敛在防腐层内。
2. **Planner 侧检索通道**：设计 §6.1 让 Planner MCP 直接调 TDAI，§6.2 又禁止 Planner 进程直连（凭证继承泄漏面）。落地方案是**两侧都满足**：Server 持有适配器并把**有界预览**投影到账号库的召回读模型，Planner 通过只读 MCP 工具读取该读模型——与它读取 task/interaction/preference 的既有模式一致。引擎访问只发生在 Server 侧，Planner 进程树不持有任何引擎凭证。
3. **记忆正文存储**：`task_execution_evidence` 存完整正文（上限 8,192 字符），提示词预由既有 4k 预算截断并附 `[TRUNCATED: use evidence get for remaining content]`，使 Executor 仍可用证据工具翻页。截断标记计入预算，预览长度不再超过 4,000 字符。

### Phase 3｜体感与治理：完成

- 设置页「记忆」分区：总开关、抽取 Provider/模型选择（仅列出协议与能力满足的模型）、抽取额度提示、记忆资产列表（来源工作区、启用/停用、删除）。
- 「用户否决权」由 `memory_bindings.enabled` 承担：重新绑定不会重新启用已停用的资产。
- 沉淀前净化：密钥脱敏后写入，无法掩码的凭据整条拒收，危险命令标记 `sanitized`。

### 顺带修掉的既有缺陷

| 缺陷 | 位置 | 修复 |
|---|---|---|
| 自动注入死代码 | `src/execution/subtask-execution-context.ts` | `task.injectedPreferences` 存的是 id，却与 `preference.content` 比对，永远不匹配 |
| `recordUsage` 不写来源任务 | `src/storage/preference-repo.ts` | 补写 `sourceTasks`，自动注入路径才能再次命中 |
| 截断标记超出预算 | `src/execution/subtask-execution-context.ts` | 标记长度计入预算，预览不再超过 4,000 字符 |

### 验证记录（2026-10-22）

**门禁结果**

| 检查 | 结果 |
|---|---|
| `npm run lint`（`tsc --noEmit`） | 通过 |
| `web` 端 `tsc --noEmit` | 通过 |
| `npm run build` | 通过 |
| `npx vitest run`（全量） | **579 个文件、4005 项通过，0 失败**（19 文件 / 33 项因环境缺失跳过） |
| `npm run test:memory-e2e` | 3 个文件、15 项通过 |

**新增/扩展测试**

| 层 | 文件 |
|---|---|
| 纯域 | `tests/memory/memory-scope.test.ts`、`memory-sanitizer.test.ts`、`memory-configuration.test.ts`、`memory-runtime-policy`（含在配置测试内） |
| 防腐层 | `tests/memory/tdai-memory-adapter.test.ts` |
| 存储 | `tests/memory/memory-bindings-repo.test.ts` |
| 编排 | `tests/memory/memory-service.test.ts`、`memory-runtime.test.ts`（含 sidecar / 调度器 / 命令解析） |
| 配置生成 | `tests/memory/memory-sidecar-config.test.ts` |
| 投递 | `tests/memory/memory-evidence-service.test.ts`、`memory-context-ref-eligibility.test.ts` |
| 规划面 | `tests/planning/planner-memory-tools.test.ts` |
| 管理面 | `tests/management/memory-management.test.ts`、`tests/management/server.test.ts`（新增 6 个 HTTP 用例） |
| Web | `tests/web/config-edit.test.ts`（新增 6 个记忆段用例） |
| 架构 | `tests/memory/memory-module-boundary.test.ts`（新增 5 条边界断言） |
| 证据链路端到端 | `tests/e2e/memory-evidence-delivery.test.ts` |
| 真实引擎端到端 | `tests/e2e/memory-tdai-engine.test.ts` |
| 用户旅程端到端 | `tests/e2e/memory-user-journey.test.ts` |
| 用户视角验收 | `tests/acceptance/memory-e2e.test.ts`（10 项，全部以用户可观察结果命名） |

**真实引擎回路（不是 mock 服务）**

`tests/e2e/*` 与 `tests/acceptance/memory-e2e.test.ts` 启动真实的 TDAI MemoryCore
sidecar（`--import tsx src/gateway/server.ts`，独立临时数据目录、独立端口、
Bearer 闸门），并跑通：

```
对话 Turn 入库（只含 completed）
  → 调度器 tick 成批沉淀
  → 引擎 L0 → L1 抽取
  → BM25 召回
  → 本地绑定（不含正文，只有归属/开关/摘要）
  → Planner 只读预览
  → ContextRef 复核
  → 证据物化（kind='long_term_memory'）
  → Executor 在 selectedEvidence 收到，且不出现在 taskBackground
  → 用户停用 → 资格校验与物化双双拒绝
  → 引擎被杀 → 召回降级为空、沉淀失败被吞掉、任务链路不受影响
```

引擎 checkout 缺失时这些用例跳过而不是失败（`METAWORK_MEMORY_SIDECAR_DIR`
或其默认 `.tmp/tdai/MemoryCore`），因此没有引擎源码的机器上套件仍为绿。

**测试发现并修复的缺陷**

1. `memory_bindings.upsert` 重复绑定同一引擎资产时违反 `tdai_memory_id` 唯一索引，
   并会覆盖用户的停用决定 —— 改为复用既有本地 id 且保留 `enabled`。（记忆功能，
   本轮引入）
2. 截断标记不计入预算，导致预览超过 4,000 字符 —— 标记长度计入预算。
   （记忆功能，本轮引入）
3. **基线既有产品缺陷**：`/task resume` 这类会启动工作的控制命令，回复里
   `backgroundWorkPending` 被 `!isControlCommand(...)` 强制为 `false`，客户端因此
   不知道恢复的工作仍在继续。改为按命令是否真的把工作交给运行时判定
   （`startsBackgroundWork`），并在 `tests/session/conversation-input-mailbox.test.ts`
   补了分类回归测试。
4. **基线既有陈旧测试**：`configuration-admission-interlock` 断言 `/status` 在配置
   事务期间仍被接收，但 `/status` 从不在命令目录中（`docs/current/commands.md`
   也没有）。改为断言目录真实拥有的只读命令（`/config`、`/task dashboard`）。

---

## 评审整改（2026-10-22 第二轮）

第一轮交付后做了独立代码评审，15 项发现全部核实。逐项核实结论、根因与修复位置见
[评审整改记录](../tech-debt/memory-review-remediation.md)。

其中一项（P1-5 `x-tdai-user-key`）的事实成立但后果被高估：该 header 只在
`/v3/meta/*` 元数据面必需，而适配层只调用数据面，因此不会出现“请求全部鉴权失败”。
已按设计补齐账号级只读 user key 的 SecretStore 读取与下发，并把它重分类为 P2。

**关键修正**

- 记忆开关与抽取模型现在是可热激活的配置（`memory.*` 进入 hot path），由
  `MemoryRuntimeController` 在激活时按需重建运行中的 runtime——此前 Web 保存会收到
  409、配置根本不落库，这是本轮最严重的缺陷。
- Server 关闭与配置重建前都会先做最终沉淀（`flushAll`，必要时多批），并等待在飞的
  tick，不再丢失未达空闲阈值的会话。
- 沉淀批次改由**消息数**约束（每批 ≤ 50 Turn = 100 message），单条消息超 8192 字符
  时截断；曾经 100 Turn 批次会稳定触发引擎 400 并永久卡住该会话。
- 可沉淀判定下沉到 SQL；连续失败/取消/阻塞的 Turn 不再遮住后续 completed Turn，
  尾部不可沉淀时游标前移。
- 健康判定统一为 `interpretEngineHealth`（FTS5 且 status 健康或缺失才算可用），
  探活失败会停止已拉起的子进程而不是泄漏它。
- Planner 侧召回现在带 `degraded` 标记，并只返回用户仍启用的资产。
- sidecar 环境改为显式 allowlist，不再继承 Server 全量环境变量。

**验证**：`npm run lint`、Web `tsc --noEmit`、`npm run build` 通过；全量
`vitest run` **601 个文件、4081 项（4048 通过 / 33 跳过）、0 失败**；
`npm run test:memory-e2e` 4 个文件、20 项通过。

新增回归覆盖：评审发现 26 项
（`tests/memory/memory-review-regressions.test.ts`）、运行时生命周期 9 项
（`tests/memory/memory-runtime-controller.test.ts`），以及真实引擎上的设置激活
旅程 5 项（`tests/e2e/memory-settings-activation.test.ts`）。
