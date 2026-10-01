# MetaWork 配置生命周期、执行可观测性与准入可靠性方案

- 方案日期：2026-10-01
- 状态：已实施（2026-10-01）
- 范围：配置画像更新、启用态校验、Planner 工作区授权、Web 执行历史、Planner/Kernel 展示、模型价格准入
- 相关契约：`CONTEXT.md`、ADR-0015、ADR-0017、ADR-0018、ADR-0021、ADR-0022、ADR-0031、ADR-0035

## 1. 目标与结论

近期发现的多个表象问题来自同一条数据链路被错误地混用了：配置草稿、已激活 revision、实时内存状态、Gateway journal、Web presentation 和 durable ExecutionProjector 各自承担的职责没有被严格区分。

本方案的目标是让系统满足以下行为：

1. 未启用的智能体即使配置不完整或能力描述有问题，也不阻碍用户使用其他已启用智能体。
2. 用户点击“更新画像”只更新当前配置草稿和内存画像；点击“保存并激活”才创建并持久化可执行 revision。草稿阶段不应因为 revision manifest 缺失而报持久化错误。
3. Planner 的工作区授权由当前 Conversation 的 Workspace 绑定决定，Release 安装不要求用户拥有源码目录，也不把 MetaWork 仓库路径写死为授权工作区。
4. Web 历史页面能够恢复完整的 Planner、Kernel、Executor Trace；Timeline 能独立显示持久化的公共路由身份。
5. Planner 和 Kernel 的 proposal、decision 等事实在阶段叙述中可见，而不是只显示 Executor 事件数量。
6. 缺少模型输入/输出价格时，启用配置不能激活或启动新执行；明确配置为 0 的价格可以形成可结算的零价格簿。
7. 任意单个 Gateway 事件都不超过 64 KiB；完整回放可以超过 64 KiB，通过分页和外部 Artifact 完成，而不是截断历史或把 JSON 从中间切开。

本方案已按阶段落地。现有工作区中的用户配置生命周期改动被保留并纳入同一条验证链路；未执行生产账户迁移或 Release 发布。

## 2. 已确认的根因

### 2.1 Web 历史只拿到了富 presentation 的一部分

`WebSessionCatalog.readPage()` 先从 canonical Conversation history 读取 Turn，再用 presentation store 对可见 Turn 做 overlay。没有 rich presentation 记录时，默认值是：

```text
traceEvents: []
executionTimeline: null
```

`WebGatewaySessionRuntime.enrichTurn()` 可以从 durable Task 和 `ExecutionProjector` 补回 `executionTimeline`，但不会从完整 journal 补回缺失的 Trace。因此会出现 Timeline 有部分内容、事件表为空、Phase Timeline 为空，或执行卡片只有 Executor 的组合状态。

相关位置：

- `src/management/web-session-catalog.ts:217-235`
- `src/management/web-gateway-session-runtime.ts:1371-1437`

这不是 Planner 或 Kernel 没有产生事实。当前 Gateway journal 中已经存在带有公共名称的 `executor_routed`、`executor_progress` 等事件，包括 `executorDisplayName`、`harnessDisplayName`、`providerDisplayName`、`modelDisplayName`。问题在于历史读取路径没有把完整事实投影到 Web。

### 2.2 Snapshot 为满足单事件上限只保留了 Trace 后缀

Gateway 单事件 payload 上限是 `MAX_GATEWAY_EVENT_PAYLOAD_BYTES = 64 * 1024`。`buildTraceSnapshot()` 将完整 Trace 合并后压缩成不超过上限的后缀；`SegmentedEventJournal.snapshot()` 返回 snapshot，而不是完整 deltas。

因此一个完整 journal 有 275 条 Trace 时，snapshot 可能只有 30 条，通常集中在 Executor 后半段。Planner 和 Kernel 的早期事件就被排除在历史 snapshot 之外。当前 `conv_9stYjSatR5aN` 已观察到：journal Trace 275 条、Web presentation Trace 30 条。

这是一种合法的传输保护，却被错误地当成完整历史数据源。Snapshot 应该是恢复指针和摘要，不应承担完整回放存储职责。

