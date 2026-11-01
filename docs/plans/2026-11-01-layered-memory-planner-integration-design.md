# L1/L2/L3 记忆接入 Planner 技术方案

**Status:** Proposed；仅完成设计，尚未实施
**Plan date:** 2026-11-01
**Scope:** 将 TDAI L1 原子记忆、L2 场景记忆和 L3 用户画像接入 MetaWork Planner，并让被计划引用的记忆通过现有执行证据通道到达 Executor。
**Related authority:** [ADR-0015](../adr/0015-planner-owned-semantics-and-tool-mediated-context.md)、[ADR-0020](../adr/0020-core-module-ownership-and-dependency-direction.md)、[ADR-0021](../adr/0021-work-graph-v4-subtask-execution-contract.md)、[ADR-0038](../adr/0038-planner-executor-context-continuity.md)、[ADR-0049](../adr/0049-long-term-memory-ownership-deposition-and-delivery.md)。
**Supersedes:** 本文仅补充 ADR-0049 的分层召回与交付设计，不改变当前已接受实现契约。实施前必须更新 ADR-0049 及适用的 schema / ContextRef 契约。

## 1. 问题与目标

MetaWork 当前完成 L0 对话沉淀，TDAI 负责生产 L1/L2/L3；但规划前召回实际只调用 `/v3/atomic/search`，Planner 只收到 L1 候选。L2 场景和 L3 Persona 虽已生成和存储，却未进入 MetaWork 的规划链路。

本文确定以下目标：

1. L1 继续为当前请求提供相关原子记忆。
2. L2 按请求提供少量相关场景经验，而不是全量注入场景目录或正文。
3. L3 提供短小的稳定用户默认偏好，帮助 Planner 制定计划。
4. Planner 明确选择需要影响执行的记忆；Runtime 对引用做账号、启用状态和版本校验。
5. 被引用的正文继续只通过 `task_execution_evidence(kind='long_term_memory')` 到达 Executor。
6. 任一层为空或不可用都不能阻塞普通规划；状态必须区分“没有匹配记忆”和“该层读取失败”。

## 2. 当前实现事实与明确缺口

当前记忆流为：

```text
完成的对话 Turn → TDAI L0 → TDAI 抽取 L1/L2/L3
                               ↓
MetaWork refreshRecall → /v3/atomic/search → memory_recall_candidates
                               ↓
Planner search_memory → L1 ContextRef → Runtime 物化为执行证据
```

具体限制：

- `MemoryRuntime.refreshRecall()` 只调用 `MemoryService.search()`，后者只查 L1。
- `TdaiMemoryAdapter.readPersona()` 已存在，但随包 TDAI Gateway 的 `/v3/core/read` 当前返回 `{content:null, updated_at:null}`。
- 随包 Gateway 没有 MetaWork 专用的 L2 场景搜索/读取接口。
- TDAI 原生 `/recall` 返回合成上下文文本，不提供每项资产可复核的层级、稳定 ID 和 revision，不能承担 MetaWork 的 Planner 召回契约。
- `memory_bindings` 当前只表达 L1 原子资产；`memory_recall_candidates` 只存 L1 候选。
- `ContextRef{kind:'memory', memoryId}` 无版本；执行证据物化按 L1 原子 ID 查询。

TDAI 已有数据可复用：L2 的 `scene_blocks/*.md` 和 `.metadata/scene_index.json`；L3 的 `persona.md`，其中可能包含附加的 Scene Navigation，Persona 正文必须先剥除该导航段。

## 3. 目标架构与职责

```text
用户请求
  ↓
Server MemoryRuntime：并行准备 L1 搜索、L2 场景候选、L3 Persona 快照
  ↓
账号数据库中的有界分层 Recall Context
  ↓ MCP 只读
Planner：查看分层候选；把适用偏好写入子任务；为执行所需正文添加 memory ref
  ↓ 已验证 Work Graph
Runtime：复核 account / enabled / revision，按层读取引用正文
  ↓
task_execution_evidence(kind='long_term_memory') → selectedEvidence → Executor
```

职责边界：

