# Completion Protocol「结果优先交付」重设计

- 计划日期：2026-08-20
- 状态：已完成
- 完成日期：2026-08-21
- 关联 ADR：[ADR-0021](../adr/0021-work-graph-v4-subtask-execution-contract.md)（Subtask 执行契约）、[ADR-0022](../adr/0022-unified-kernel-control-plane-and-decision-ledger.md)（Kernel 控制面）、[ADR-0026](../adr/0026-phase-6-single-task-reliability-closure.md)、[ADR-0032](../adr/0032-result-first-delivery-and-completion-certification.md)（结果优先交付与完成认证分离）
- 关联代码：`src/execution/completion-protocol.ts`、`src/execution/subtask-attempt-runner.ts`、`src/kernel/control-kernel.ts`、`src/execution/kernel-execution-runtime.ts`

## 1. 背景与目标

### 1.1 故障

Executor 已经完成联网研究并生成了有效报告，但最终 completion trailer 的
`evidence` 超过 4 条，MetaWork 将整个结果判定为
`completion_malformed`，随后 response-only correction 耗尽，Task 进入
`blocked`。用户看到的是“模型完成了工作，但平台扣下了答案”。

### 1.2 根因

当前 Completion Protocol 将三类不同问题混成一个布尔结果：

1. 用户正文是否可以展示；
2. Runtime 是否有足够的事实把 Subtask 标记为成功；
3. 输出是否违反安全边界。

因此，内部 trailer 格式、证据条数和正文大小可以否决已经生成的业务结果。
同时，`evidence` 既作为验收元数据，又被 Runtime 拼接成下游 handoff 文本，
导致审计字段承担了业务载荷职责。

### 1.3 目标

MetaWork 的核心价值是选择最匹配的 Harness、模型和权限配置，并负责授权、
协调、观察、恢复和交付。Executor/Harness 负责产出业务结果。

本方案要建立以下不变量：

> 只要结果没有触犯安全边界，Executor 已经生成的可展示业务正文不能因为
> 内部 completion 元数据问题而丢失；但“可以展示”不等于“可以认证为任务完成”。

## 2. 设计原则

### 2.1 三个独立判定轴

所有 Executor 终态必须分别计算：

| 判定轴 | 含义 | 失败后的行为 |
| --- | --- | --- |
| `resultDeliverability` | 是否存在可安全展示的业务结果 | `deliverable` / `quarantined` |
| `completionAuthority` | 是否足以写入成功回执、发布 handoff、推进 Subtask | `certified` / `uncertified` |
| `safetyDisposition` | 是否触犯路径、权限、workspace 等安全边界 | `safe` / `safety_blocked` |

典型组合：

- 完整 trailer + 正常 workspace facts：`deliverable + certified + safe`
- 正文存在但 marker 缺失：`deliverable + uncertified + safe`
- 正文存在但 report 写入 workspace：`quarantined + uncertified + safety_blocked`
- 进程超时且只留下半截正文：`deliverable + uncertified + safe`，正文可展示，
  但不能标记 Subtask `done` 或启动下游。

### 2.2 原文、业务结果和安全交付视图分层

系统保存三种不同对象，并且三者必须使用不同的访问权限和生命周期：

1. `rawAttemptOutput`：Executor 原始输出，写入受控的追加式对象存储，用于审计和恢复；
2. `businessResult`：从响应中确定的用户可见正文；
3. `safeDeliveryProjection`：经过协议封套剥离、控制字符处理和秘密/内部元数据
   隔离后的用户交付视图。

“结果优先”不等于把原始 stdout、stderr、凭据、内部路径或隐藏推理原样暴露给用户。
`rawAttemptOutput` 只允许受控的审计/恢复路径读取，Gateway、Conversation 和普通
Executor 不得读取它。采集过程不能把无限输出累积在进程内存中：Runtime 应边读边
写入不可变对象；若对象写入失败或达到存储配额，必须记录
`raw_capture_incomplete`，不能把残缺对象宣称为完整审计证据。