相关位置：

- `src/gateway/file-event-journal.ts:410-464`
- `src/gateway/segmented-event-journal.ts:75-79`
- `src/gateway/client-events.ts:74`

### 2.3 Timeline 没有持久化公共路由身份

`ExecutionProjector` 的 `TimelineSubtask` 当前主要包含 `id`、`title`、`status`、`executor` 和 `attempts`，没有 Harness、Provider、Model。Web 的 `collectExecutionCards()` 从 Timeline 初始化时只填充 Executor，后三项只能等待 Trace details 覆盖。

历史 Trace 不完整时，后三项自然为空。即使当前配置后来被修改，历史卡片也没有可靠的 revision-pinned 公共身份来源。

相关位置：

- `src/management/execution-projector.ts:53-66、218-224`
- `web/src/components/LiveExecutionPanel.tsx:131-151`

### 2.4 Planner/Kernel “0 steps” 是独立的叙述投影缺陷

ExecutionProjector 已有 `planning.proposal` 和 `authorization.decisions`，但 `ExecutionNarrative` 的步骤数量只计算 `events.length + progressSteps`，没有把 proposal 和 decisions 计算进去，也没有渲染这些内容。因此 Planner 和 Kernel 可能实际运行过，页面仍显示 0 steps 或空阶段。

相关位置：

- `src/management/execution-projector.ts:151-180`
- `web/src/components/ExecutionNarrative.tsx:47-71`

### 2.5 缺少价格只是警告，没有进入激活和执行准入

模型 schema 将 `costInputPerMillion` 和 `costOutputPerMillion` 定义为 optional。价格簿构建在没有价格时返回 `null`，Server 只打印“new Query bills will remain 待确认”的警告，没有阻止 revision 激活或新任务执行。

当前账单事实为 `state = pending_reconciliation`、`price_book_version = unconfigured`、`coverage = incomplete`、`amount = 0`。这表示费用未确认，不表示本次执行免费。

相关位置：

- `src/configuration/schema.ts:186-192`
- `src/billing/configured-price-book.ts:28-59`
- `src/server/server-composition.ts:706-710`

### 2.6 Planner 工作区错误是授权边界与用户当前目录混用

Planner bootstrap 要求 `cwd` 必须位于 Runtime 提供的 `authorizedWorkspace` 下。此前实现把源码目录、Server 启动目录和 Account 的 workspace-store 在不同路径之间混用，于是出现：

```text
AnyFusion Planner cwd must be inside the Runtime-authorized workspace ...
received /Users/yuanjubian/program
```

Release 安装用户没有 `/Users/.../program/metawork` 这个源码目录，因此把仓库目录作为固定授权根本不成立。授权工作区应来自 Conversation 当前绑定的 Workspace；安装目录、配置目录、Planner release 目录和用户工作区必须是四个不同概念。

### 2.7 “更新画像”错误是草稿操作触发了持久 revision 路径

用户更新能力描述后点击“更新画像”，尚未点击“保存并激活”，却出现：

```text
ENOENT: .../config/revisions/<revision-id>/revision-manifest.json
```

这说明画像更新路径读取或写入了仅在持久化 revision 创建后才存在的 manifest。语义解析失败后的兜底文案本身允许保留原文并完成能力编译，但它不应把草稿更新变成一次需要 manifest 的 revision 操作。

## 3. 设计原则

### 3.1 事实来源按用途分层

| 数据 | 权威来源 | 允许承担的职责 |
| --- | --- | --- |
| 用户当前编辑内容 | 配置草稿/内存状态 | 画像预览、局部校验 |
| 可执行配置 | immutable revision + manifest | 激活、Planner/Executor 绑定 |
| 完整执行事实 | Gateway journal / trace projection | 历史回放、审计 |
| Task/Subtask/Attempt 状态 | durable repositories + ExecutionProjector | 生命周期和 Timeline |
| 公共路由名称 | 执行时解析并随 Attempt/Timeline 持久化 | 历史展示 |
| 账单价格覆盖 | revision-pinned price book | 计费和执行准入 |