- **TDAI**：继续拥有抽取、L1/L2/L3 内容与搜索能力；MetaWork 不自建第二套抽取或语义排序。
- **Memory Port / Adapter**：唯一跨进程访问边界，定义分层查询和物化契约，封装 TDAI 专用 HTTP API。
- **MemoryRuntime / MemoryService**：执行规划前读取、账号隔离、候选数量和文本预算、降级状态更新。
- **Recall Repo**：持久化 Planner 可读的有界预览与资产引用元数据，不持久化记忆正文。
- **Planner**：判断哪些候选对本任务适用，并决定是否把记忆引用关联到具体 Subtask。
- **Runtime**：验证计划引用、读取固定版本正文、写入已有执行证据库。
- **Executor**：只得到其 Subtask 明确引用且已验证的正文证据；不连接 TDAI。

## 4. TDAI 兼容 API

继续使用随 MetaWork 发布的 TDAI Gateway。新增两个 MetaWork 专用接口，并修复现有 Persona 兼容接口。它们均使用现有 v3 envelope、Bearer gate、`x-tdai-service-id`、账号 scope triple 和统一错误处理。

### 4.1 L2 场景候选

新增 `POST /v3/metawork/scenario/search`。

请求：

```json
{
  "query": "制作汇报 PPT",
  "limit": 3,
  "team_id": "...",
  "agent_id": "...",
  "user_id": "..."
}
```

处理规则：

1. 读取 TDAI 已维护的 `scene_index.json`，不得为每次规划重新扫描所有场景正文。
2. 对 `filename`、`summary` 做确定性的 Unicode 不区分大小写词项匹配；按命中词数降序、`heat` 降序、`updated` 降序、稳定场景 ID 升序排列。
3. 返回最多 `limit` 个项目，服务端硬上限为 5。初版不调用 LLM，不引入新的 embedding 或排序服务。
4. 一个场景 ID 由 scope triple 与规范化 filename 通过 SHA-256 派生，格式 `tdai:l2:<hex>`。响应同时包含 filename、summary、score、updatedAt、revision、preview；preview 是摘要，不是场景正文。
5. 空 query 返回空候选，不返回整个场景目录。

### 4.2 L2 场景读取

新增 `POST /v3/metawork/scenario/read`，按 scene ID 读取单个场景。Gateway 必须从当前已加载的索引重新解析 ID 到 filename；不得接受客户端路径，不得允许绝对路径、路径分隔符、`..` 或索引外文件。读取后按统一解析器拆分 META 与正文，并返回稳定 ID、摘要、正文、更新时间和正文 SHA-256 revision。索引中已不存在的资产返回明确 404。

### 4.3 L3 Persona 读取

实现现有 `POST /v3/core/read`：

1. 读取 TDAI 数据目录的 `persona.md`。
2. 使用现有 `stripSceneNavigation()` 去掉自动生成的场景导航，只返回 Persona 正文。
3. Persona 为空或文件不存在时返回 `content:null`；读取失败返回错误，不能伪装成空 Persona。
4. 返回稳定 ID `tdai:l3:persona`（该 ID 经 scope triple 作用域化）、`updated_at`、正文 `revision`（SHA-256）和正文。
5. 返回内容不超过 TDAI Persona 已有 2,000 字符生成上限；超限视为引擎数据异常并截断到 2,000 字符，同时 revision 对截断后的实际返回正文计算。

### 4.4 L1 读取接口补充

保留 `/v3/atomic/search` 召回。L1 物化继续使用当前有界分页查询，但 Adapter 必须将读到的资产 ID、正文 revision 与计划中的 revision 对照。不得因内容变化而静默交付不同版本。

## 5. Memory Port 与统一类型

将候选统一为分层类型：

```ts
type MemoryLayer = 'l1' | 'l2' | 'l3';

interface MemoryRecallItem {
  memoryId: string;        // MetaWork 本地稳定引用 ID
  layer: MemoryLayer;
  title: string;
  preview: string;         // 有界 Planner 预览
  revision: string;        // 返回正文的 SHA-256
  score: number;           // L3 固定为 1；L1/L2 使用引擎/确定性分数
  updatedAt: string | null;
  source: 'conversation' | 'sanitized' | 'profile';
}

interface MemoryRef {
  memoryId: string;
  revision: string;
}
```

Memory Port 增加：

```ts
searchScenarios({ query, limit }, scope)
readPersona(scope)
readScenario(memoryId, scope)
materialize(ref: MemoryRef, scope)
```

L1 搜索结果也必须提供 `revision`。L2/L3 API 的 `revision` 与物化正文的摘要规则完全一致。适配器仍负责 envelope、超时、重试和错误归一；不负责候选选择策略。