`businessResult` 只能来自受信任的 Executor 输出通道和确定性的正文提取器。marker
缺失时不能把混合 stdout/stderr 或协议诊断自动当成业务正文；无法安全区分时，
结果进入 `quarantined`，而不是“尽可能展示原文”。安全投影可以隔离危险内容，
但不能因普通长度、来源数量或格式问题否定已经确认安全的业务正文。

### 2.3 不限制业务结果，但保留基础设施边界

删除 `evidence <= 4` 这类业务限制，不等于删除所有技术边界。必须区分：

- **业务语义限制**：来源数量、正文长度、证据条数、合法工具调用次数，不得
  作为正常结果的拒绝理由；
- **基础设施边界**：单次进程内存、SQLite 写入、JSONL 帧、WebSocket 事件、
  Gateway payload、模型上下文和磁盘容量，需要通过存储引用、分块、分页或
  过程失败处理治理。

基础设施边界不能静默截断结果。超过单帧能力时应改用分块或不可变结果引用；
超过过程资源能力时应记录 `incomplete`，向用户交付已经确认存在的部分，并由
Kernel 决定恢复，而不是把截断内容冒充完整成功。

### 2.4 下游只获得授权的结果引用

不能把完整 body 无差别复制给每一个下游 Subtask。这样会绕过
`requiredItems`、扩大上下文、传播无关内容和提示注入。

正确模型是：

```text
Executor output
  -> immutable ResultObject
  -> Runtime-owned authorized ResultReference
  -> only the direct dependency edge can read it
```

下游 prompt 只注入边级摘要和引用元数据；下游 Executor 通过 attempt-scoped、
只读的结果读取能力按需读取完整内容。结果引用必须绑定 Task、generation、
source Subtask、target Subtask 和 authorized edge。

### 2.5 与 MetaWork 核心定位的边界

本方案明确不把以下内容作为业务结果闸门：

- 正文长度、来源数量、证据条数和正常执行时间；
- Executor 的正常推理深度和合法工具调用次数；
- metadata trailer 的大小、字段格式或 marker 是否存在；
- 单个 Gateway 帧、SQLite 行或 handoff 文本字段的物理容量。

这些限制仍可作为传输、存储、内存和资源保护边界，但超过边界时必须采用分块、
对象引用、追加式落盘或 `partial/incomplete` 状态；不能把“无法装进一个容器”
解释为“业务结果无效”。

文件交付是一个需要额外 workspace 事实的独立能力。workspace delta 缺失、截断
或无法确认时，只能阻止不安全的文件发布和下游文件 handoff；如果文本正文已经
被确定性提取且通过安全检查，文本结果仍应交付，并标记为
`uncertified` 或 `file_delivery_incomplete`。

`evidence` 是验收/审计辅助元数据，不是答案载荷。Runtime 应优先对它做确定性
归一化（去除协议噪声、规范空白、按稳定规则去重和分组）；无法安全归一化时，
保留原始审计引用并标记 `audit_metadata_incomplete`，不能重新执行或丢弃正文。

## 3. 技术方案

### 3.1 Completion Protocol 不再是唯一交付闸门

`completion-protocol.ts` 负责解析和认证，不再决定用户是否能看到已经产生的
安全正文。

当前生产基线是 Completion Protocol v3。由于本方案改变了“正文交付”和“完成认证”
的语义，落地时升级到 Completion Protocol v4，不通过双读、双写或隐式降级兼容
旧协议。已完成的 v3 回执保持不可变；新 Executor prompt、适配器和测试统一使用
v4。

v4 的解析结果改为：

```ts
type CompletionAssessment = {
  result: {
    kind: 'complete' | 'partial' | 'failure' | 'none';
    body: string | null;
    businessResultRef: string | null;
  };
  deliverability: {
    status: 'deliverable' | 'quarantined';
    violations: CompletionContractViolation[];
  };
  certification: {
    status: 'certified' | 'uncertified';
    envelope: CompletionEnvelopeV4 | null;
    violations: CompletionContractViolation[];
  };
  safety: {
    status: 'safe' | 'safety_blocked';
    violations: CompletionContractViolation[];
  };
};
```