不能用当前配置重算历史身份，不能用 snapshot 代替完整 Trace，不能用 Web presentation 的缺失字段推断“没有发生”。

### 3.2 所有边界都采用 fail-closed，但只对实际启用对象生效

配置校验、模型价格和 Workspace 授权均应在真正需要执行的边界阻止不安全操作。未启用 AgentClass 的错误配置只产生设置页诊断，不参与激活门禁；启用 AgentClass 的依赖闭包必须完整。

### 3.3 大数据通过分页或 Artifact 承载

单事件上限是 framing 约束，不是整段历史的上限。任何事件必须保持完整 JSON；完整回放由稳定游标分页完成；大结果通过 Artifact 引用读取。

## 4. 目标架构

### 4.1 配置画像与激活生命周期

配置分为三个明确状态：

```text
编辑草稿（内存）
    └─ 更新画像：只更新草稿画像和诊断
         └─ 保存并激活：校验启用依赖 → 生成 revision → 写 manifest → 原子激活
```

要求：

1. “更新画像”调用纯画像编译服务，输入是当前草稿；输出包含结构化能力、原文、诊断和 `semanticExtractionAvailable`。
2. 画像编译失败可以保留原文并返回可激活与否，但不得读取不存在的 revision manifest，也不得创建半成品 revision 目录。
3. “保存并激活”才执行完整 schema、引用闭包、Harness/Provider/Model 和价格校验，并把失败定位到具体 AgentClass/Model。
4. revision 创建使用临时目录、完整 manifest 校验、fsync/rename 或现有原子发布机制；任何失败都不改变当前激活 revision。
5. 草稿刷新、切换设置页和再次打开画像不会把草稿误当成已激活配置。

### 4.2 启用态校验

先计算启用 AgentClass 的依赖闭包，再校验闭包内的 Harness、Provider、Model、能力描述和价格：

```text
enabled AgentClass
  -> selected Harness
  -> Provider credential/reference
  -> Model identity/capabilities/prices
```

禁用 AgentClass 的错误配置只显示 warning/diagnostic，不阻止其他启用 AgentClass 激活。重新启用时立即执行同一套校验。任何新任务还要使用已激活 revision 的准入快照，避免运行期间读取用户正在编辑的草稿。

### 4.3 Workspace 授权与 Planner cwd

定义以下独立路径：

- `appReleaseDir`：MetaWork/Planner 发布文件，只读；
- `configHome`：账户配置、revision、SecretStore；
- `workspaceStore`：系统管理的 Workspace 元数据或默认存储；
- `workspacePath`：用户明确绑定给当前 Conversation 的实际工作目录。

Planner 启动时由 Server 传入：

```text
authorizedWorkspace = conversation.workspacePath
cwd = plannerProcessCwd(authorizedWorkspace)
```

`cwd` 必须位于 `authorizedWorkspace` 内；Planner release 目录不能作为用户工作区。Release 安装没有源码目录时，用户可以：

1. 选择一个已有本地目录作为 Workspace；或
2. 创建 Account 默认 Workspace，由 Server 管理其路径。

如果 Conversation 尚未绑定 Workspace，Planner 对需要文件/执行上下文的请求应返回明确的“请先选择工作区”，而不是把 Server 启动目录偷偷当作工作区。只读的纯对话请求可以继续执行，但不得伪造 Workspace 上下文。

### 4.4 完整 Trace 的持久化与分页回放

新增按 `accountId / conversationId / turnId / sequence` 索引的 Trace projection，或在现有 segment index 上增加等价的按 Turn 查询能力。推荐独立 projection，因为它可以在 journal compaction 后稳定分页，并且不会让 Web 历史读取扫描整段审计日志。

每个 Trace page 采用如下契约：

```text
{
  turnId,
  streamRevision,
  firstSequence,
  lastSequence,
  events: [...],
  nextCursor,
  pageHash?
}
```

读取规则：