每层召回有独立结果状态：`available`、`empty`、`degraded`。一次召回中某一层失败不清除其他成功层。Planner 工具返回各层状态及有限候选；工具级总状态只有在所有层都不可用时才是 degraded。

## 6. MetaWork 存储与迁移

实施时提升数据库 schema 版本（实施 PR 选择当时最新版本的下一个整数，本文不预占可能已被其他改动使用的版本号），以可重入迁移完成：

### 6.1 `memory_bindings`

新增字段：

- `layer TEXT NOT NULL DEFAULT 'l1' CHECK(layer IN ('l1','l2','l3'))`
- `tdai_revision TEXT`：最近一次已见的正文 revision。
- `tdai_title TEXT`：管理面名称/场景名；不存正文。

`tdai_memory_id` 全局唯一约束改为 `UNIQUE(account_id, layer, tdai_memory_id)`，因为相同引擎资源 ID 不得跨账号冲突，且 L1/L2/L3 命名空间显式分开。迁移原有行设为 `layer='l1'`，其余字段保留。`memory_id` 本地 UUID 不变，以维持现有 Work Graph 引用。

绑定 upsert 必须保留既有 `enabled=false` 用户决定；任何层的刷新、重新召回和 revision 更新都不能重新启用资产。Persona 使用稳定 TDAI ID，因此同一账号始终映射到同一个本地 memory ID；更新内容只更新 revision。

### 6.2 `memory_recall_candidates`

候选表新增 `layer`、`revision`、`title`、`source` 字段；各层状态单独存入 `memory_recall_layers`，避免在每个候选行重复存同一状态：

```sql
CREATE TABLE memory_recall_layers (
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  layer TEXT NOT NULL CHECK(layer IN ('l1','l2','l3')),
  status TEXT NOT NULL CHECK(status IN ('available','empty','degraded')),
  reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id, conversation_id, layer)
);
```

候选表新增 `layer TEXT NOT NULL DEFAULT 'l1'`、`revision TEXT NOT NULL DEFAULT ''`、`title TEXT NOT NULL DEFAULT ''`、`source TEXT NOT NULL DEFAULT 'conversation'`，主键 `(account_id, conversation_id, memory_id)` 仍足够，因为 MetaWork 本地 `memory_id` 全局唯一。现有行迁移为 L1，旧 Planner 读取兼容到迁移完成。

每次刷新以事务替换该会话三层候选和三层状态，避免 Planner 读到跨轮混合候选；各层查询并发执行，单层失败只记录该层 degraded 并保留其余成功层。

## 7. 规划前召回与预算

替换单一 `refreshRecall()` 为 `refreshPlanningMemoryContext()`，由现有规划前调用点传入当前用户请求及账号/Conversation/Workspace 元数据。

每轮默认预算：

| 层级 | 候选数 | 单项预览上限 | 总预览上限 |
|---|---:|---:|---:|
| L1 | 5 | 240 字符 | 1,200 字符 |
| L2 | 3 | 320 字符 | 960 字符 |
| L3 | 1 | 1,200 字符 | 1,200 字符 |
| 合计 | 9 | — | 3,360 字符 |

通用硬上限 4,000 字符（按 Unicode code point 截断）。这些是 Planner 初始候选预算，不改变 ADR-0021 Executor 证据预算。候选按各层规则排序，不跨层比较分数。已停用绑定不得投影给 Planner。

L3 每轮读一次，作为画像候选。读取成功但正文为空时记 `empty`。L2 搜索没有命中时记 `empty`。调用超时、Gateway 错误、结构非法时记 `degraded`。Recall 不应在 Server 内做 LLM 摘要或第二次语义重排。

## 8. Planner MCP 与 Work Graph 契约

增加 `get_memory_context` MCP 工具，输入可带可选 query（默认当前请求）和分层 limit；输出：

```json
{
  "layers": {
    "l1": { "status": "available", "items": [] },
    "l2": { "status": "empty", "items": [] },
    "l3": { "status": "available", "items": [] }
  },
  "advice": "..."
}
```

每个 item 返回 `memoryId`、`layer`、`title`、`preview`、`revision`、`updatedAt`。`search_memory` 作为兼容工具继续工作，但只呈现 L1，并在 Planner skill 与工具说明迁移完成后标为 deprecated；不得让它悄悄返回混合层级结果。