规则：

- v4 marker 和 trailer 完整有效，且 workspace、acceptance 和 handoff facts
  均通过 Runtime 校验：`result.kind = 'complete'`、`certified`；
- v4 允许 body-only 响应。marker 缺失、JSON 非法、重复 marker、旧字段约束
  不满足或 response-only correction 失败时，只要正文提取和安全检查成功，就记录
  `result.kind = 'partial'`、`deliverable`、`uncertified`，交付正文但不得推进
  Subtask；
- Executor 明确返回 `failure`：保留失败结果并进入普通失败处置；
- 路径逃逸、未授权写入、report 修改 workspace、未授权结果传播：
  `safety_blocked`，不向用户暴露未经隔离的内容；
- workspace delta 不可判定时，只有文件交付和文件 handoff 进入
  `file_delivery_incomplete`；已经确认安全的文本正文仍可交付；
- `noChangeReason` 不得覆盖模型原文；它只影响 completion certification。

`uncertified` 不是新的战略路由。Runtime 只负责持久化 Result Object、生成安全
交付投影和提交标准化事实；`ControlKernel` 仍然是唯一决定
`awaiting_decision`、恢复、重派、人工确认、下游释放和最终完成的组件。
用户交付事件可以先于 Kernel 的最终完成决策发出，但必须带有
`certification: 'uncertified'`，并且崩溃恢复时由持久化事实幂等重放。

### 3.2 结果对象、持久化与分块传输

完整结果不能依赖单个 JSON、单个 WebSocket 帧或单个 Gateway 事件。

Phase 0 必须冻结 Result Object 的最小契约；实现阶段预计需要 SQLite schema v32
和账户数据根下的不可变结果对象目录。不得把完整正文继续塞进
`executor_attempt_receipts`、Kernel ledger 或 Gateway event JSON。

`ResultObject` 至少包含：

- `resultId`、`accountId`、`taskId`、`generationId`、`sourceSubtaskId`、
  `attemptId`；
- `kind: raw_attempt_output | business_result | safe_projection`；
- `contentHash`、`byteLength`、`mediaType`、`storageUri`、`completeness`、
  `createdAt`；
- `retentionClass` 和访问边界。`raw_attempt_output` 不允许通过普通 Gateway 事件
  或客户端命令读取。

`ExecutorAttemptReceipt` 只保存 Result Object 引用、`CompletionAssessment` 的
结构化摘要和校验版本；它仍然是不可变的终态审计事实。Result Object 的内容本身
采用内容寻址或等价的不可变写入方式，引用提交前必须完成 hash、长度和权限校验。

- 用户交付通过 `result_snapshot`、`result_chunk`、`result_completed` 事件流式
  传输；
- Gateway/WebSocket/JSONL 的单帧限制仍然有效，超帧必须分块；
- 客户端重连可以按 `resultId + offset` 恢复，并校验 `contentHash`；
- 任何被取消、超时或异常终止的执行都保留已经落盘的原始结果，并标记是否
  `complete`、`partial` 或 `incomplete`；
- 对象清理必须以 AccountRuntime 的 retention policy 和未完成引用为依据，
  不能在仍有审计、交付重放或授权 handoff 引用时删除。

持久化顺序必须可恢复：

1. 流式写入 raw object；
2. 生成 business result 和 safe projection；
3. 校验 hash、长度、敏感信息隔离和引用权限；
4. 在一个幂等应用步骤中落 receipt 引用及 assessment；
5. 发布 Gateway 交付事实和 Kernel 标准化执行事实。

如果进程在任一步骤崩溃，启动恢复根据 `resultId`、attempt ID 和幂等键继续或
标记对象为 `incomplete`，不能重跑一次昂贵 Executor 来“修复”一个已经存在的
结果。

这不是对业务答案做截断，而是把大结果从单帧改为可恢复传输。