1. 首次请求固定 `streamRevision`，只返回阶段摘要和第一页。
2. Web 使用 `nextCursor` 继续获取后续页；事件按 `sequence/eventKey` 去重。
3. 刷新或重连时，如果 revision 仍有效，从 cursor 继续；cursor 过期则返回显式 reset，并从最新快照和第一页重新开始。
4. 实时 `trace_delta` 与历史 page 使用同一事件键合并，晚到事件不能覆盖已确认的 terminal 状态。
5. Web 默认不一次性将完整历史放入 React state；详情抽屉或“完整回放”操作才按页加载。

Gateway snapshot 只保存当前 Turn 的摘要、事件计数、sequence 范围和分页指针。它不再通过保留 Trace 后缀冒充完整历史。

### 4.5 超过 64 KiB 的处理

完整回放总量超过 64 KiB 是正常情况，必须拆成多页。单个事件超过 64 KiB 时分两类处理：

#### 可摘要字段

对 `summary`、错误详情、进度文本等字段按字段截断，并携带：

```text
truncated: true
originalBytes: <原始字节数>
```

不能把 raw prompt、stdout/stderr、凭据或隐藏推理塞回 Trace。截断发生在 Server projection 边界，按 UTF-8 字节计算，保留完整 JSON framing。

#### 必须保留的大结果

把结果写入 Artifact/Blob 存储，Trace 只携带：

```text
artifactId, mediaType, byteLength, contentHash, download/read capability
```

Artifact 通过独立的鉴权、范围读取或分段下载接口访问。禁止把一个 JSON 事件从中间切成多个无法独立解析的片段。

建议单页目标控制在约 48 KiB，给 JSON 编码、协议字段和未来字段留出余量；最终实现仍必须用实际 UTF-8 字节数检查，而不是字符数。

### 4.6 Timeline 和公共路由身份

在 Task 创建或 Attempt dispatch 时解析并固定：

```text
executorDisplayName
harnessDisplayName
providerDisplayName
modelDisplayName
configurationRevision
bindingFingerprint
```

将这些字段持久化到 Attempt/TimelineSubtask 的 durable projection。历史卡片优先使用 Timeline 身份，Trace 只补充实时步骤和细节。即使当前配置被删除、改名或切换 revision，历史执行仍能显示当时的公共名称；无法恢复的旧记录显示“历史模型信息不可用”，不暴露内部 ref。

### 4.7 Planner、Kernel、Executor 阶段叙述

服务端为每个阶段生成稳定的摘要和 step 数：

- Planner：RPC 启动、提案生成、提案校验/重试、提案接受或收敛失败；
- Kernel：授权决策、拒绝原因、dispatch、取消/恢复决策；
- Executor：Attempt 启动、公开进度、receipt、验证和交付。

`planning.proposal` 和 `authorization.decisions` 必须计入 narrative steps，并渲染安全摘要。前端不通过“事件条数”猜测阶段是否执行过；阶段索引、计数和状态由服务端计算，前端只做分页和展示。

### 4.8 价格准入与账单状态

价格规则：

1. 启用 AgentClass 引用的 Model 必须同时具备输入和输出价格，或者用户明确输入数值 `0`。
2. 缺少价格时，保存并激活失败，设置页指出具体 Provider/Model/字段；已激活旧 revision 仍可按现有兼容策略继续读取，但新 revision 和新任务不得绕过准入。
3. 显式零价格生成有效 price book，例如 `price_book_version = configured-zero-v1`，账单可进入正常 finalized/zero 结算路径。
4. `unconfigured` 只能表示部署未完成，不能作为可执行配置的有效价格簿。
5. 新任务准入再次检查 revision-pinned price book，防止 Server 热更新后出现无价格执行。
6. 历史 `pending_reconciliation` 账单不自动改价、不伪造免费，只在价格簿恢复后按既有 reconciliation 规则处理。

## 5. 实施阶段

### Phase 0：契约和回放夹具

建立包含完整 journal、稀疏 presentation、durable Task/Attempt、不同 revision 和缺价 Model 的只读 fixture。记录每个 Turn 的 Trace 数、sequence 范围、Timeline 和账单状态。先把当前机器与另一台机器的配置、激活 revision、Workspace 绑定和 release 版本做可比较导出，避免把环境差异误判为代码行为。

### Phase 1：配置生命周期与启用态门禁