扩展 `ContextRef{kind:'memory'}` 为 `{kind:'memory', memoryId, revision}`。新 Planner proposal 必须提供 revision；旧持久化图中缺少 revision 的历史引用保留既有读取规则，仅允许已授权旧任务按旧规则恢复，不得在新图中接受无版本引用。引用资格检查要求该 memory ID/revision 出现在本 Conversation 当前召回快照，且绑定属于当前 account 并启用。禁止 Planner 猜测或引用 `list_memory_assets` 中未进入本轮候选快照的资产。

Planner 的使用规则：

1. L3 是规划默认画像。适用偏好应具体写进 Subtask `goal` 或 acceptance，例如“中文、面向管理者、页面简洁”。当前用户请求与 Persona 冲突时以当前请求为准。
2. L1/L2 的预览用于判断相关性。若 Executor 执行确实需要记忆正文中的事实、流程或约束，Subtask `contextRefs` 引用对应 memory ID 和 revision。
3. Planner 可以参考 L2/L3 后仅将其转化成明确任务要求，不必为了“留痕”强制把正文送给 Executor。若要求需要来源审计，可在 ContextRef 中引用来源记忆。
4. 不相关记忆不得添加到子任务引用；每个子任务仍受现有 contextRefs 数量与证据预算限制。

## 9. Runtime 资格校验与证据物化

扩展 `MemoryEvidenceService.materialize()` 接收 `{memoryId, revision}` 引用。逐项执行：

1. 由 account-scoped `memory_bindings` 找到本地绑定，验证 enabled。
2. 验证该引用及 revision 属于该 Task 已验证 Work Graph 中的候选快照。资格校验和执行物化都做校验，不能只依赖 Planner MCP。
3. 根据 binding.layer 调用对应 Adapter materializer：L1 原子读取、L2 场景读取、L3 Persona 读取。
4. 计算实际返回正文 SHA-256 并与引用 revision 比较。若变更则返回 `memory_revision_changed`；不静默发送新版，不以空内容替代。
5. 将固定版本正文写入 `task_execution_evidence`，`kind='long_term_memory'`、source ID 含 layer 与 TDAI resource ID；标题带层级和资产名，正文不写入 `memory_bindings` 或 Recall Repo。
6. `SubtaskExecutionContext` 仍从证据表构造 `selectedEvidence`，预算、证据分页工具和 `executor_evidence_accessed` 审计保持不变。

若 revision 变化发生在计划授权后、执行前，当前 Attempt 不得启动并带错误返回现有 continuation/replan 边界，要求 Planner 基于新快照重建引用。不得把普通版本变化升级成用户确认请求。

## 10. 用户治理与设置页

现有记忆资产管理扩展为分层资产：

- 列表返回 `layer` 和 `title`，可按 L1/L2/L3 筛选；完整正文详情仍直接从 MemoryService/Port 拉取，不进本地 Recall Repo。
- L1 维持原子更新/删除接口。
- L2 停用通过本地 binding 开关生效；删除必须调用 TDAI profile 删除操作成功后再删除 binding。
- L3 是单个账号级 Persona；停用是 binding 级治理，暂停 Persona 参与召回和执行物化，不影响 TDAI 后续继续生成其内容。删除需通过受控 profile 删除 API，删除后后续 TDAI 可能重新生成，产品界面明确表达“删除当前画像”。
- 更新/重新绑定不得改变用户的 enabled 状态。

TDAI profile API 如果当前并未提供稳定的单项删除操作，则本期明确实现对应 Gateway 专用删除接口，并将删除落到 TDAI 原有 profile store；不得用仅删除 MetaWork binding 的方式冒充删除。

## 11. 错误、超时和降级

- 每层规划前读取使用独立 2 秒超时；L1 保留现有召回超时，L2/L3 不重试慢请求超过此总预算。
- 单层失败：该层 `degraded`，其他层仍可用；Planner 明确知道状态，照常基于当前请求规划。
- 空候选：`empty`，不得写成 degraded。
- 执行时引用正文不可读取、账号不符、资产停用、revision 不符：引用明确失败并走既有 Runtime continuation/replan；不能静默跳过被计划声明的证据。
- 所有 API 错误日志只记录层级、操作、稳定错误码、耗时和 request id，不记录记忆正文或凭证。
- 禁止模型生成或网络请求出现在每轮读取路径；TDAI 后台原有 L2/L3 抽取成本保持原样。