### 3.3 Handoff 从“文本复制”改为“边级结果引用”

当前 `materializeCompletionEnvelope` 不再把 `evidence.join('\n')` 作为下游
文本，也不把完整 body 无条件复制到所有 outgoing edges。

生产实现不新增“短期 v3 兼容方案”。v4 中：

- 维持 Runtime 拥有目标 Subtask 和 acceptance identity；
- 为每个授权 outgoing edge 写入一个不可变 `ResultReference`；
- `ResultReference` 至少包含 `referenceId`、`resultId`、Task/generation/source/
  target/edge identity、授权的 `requiredItems`、摘要 hash、读取范围和过期/保留
  规则；
- 下游 prompt 只获得 edge-specific reference、摘要和读取权限；
- 下游需要全文时通过受控结果读取能力分块读取；
- 未授权目标、错误 edge 或缺失 required material 仍属于 completion authority
  失败，不得静默发布 handoff。

后续协议版本可让 Executor 为每个 required item 生成专属 handoff 内容，但不能让
模型直接决定内部 Subtask ID、目标 edge 或越权路径。目标身份仍由 Runtime
根据 Planner 授权契约注入。

### 3.4 Correction 保留，但只修复认证元数据

response-only correction 不再拥有否决用户结果的权力，也不再重新执行任务。
它只用于在正文已经产生后补齐：

- marker；
- 严格 JSON trailer；
- `noChangeReason`；
- 可认证的 completion metadata。

处理顺序：

1. 先持久化并展示安全的业务正文；
2. 尝试直接认证；
3. 认证失败时，最多执行一次轻量 metadata correction；
4. correction 成功则升级为 `certified`；
5. correction 失败则保留 `uncertified` 结果，交付正文，并把 Subtask 保持在
   `awaiting_decision` 或等价的 Kernel 管理状态，交给 Kernel 的普通恢复/人工
   决策路径；
6. 不得因为 correction 失败而丢弃正文或把“格式失败”伪装成安全阻塞。

这保留了低 Token 成本的恢复路径，同时消除“格式修正失败即永久 blocked”。

### 3.5 安全与完成判定

只有以下情况可以阻止用户结果交付：

- 结果包含未隔离的秘密、凭据或受保护内部数据；
- workspace 路径逃逸或未授权写入；
- workspace delta 缺失/截断，且结果声称需要提交文件交付；
- 结果引用指向未授权 Task、Subtask、Account 或 edge。

下列情况不能阻止正文交付，但不能认证 Task 完成：

- marker 缺失或重复；
- trailer JSON 非法；
- evidence 为空、过多或字段格式不符合旧约束；
- `noChangeReason` 与 workspace facts 不一致；
- 结果超过单帧，需要分块；
- Executor 超时后留下可识别的部分正文。

“可展示”和“可完成”必须分别有测试和事件，不得由单一 `ok: boolean` 表达。
其中 metadata trailer 的 `MAX_REPORT_BYTES` 只能限制单个元数据帧；handoff 的
文本/路径预算只能限制单次传输或引用范围。二者都不得再使已确认安全的业务正文
进入 `contract_blocked`。

### 3.6 事件、状态和职责边界

本方案不新增第二个战略路由器。事件分为两类：

| 事件 | Owner | 作用 |
| --- | --- | --- |
| `result_delivery_available` / `result_chunk` / `result_completed` | Delivery/Gateway | 向已授权客户端投影 safe projection，支持重连和 offset |
| `execution_result_observed` | Runtime -> KernelWorkflow | 提交 Result Object 引用、assessment、workspace facts 和 attempt 终态事实 |

`result_delivery_available` 不能改变 Task、Subtask、handoff 或 Executor 状态。
`execution_result_observed` 也不携带“请直接完成”的隐含策略；Kernel 根据当前
snapshot 决定 `publish_completion`、`awaiting_decision`、`safety_hold`、重派或
其他已有动作。若 `uncertified` 结果已经展示，客户端状态必须明确显示“结果已
返回，任务完成认证待处理”，不能误显示为成功完成。