拆分画像草稿编译和 revision 发布；修复 manifest 依赖；实现启用依赖闭包校验；增加缺价和显式零价测试。此阶段不改变 Web Trace 存储。

### Phase 2：Workspace 授权统一

移除源码目录作为默认授权根；让 Conversation Workspace 成为唯一授权来源；补充 Release 安装、无源码目录、未绑定 Workspace 和路径越界测试。

### Phase 3：Trace projection 与分页回放

实现 durable Trace projection、分页协议、cursor/revision/reset、实时与历史去重和 Artifact 引用。旧 journal 通过一次性重放建立 projection；无法恢复的事件保留诊断而不静默丢失。

### Phase 4：Timeline 和阶段叙述

扩展 Timeline/Attempt 公共身份；服务端计算阶段 step；Web 按阶段、页和详情抽屉渲染。旧 Timeline 没有身份时显示明确 unavailable 状态。

### Phase 5：上线验收与迁移收口

执行真实 Server restart、Web refresh、Conversation 切换、TUI attach/reconnect、长 Trace 完整回放、Artifact 下载、配置激活失败和零价账单验收。确认新 projection 和旧 journal 在 compaction、备份、rollback 后仍可读。

## 6. 必须增加的验证

### 配置与准入

- 禁用 AgentClass 配置模型不匹配、能力描述非法、价格缺失时，其他启用 AgentClass 仍可保存并激活。
- 重新启用该 AgentClass 时立即阻止并指出具体依赖。
- 点击“更新画像”不读取 `revision-manifest.json`，语义提炼失败只产生草稿诊断。
- 没有输入或输出价格的启用 Model 不能激活或启动新 Task。
- 输入/输出价格显式为 0 时生成有效零价 price book。

### Workspace 与 Planner

- Release 安装目录不存在源码仓库时仍能启动 Planner。
- Workspace 为 `/tmp/workspace` 时，`cwd` 位于该目录可以启动；`/tmp` 或其他目录被拒绝。
- Conversation 未绑定 Workspace 时，对话请求和需要文件的请求分别返回正确行为。
- Server 重启、切换 Conversation 后授权 Workspace 不串线。

### Trace 与 Web 回放

- 完整 Trace 总量大于 64 KiB 时，分页可以取回全部事件，顺序、sequence 和 eventKey 不变。
- 单个摘要事件大于 64 KiB 时按 UTF-8 字节截断并标记 `truncated/originalBytes`。
- 大结果通过 Artifact 引用完整读取，Trace JSON 仍小于 64 KiB。
- 历史 Turn 没有 presentation record 时仍能显示完整 Trace 和 Timeline。
- 刷新、重连、重复分页请求和 cursor reset 不重复、不丢事件。
- Planner proposal、Kernel decisions、Executor progress、verification、delivery 均出现在对应阶段。
- 历史卡片在当前配置改变或删除后仍显示执行时的公共身份。

### 账单与一致性

- 缺价任务不会产生可被误解为“免费”的 finalized bill。
- `pending_reconciliation` 明确显示“待补齐价格”，金额 0 不被展示为已结算免费。
- projection 重建、segment compaction 和 rollback 后，Trace/TL/账单仍可关联到同一个 Account/Conversation/Turn/Task。

## 7. 迁移、兼容和风险

旧 presentation 中只有 Trace 后缀的 Turn 不应被删除。迁移任务应从完整 journal 和 durable Task 事实重建新 Trace projection；如果历史 journal 本身已经被旧 snapshot 丢弃，只能显示“历史事件不完整”的诊断，不能伪造完整回放。

分页 API 必须保留现有 `trace_snapshot`/`trace_delta` 客户端的兼容 reset 行为，先让旧客户端收到可理解的 reset，再由新客户端使用分页接口。任何新表或 projection 都必须纳入 SQLite schema、备份、恢复、segment compaction 和 account rollback 的同一事务/检查点策略。

主要风险有三类：

1. Trace projection 与 journal 双写可能产生短暂不一致，需要事件键幂等、重放和版本校验。
2. 历史记录可能只有后缀，迁移无法恢复物理上不存在的事件，必须诚实展示不可恢复范围。
3. 将价格校验纳入激活门禁会暴露现有配置问题，需要设置页提供具体修复路径；不能通过默认为未知或默认为免费绕过。