## 12. 实施顺序

1. **TDAI Gateway**：实现 persona 读取、scene 搜索/读取、scene 删除接口及接口测试；确认真实 TDAI 存储读写版本与 scope。
2. **Memory Port/Adapter**：增加分层类型、查询和固定版本物化，覆盖错误归一与预算。
3. **MetaWork schema/repositories**：迁移 bindings 与 Recall read model；测试保留停用状态、跨账号隔离、分层 ID 唯一性和事务替换。
4. **Planner 前置读取/MCP**：接入三层并发召回、`get_memory_context`、工具文档和 Planner skill 规则。
5. **ContextRef/Runtime**：增加 revision schema、快照资格校验、分层证据物化和变更后 replan。
6. **管理面**：分层列表、详情、启停、删除与版本更新状态。
7. **文档与 ADR**：更新 ADR-0049、CONTEXT 与当前技术总览，补实施记录、完成日期、验证和 closing commit。

实施期间按 ADR-0020 保持模块所有权：TDAI 文件/API 在 vendored `memory/tdai`；防腐协议在 `src/memory`；持久化在 `src/storage`；MCP 在 `src/planning`；ContextRef/执行证据在 `src/work-graph` 与 `src/execution`；无跨所有权直连。

## 13. 验收标准

### 功能

1. 规划前读取记录能分别显示 L1/L2/L3 状态、耗时和候选数，不记录正文。
2. 有 Persona“默认中文、汇报简洁”时，制作 PPT 任务的 Planner 工具能看到 L3，并把适用要求转成子任务目标；当前用户指定英文时，计划使用英文。
3. 存在与“制作调研汇报”匹配的 L2 场景时返回候选及稳定 ID/revision；不匹配时返回 empty。
4. Planner 引用 L2 后，Executor 收到对应场景正文作为 `long_term_memory` selectedEvidence；未引用的 L2/L3 不进入 Executor。
5. L1 现有检索、引用与证据链路保持可用，并改为 revision 固定语义。

### 治理与健壮性

1. 账号 A 的 L2/L3 ID 和正文不能从账号 B 读取。
2. 用户停用 L2/L3 后，后续 Planner 候选中没有该项，伪造引用也在资格校验和 Runtime 物化处失败。
3. 同一资产刷新后保持同一个本地 memory ID 和 enabled 值；revision 变化可见。
4. 计划与执行之间正文变化会被识别，不会把新正文作为旧版本交给 Executor。
5. L2 超时而 L1/L3 成功时，Planner 仍收到 L1/L3 和明确的 L2 degraded 状态；任务可正常执行。
6. L2 文件名解析无法越出 `scene_blocks`；特殊字符和路径穿越输入不能访问文件系统外内容。
7. MetaWork 数据库不保存 L2/L3 正文；正文只存在 TDAI 和按任务物化的执行证据中。

### 验证

- TDAI：Gateway API 单元测试，真实 SQLite sidecar 的 profile/scene round-trip 集成测试。
- MetaWork：Memory Port Adapter、runtime recall、存储迁移、Planner MCP、ContextRef eligibility、证据物化和 management 测试。
- 端到端：真实 sidecar 覆盖 L1/L2/L3 召回、Planner 引用、Executor evidence、停用、账号隔离、revision 变化及单层降级。
- 回归：全量 lint/build；Docker 中运行 SQLite 与 POSIX 路径相关测试；memory e2e 必须使用真实随包 TDAI sidecar。

## 14. 风险与边界

- 初版 L2 搜索依赖场景 filename/summary 的确定性词项匹配，语义表达差异会降低召回率。通过真实任务样本统计 L2 命中和 Planner 引用率，再决定是否增加场景摘要 FTS；不在首版引入另一个 LLM 选择器。
- L3 Persona 是 TDAI 当前的合成画像，不是逐条偏好记录。Planner 应把采用的偏好转为明确任务要求，不能让 Executor 把整份画像当成任意指令集合。
- L2/L3 版本可在规划期间更新。固定 revision 会导致少量引用失效并触发重规划，这是保证 Planner 看见内容与 Executor 收到内容一致所需的行为。
- 原 ADR-0049 描述“仅索引 L1”与当前行为一致。实施本方案前必须明确修订该决策，避免实现和现行 ADR 冲突。