## 4. 落地顺序

### Phase 0 — ADR 与契约先行

在修改代码前完成：

- 新增“结果优先交付与完成认证分离”ADR，修订 ADR-0021、ADR-0022 中关于
  completion failure、handoff budget 和 correction 的条款；
- 明确 Completion Protocol v4，以及
  `resultDeliverability`、`completionAuthority`、`safetyDisposition` 的事件/
  持久化契约；
- 明确 Result Object、ResultReference 和分块 Gateway 事件的 owner；
- 明确历史 `handoff_contract_failed`、`contract_blocked` 的回放和升级规则。
- 明确 schema v31 -> v32 的迁移、对象目录布局、幂等键、保留策略和崩溃恢复
  状态；若评审决定不升 schema，必须给出等价的持久化证明，不能默认复用现有
  `raw_response` 字段。

没有完成 Phase 0，不进入实现阶段。

### Phase 1 — 结果持久化与安全交付分离

改动：

- `src/execution/completion-protocol.ts`
  - 从 `boolean ok` 改为三轴 assessment；
  - 升级为 v4 body-first 解析；删除 evidence 固定 4 条、单条 1,000 字符、
    metadata 128 KiB 以及 handoff 文本/路径预算对业务正文的拒绝语义；
  - 对 evidence 和旧字段做确定性归一化；无法归一化时只记录
    `audit_metadata_incomplete`；
  - marker/trailer 解析失败时保留可用 body，并标记 `uncertified`；
  - 保留 artifact containment、文件交付所需的 workspace delta 和安全边界校验；
    delta 不确定时不得阻止安全文本结果交付。
- `src/execution/subtask-attempt-runner.ts`
  - 先持久化 Result Object；
  - 结果交付和 completion certification 分离；
  - 不再把可交付正文送入 `contract_blocked` 黑洞。
- `src/storage/` 新增 Result Object repository/port。

测试：

- 5 条以上 evidence、长 evidence、超旧 report 预算仍能保留完整正文；
- marker 缺失、JSON 非法、多 marker 时正文可交付但 Subtask 不标记 done；
- 安全违例不交付；
- report metadata、handoff 文本或 artifact 数量超过单容器预算时，正文仍可交付，
  只对对应的元数据、文件交付或下游引用标记不完整；
- raw output、business body、safe projection 的边界测试；
- 取消/超时后 partial result 可恢复读取。

### Phase 2 — 分块 Gateway 与边级结果引用

改动：

- `src/gateway/client-events.ts`、`src/gateway/conversation-gateway-runtime.ts`、
  `src/management/websocket.ts`：增加 result chunk/snapshot 事件；
- `src/storage/`：保存 Result Object、hash、offset、媒体类型、完成状态和保留
  引用；
- `src/execution/subtask-handoff-repo.ts`：保存授权 ResultReference，不再复制
  evidence 或完整 body；
- `src/executor/prompt-builder.ts`：下游只收到边级摘要和受控读取能力。

测试：

- 大于单帧的结果可分块传输、重连和按 offset 读取；
- 内容 hash 在落盘、读取和交付端一致；
- 同一结果不能被无关 Subtask 读取；
- 多子任务链路不把上游全文复制到所有下游 prompt。

### Phase 3 — Correction 与 Kernel 收敛

改动：

- 保留 response-only correction，但删除其“格式失败即永久阻塞”语义；
- `control-kernel.ts` 使用普通 `uncertified_result` / `safety_violation`
  事实，不新增第二套战略路由；
- 安全违例进入人工决策或安全恢复；
- 未认证但可交付的结果不能自动发布下游 handoff；
- 历史 `contract_blocked` 记录通过确定性、幂等的升级事件转换为
  `uncertified_result`，先恢复已有 raw response 并注册 Result Object，再决定
  是否重派；
- 不直接用模型输出合成成功回执。

测试：