## 8. Review 时需要确认的决策

1. Trace projection 采用独立 SQLite `interaction_trace_events` 表，还是复用 Gateway segment index 增加按 Turn 读取能力。推荐独立表，理由是历史分页、compaction 和 Web 查询边界更清晰。
2. 完整回放页面是否默认自动加载全部页，还是默认第一页并由用户点击“继续加载”。推荐后者，避免大 Trace 占用浏览器内存。
3. Artifact 的物理存储是否沿用现有 ArtifactStore，还是为大日志增加专用 BlobStore。推荐沿用现有受鉴权的 ArtifactStore，只新增 media type、分段读取和保留策略。
4. 对已经激活但缺价格的旧 revision，是仅阻止新任务，还是在 Server 启动时也阻止激活。推荐保留旧 revision 可读和可诊断，但阻止新任务，并要求下一次保存并激活修复价格。
5. 未绑定 Workspace 的 Conversation 是否允许纯 Planner 对话。推荐允许纯对话，所有需要文件、Shell、Git 或执行器的请求必须先绑定 Workspace。

## 9. 完成标准

方案实施完成后，用户在 Release 安装环境和源码开发环境中都可以使用同一套逻辑：启用态决定配置校验范围；画像更新和持久激活边界清晰；Planner 使用 Conversation Workspace；Web 历史从 durable projection 分页恢复完整 Trace；Timeline 保存执行时公共身份；Planner/Kernel 阶段可见；无价格配置不会被当成可执行或免费；任意单事件和任意分页都遵守 64 KiB framing 限制。

## 10. 本次实施记录

已交付：

- 配置编译和运行时渲染只处理启用 AgentClass；禁用对象的坏引用、坏能力画像和缺价 Model 不再阻塞其他启用对象。
- 画像预览使用当前激活 revision 作为只读基线，缺失 manifest 时返回安全诊断，不把“更新画像”变成持久 revision 写入。
- 保存并激活增加启用 Model 输入/输出价格准入；显式 `0` 被视为有效价格，缺失价格会阻止激活和新工作准入。
- Planner supervisor 支持按 Conversation Workspace 动态解析授权根；Release 安装不再依赖源码目录或启动 shell 目录。
- Web attach 使用完整 Gateway journal 回放，避免 compacted snapshot 的 Trace 后缀遮蔽 Planner/Kernel 事件。
- Gateway Trace payload 在落盘前进行 UTF-8 字节级字段截断，保留 `truncated` 和 `originalBytes`，不切割 JSON 事件；嵌套大字段也会降级为最小可审计事件。
- Gateway segment index 提供按 Turn 的完整 Trace 分页能力；游标由 Trace 自身 `sequence + eventKey/id` 组成，跨 File/Segmented journal 去重且不依赖数组偏移。
- Timeline Subtask 从 durable dispatch/receipt 保存 Harness、Provider、Model 和 configuration revision 绑定；授权时同时固定公共显示名，Web 卡片和执行逻辑优先显示该历史身份。
- Planner proposal、Kernel decisions 计入 Execution Narrative steps，并渲染安全摘要。

验证：

- `npm run lint` 通过。
- `npm run build` 通过，包含 Web Vite 构建。
- 方案相关 focused tests 通过（本轮新增和受影响测试共 200+ 项）；完整 `npm test` 通过（487 个测试文件、3197 个测试通过，12 个跳过），包括启用态价格准入、超大 Trace payload、跨页完整 journal 回放、Timeline 投影、Planner Workspace 授权和配置激活回归。

实现边界：本次复用现有 Segmented journal/index 作为 Trace durable projection，没有另建 SQLite `interaction_trace_events` 表；Web attach 仍通过完整历史回放构造当前会话状态，分页端口已提供给需要按页读取的客户端。旧版本已物理丢失的 Trace 事件无法凭空恢复；历史 revision 和授权时固定名称都不可读时显示“历史配置不可用/历史模型信息不可用”，不会重新读取当前配置冒充历史事实。