- correction 成功只改变 certification，不改变 body；
- correction 失败仍可交付正文，不出现“格式失败永久 blocked”；
- 安全失败不会被 fallback 到另一个 Executor 掩盖；
- 历史回执升级可重放，二次重启不重复派发；
- 已有完整 raw response 的任务不重复消耗一次完整联网执行。

### Phase 4 — 文档与运行态验证

- 更新 `CONTEXT.md`、ADR-0021/0022、`docs/current/technical-overview.md`；
- 更新 Web/TUI/Feishu 的结果流式协议和状态文案；
- `npm run lint`、`npm run build`；
- Docker focused tests；
- `npm test`；
- `npm run smoke:metaclaw`；
- `npm run smoke:metaclaw -- --scenario artifact`；
- 复杂报告、大结果、超时 partial、marker 缺失和安全违例端到端验证。

## 5. 存量数据与兼容策略

- 不删除、不改写历史 `rawResponse`、receipt、Kernel ledger 和
  `handoff_contract_failed` 事件；
- 为历史 `contract_blocked` 记录增加确定性升级标记和幂等 event ID；
- 如果 raw response 中存在经过确定性提取和安全检查的 body，先注册为
  `partial/uncertified` Result Object，用户可以看到已有结果；
- 如果历史 raw response 混合了无法隔离的 stderr、内部诊断、凭据或隐藏推理，
  不得直接投影给用户，只能保留在受控审计边界并进入普通恢复；
- 只有 body 缺失、结果不完整或触犯安全边界时，才进入普通恢复；
- 升级恢复不能直接把历史正文标记为成功，也不能无条件重新执行；
- 新版本不双写 v3/v4 协议；历史 v3 仅作为不可变审计记录读取，生产新执行
  只生成 v4 Result Object 和 assessment。

## 6. 风险与取舍

1. **结果存储增加复杂度**：需要 Result Object、hash、分块和清理策略，但
   这是让大结果可靠交付的必要基础设施，不应通过缩短答案规避。
2. **未认证结果不能自动驱动下游**：用户能立即看到结果，但依赖该结果的
   Subtask 需要等待认证、人工确认或恢复，避免把半截内容当作完整依赖。
3. **安全投影可能与 raw output 不同**：原始输出保留在受控审计边界，用户
   看到的是安全业务结果；这是安全要求，不是对正常业务答案的任意裁剪。
4. **Correction 仍有成本**：它只修元数据，不重复业务执行；若失败，保留
   结果并进入普通恢复，避免“重新联网研究”造成更高 Token 消耗。

## 7. 验收标准

- Executor 生成的安全正文不会因 evidence 条数、长度、marker 或 trailer
  格式问题而丢失。
- metadata、handoff 或 artifact 的物理预算不会再转化为正文丢失或
  `contract_blocked`；超限只影响相应的传输、文件交付、审计完整性或下游释放。
- Completion Protocol v4、Result Object、ResultReference、分块事件和 schema
  migration 契约在 ADR 中冻结后才开始代码实现。
- 可展示结果与 completion certification 明确分离，未认证结果不会被错误
  标记为 Subtask `done`，也不会未经授权驱动下游。
- 大结果通过 Result Object 和分块事件完整交付，不能静默截断。
- 下游只能访问直接依赖边授权的结果引用，不能收到全图无关正文。
- correction 失败不再丢弃正文、不再单独导致永久 `blocked`。
- 安全边界仍 fail closed，并保留路径、workspace、权限和账户隔离测试。
- 历史 contract-blocked 任务可以幂等升级；已有安全正文优先恢复展示，不
  自动重复执行昂贵任务。
- 任何新增业务结果限制必须经过 ADR 说明，不得以基础设施限制冒充业务
  质量规则。

## 8. 本轮评审结论

本方案采用“结果先落盘和交付，完成后认证”的双轨模型，但没有放宽安全边界，
也没有把 `uncertified` 变成新的调度器。必须先完成 ADR-0032、ADR-0021/0022
修订和 schema v32 契约冻结，再进入实现；否则直接修改 Completion Protocol 会
把结果投影、Kernel 决策、历史回放和数据库迁移同时变成隐式兼容逻辑。

## 9. 实施进展与验证

截至 2026-08-21，ADR-0032 和本计划定义的生产链路主体已经落地：

- Completion Protocol v4 已按 `resultDeliverability`、
  `completionAuthority`、`safetyDisposition` 三轴评估结果；安全正文与完成
  认证分离，metadata correction 失败不再扣留正文或直接造成永久阻塞；
- raw attempt output、business result 和 safe projection 已分别保存为不可变
  Result Object；安全投影执行秘密隔离，raw object 不进入普通 Gateway；
- 下游 handoff 使用绑定 Account、Task、generation、source/target Subtask 和
  edge 的 ResultReference，并在 attempt scope 内授权读取；
- Gateway、Web、scripted client、Feishu 和 Planner TUI 已消费
  `result_delivery_available`、`result_chunk`、`result_completed`，支持按
  offset 重放、UTF-8 边界组装和内容 hash 校验；
- Kernel 已消费 `execution_result_observed`，对 uncertified result 保持普通
  决策与恢复所有权；历史 `contract_blocked` 结果可确定性、幂等升级；
- SQLite schema v32、原生安装/更新和备份检查已收敛；首次启动会创建账户数据库
  父目录；
- Result Object 实际数据根位于账户 `data/results`，不会再把内部
  `.anyfusion-results` 写入或提交到用户 workspace。

验证结果：

- `npm run lint`、`npm run build`、`npm --prefix web run build` 和
  `npm --prefix planner/AnyFusion-Pi/packages/coding-agent run build`：通过；
- `npm test`：307 个测试文件通过、4 个跳过；1368 个测试通过、15 个跳过；
- `npx vitest run tests/storage/runtime-database-opening.test.ts`：2 个测试通过；
- `npm run smoke:gateway`：7 个测试文件、30 个测试通过；
- `npm run smoke:metaclaw`：隔离配置下真实 Planner session 通过，Executor 为
  Codex；
- `npm run smoke:metaclaw -- --scenario artifact`：真实 artifact gate 通过，
  Executor 为 Codex；
- 真实 Web/API E2E 完成 bootstrap、认证 WebSocket、用户输入、Planner、
  Kernel、Executor、Git publication 和结果交付；修正后的客户端收到
  `turn_started`、`result_delivery_available`、`result_chunk`、
  `result_completed` 和 `final_answer`，结果交付状态为 `certified`。
  此前的完整交互轨迹 E2E 还验证了 Planner/Kernel/Executor 的
  `trace_delta` 和 `output` 增量投影。
- 最新 E2E Task、Subtask、receipt 和 publication 分别为 `done`、`done`、
  `completed`、`integrated`；raw/business/safe Result Object 分别完整保存
  10022、176、176 字节，且 Completion Protocol 版本为 v4。
  `web-e2e-result-final.md` 在 candidate 和 integration workspace 中存在，
  两份文件均为 35 字节、无尾换行，内容逐字节校验为
  `ANYFUSION_RESULT_FIRST_FIX_20260821`，SHA-256 一致。
- 完整测试套件、Native Planner smoke、artifact smoke、Gateway smoke、Web
  构建和 Planner 构建均已通过；首次启动创建数据库父目录的回归由
  `tests/storage/runtime-database-opening.test.ts`、两条真实 native smoke
  和 Web/API E2E 的全新账户启动路径覆盖。

本机默认 Kimi 配置和既有 DeepSeek 账户 secret 在验证时返回 HTTP 401，属于
Provider 凭据漂移；隔离配置使用现有有效凭据完成了上述真实执行链路。correction
正文不可变、失败 partial 交付、raw staging 崩溃恢复和 Gateway 脱敏后 hash
一致性问题均已关闭并有回归测试覆盖。临时 E2E 服务已停止，未留下运行中的本地
服务或提交到用户 workspace 的 `.anyfusion-results` 污染。
