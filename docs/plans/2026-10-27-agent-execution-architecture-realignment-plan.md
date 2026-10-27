# MetaWork Agent 执行架构重构方案

- 日期：2026-10-27
- 状态：**已实施（P0/P1/P2 全部落地，含评审修复与收尾）；P3 为方案明确的可选后续事项，未进入**
- 完成日期：2026-10-27（代码与聚焦测试）；发布前用户验收门槛见文末实施记录
- 目标：让 MetaWork 以用户目标完成为第一优先级，充分复用 Pi Agent 与 DeepSeek Harness 的执行闭环，收敛当前 Planner、Kernel、Runtime、Executor、服务监督和交付之间的重复状态机。
- 关联：`planner/AnyFusion-Pi/packages/agent/src/agent-loop.ts`、`planner/AnyFusion-Pi/packages/agent/src/harness/agent-harness.ts`、`src/executor/pi-cli-driver.ts`、`src/execution/kernel-execution-runtime.ts`、`src/execution/managed-local-service.ts`、ADR-0020、ADR-0021、ADR-0022、ADR-0023、ADR-0024、ADR-0032、ADR-0050。

## 评审修订：校正 Graph 定位并收敛职责

本次评审后，方案明确采用以下产品链路：

```text
用户需求 → Planner 生成 Work Graph → Kernel 审核/授权 Graph
          → Executor/Harness 执行子任务 → MetaWork 汇总/验证/输出
```

- Graph 不是独立的产品组件或额外调度层，而是 Planner 根据用户意图生成的结构化任务计划和依赖数据。
- Planner 负责理解用户意图、选择能力、拆解任务并形成 Work Graph。
- Kernel 负责审核和授权这个 Graph，包括任务边界、依赖、能力、Workspace、资源和执行绑定。
- Executor/Harness 负责在 Kernel 已授权的子任务边界内完成自己的 turn、tool call、错误修复、重试和验证；Kernel/Runtime 不插入其内部过程。
- MetaWork 负责提供已授权上下文、接收结果、汇总子任务、执行最终验证并向用户输出。

`Run Contract` 仍保留，但它只是 Kernel 审核通过后传给 Executor 的一次性执行输入协议，携带 Workspace、当前 Subtask 目标、验收条件和运行边界；它不是新的 Task/Attempt/Step 状态机，也不拥有模型循环、自动修复循环或服务重试循环。Kernel 仍然是 Graph 的权威审核和授权方，但审核边界停在 Executor 启动及资源操作边界，不延伸到 Harness 的内部执行步骤。

因此，原方案中的 P3 “接入 DeepSeek Harness ACP”降为后续适配事项，不作为本次重构前提。当前优先复用仓库中已有的 Pi/Codex Executor 能力，把 Kernel/Runtime 对 Executor 的干预收敛到授权、资源和最终验证边界。

## 1. 需要解决的问题

当前 MetaWork 不是缺少一个重试分支，而是存在两套同时决定“任务是否完成”的执行循环：

```text
Pi / Codex Harness：模型 → 工具 → 工具结果 → 模型 → 修复 → 验证

MetaWork：Planner → Kernel → Task → Subtask → Attempt → Publication
         → Delivery → Managed Service → Task 状态
```

第一套循环已经具备连续工具调用、工具错误反馈、上下文延续、follow-up、steering 和 Provider 自动重试能力。第二套循环把一次 Attempt、一次交付、一个服务记录或一个旧失败状态提升成了用户可见的阻断条件，导致底层 Harness 已经完成的工作被上层重新判定为失败。

已确认的 BS 服务故障就是该问题的直接实例：Executor 已经生成并自测通过服务；Runtime 发现同一 Workspace 下旧的 `failed` 服务记录后只执行 `status()`，没有启动当前任务的服务，随后把当前任务记录为 `service_start_failed`。因此修复单个端口或单个服务 ID 无法解决架构问题。

## 2. 研究结论

### 2.1 Pi Agent 已经提供的能力

Pi 的 `agent-loop.ts` 具有以下闭环：

1. 将用户输入加入当前上下文。
2. 调用模型并解析工具调用。
3. 执行工具并把成功或失败结果写回上下文。
4. 只要还有工具调用，继续下一轮模型响应。
5. 支持 steering 消息和 follow-up 消息，不需要结束当前会话才能追加用户要求。
6. `AgentHarness` 负责会话持久化、turn 状态、配置快照、session flush 和重入边界。
7. `AgentSession` 对 Provider 临时错误执行指数退避自动重试；错误消息不会被当作永久任务失败。

Pi 的工具失败语义是：

```text
工具失败 → toolResult(isError=true) → 模型读取错误 → 修正参数/代码/命令 → 再调用工具
```

这正是 MetaWork 当前缺失的“失败即反馈”语义。

### 2.2 DeepSeek Harness 已经提供的能力

DeepSeek Harness 的可借鉴部分不是某个 CLI 参数，而是职责分离：

- Workspace 是稳定的会话工作区，不是每一轮都重新复制的临时产物。
- Turn、Step、工具调用、工具结果和 Session 事件有清晰生命周期。
- Session 可以继续、恢复和观察，恢复不会把历史状态误认为新的执行结果。
- 文件变更观察是事实记录，不是任务完成认证。
- 当前文件引用和固定 Artifact 版本是两个不同概念。
- 用户审批只针对需要决策的具体操作，不覆盖普通 Agent 工具闭环。
- 任务最终完成仍由外层验证，但外层验证不能取代 Agent 的连续执行。

DeepSeek Harness 的 ACP/SDK 还明确区分了：

- prompt 入队与 prompt 完成；
- Agent 事件与最终结果；
- 工具生命周期与用户审批；
- Session 恢复与新的任务执行。

MetaWork 应采用这些语义，保留自己的 Workspace 所属、资源租约、凭据隔离和结果验证边界，不应再复制一套与 Pi 相同的模型循环。

## 3. 目标架构

目标链路明确为：

```text
用户目标
  ↓
Planner：理解目标、拆解任务、生成 Work Graph
  ↓ Kernel 审核/授权 Graph
Execution Runtime：按 Graph 调度已授权 Subtask，生成 Run Contract
  ↓
Pi / Codex / DeepSeek Harness：持续执行当前目标
  ├─ 读取 Workspace
  ├─ 修改文件
  ├─ 执行测试和验证
  ├─ 读取错误输出
  ├─ 修复并重试
  └─ 输出候选完成结果
  ↓
Runtime Verifier：验证文件、服务、测试、fileOutputs 和完成协议
  ↓
直接交付结果
```

职责重新收敛为：

| 组件 | 目标职责 | 不再负责的事情 |
| --- | --- | --- |
| Planner | 目标理解、路由、验收条件、Workspace 意图、Work Graph 生成 | 不管理 Harness 的每个执行步骤，不决定代码如何修复 |
| Kernel | 审核/授权 Work Graph，确认资源、租约、配置和执行绑定 | 不把 Harness 内部步骤提升为用户确认，不决定代码如何修复 |
| Execution Runtime | 按已授权 Graph 调度 Subtask，启动 Harness，提供 Run Contract 和最终结果接收 | 不复制 Pi 的 Agent loop，不在 Harness 内部插入重试控制 |
| Harness | 当前目标的连续执行、工具调用、修复、测试和多轮推理 | 不修改 MetaWork Task 状态或绕过 Runtime 验证 |
| Runtime Verifier | 观察工作区、服务和验收结果，形成事实 | 不因旧历史记录阻断当前运行 |
| Delivery | 将已经验证的结果直接呈现给用户 | 不要求用户再次确认已经明确要求的普通修改 |

### 3.1 执行失败和验收反馈原则

执行链路必须遵守“失败先反馈给执行者”的原则：

1. Executor/Harness 内部的工具错误、命令失败、测试失败、代码修复、Provider
   临时错误和多轮推理，全部由 Harness 自己处理。MetaWork 不逐工具调用、逐模型
   turn 或逐修复步骤插入控制，也不把这些中间事实呈现为用户确认。
2. Executor 只有在自己的 turn、工具调用、Provider 重试和验证闭环结束后，才向
   Runtime 返回一次最终 Attempt 事实。`executor_failed` 表示 Harness 已经无法在
   当前执行闭环内继续，不表示第一次工具失败。
3. MetaWork 的验收失败首先是 Mentor feedback：Runtime 保存真实失败原因、验收
   条件、Workspace/服务事实和有界日志，并由 Kernel 基于原 Graph 授权 continuation
   或 recovery packet，再交给同一个 Executor 类别继续修复。不得直接把可修复验收
   失败收口为用户任务失败。
4. 验收规则分为硬约束和可修复反馈。Workspace 越界、未授权凭据/资源、外部副作用
   无法确认、身份或配置 revision 不匹配属于硬约束；服务未启动、健康检查失败、
   测试未通过、代码与 acceptance 不一致等属于可修复反馈，除非修复预算已耗尽。
5. 只有目标存在真实歧义、缺少必要用户输入、外部副作用无法安全判断，或自动修复
   预算耗尽时，才把决策交给用户。普通 Workspace 操作不得出现“接受并交付”“继续
   未完成任务”或“显式重启”一类中间确认。
6. 该反馈闭环不新增 MetaWork Agent Loop。Harness 的内部循环仍属于 Harness；
   MetaWork 只通过现有 Kernel continuation/recovery 接缝把外部验收事实送回下一次
   授权 Attempt。

## 4. 核心设计变化

### 4.1 Run Contract 只是 Graph 授权后的输入协议

Kernel 审核 Graph 后，Runtime 为每个已授权 Subtask 生成一次 `Run Contract`，包含：

```ts
interface RunContract {
  taskId: string;
  subtaskId: string;
  attemptId: string;
  workspaceId: string;
  workingDirectory: string;
  targetPaths: string[];
  objective: string;
  acceptance: AcceptanceCriterion[];
  accessMode: 'read' | 'execute' | 'write';
  serviceIntent?: LocalServiceIntent;
  fileOutputs: string[];
  configurationRevision: string;
  bindingFingerprint: string;
}
```

该 Contract 是 Executor 的固定输入边界。它不包含 Graph 之外的任务拆解，也不包含模型如何分解步骤、何时重试或如何修复代码；这些属于 Planner 生成的 Graph 和 Harness 的执行职责。

### 4.2 MetaWork 不再把单次 Attempt 当成单步任务

一个 Attempt 内允许多个 Harness turn 和多个工具调用：

```text
Attempt started
  → harness turn 1
  → tool calls / tool errors
  → harness turn 2
  → service start / health feedback
  → harness turn 3 修复
  → verifier
  → Attempt completed
```

只有达到外层 wall-time、工具调用、输出大小和模型预算，或者 Harness 明确返回不可恢复错误时，Attempt 才结束。

### 4.3 失败分类改为“反馈优先”

失败统一分成三类：

1. **可由 Agent 修复的执行错误**：代码异常、测试失败、服务退出、健康检查失败、端口冲突、依赖缺失。把完整诊断作为下一轮上下文，自动继续。
2. **可由系统自动重试的基础设施错误**：Provider 临时错误、网络断开、Executor 短暂不可用。沿用 Pi 的退避重试，并由 Runtime 负责进程重启。
3. **真正需要用户决策的阻断**：缺少必要凭据、目标路径不明确、覆盖范围不明确、不可逆外部操作或自动修复预算耗尽。

第一、第二类都不能直接要求用户点击“接受”“继续”或“显式重启”。

### 4.4 服务监督器改成当前规格优先

服务记录需要区分：

```text
历史服务事实：上一次进程是什么状态
当前服务规格：当前任务要求启动什么
当前进程事实：现在是否有属于当前规格的进程
```

启动决策改为：

```text
读取当前任务规格
→ 查找同 Workspace / serviceId 的历史记录
→ 历史记录只用于诊断和清理
→ 如果规格不同，停止旧进程并绑定新 revision
→ 如果规格相同但进程已退出，自动重新启动
→ 执行健康检查
→ 失败则把日志和退出码反馈给 Harness
```

旧 `failed` 状态不能阻断新任务。`restartPolicy: explicit` 只能表示服务生命周期的外部控制语义，不能阻止当前用户已经明确要求的首次启动或当前任务恢复。

### 4.5 Workspace 操作默认直接执行

当前 Conversation 已绑定 Workspace，且用户明确要求读、写、修改或运行时：

- 读写普通文件直接执行；
- 在授权 Workspace 内运行测试和本地程序直接执行；
- 同一任务的连续修改直接沿用当前上下文；
- 不产生“接受并交付”中间状态；
- 不要求用户理解 Task、Attempt、Publication、Retry Wake 等内部概念。

底层仍保留路径 containment、符号链接检查、进程归属和凭据隔离，但这些是系统内部约束。

只有以下情况进入用户交互：

- 用户没有说明要覆盖原文件还是另存；
- 目标 Workspace 或路径不明确；
- 请求真正不可逆的外部系统操作；
- 需要新的凭据或用户选择模型；
- Agent 已经完成自动修复预算，仍无法继续。

## 5. 分阶段实施

### 阶段 P0：建立执行闭环基线

目标是先消除重复状态机对成功执行的破坏。

实施范围：

- 新增 `Run Contract` 内部模型，统一 Planner、Runtime、Executor 输入。
- 为 Harness 增加结构化 turn/step/tool/service feedback 通道。
- 将服务启动失败的 stdout、stderr、退出码、健康检查结果写入下一轮 Harness 上下文。
- 修正 `startRequestedPublishedService()`：旧失败记录不得阻断当前任务。
- 将当前任务的服务规格、服务 revision 和历史服务事实分离。
- 建立最小自动修复循环：服务启动失败 → Harness 修复 → Runtime 重启 → 再验证。

退出条件：旧 failed 服务记录不会阻断新任务；BS 服务可在一次用户请求内生成、启动、修复和验证完成。

### 阶段 P1：收敛 Attempt、Retry 和 Task 状态

实施范围：

- 一个 Attempt 支持多个 Harness turn。
- 将“工具失败”“服务失败”“验收失败”从 Task terminal failure 改为 Harness feedback，直到预算耗尽。
- 用户再次提出同一目标时，默认在当前 Workspace 上创建新的执行轮次，自动携带最近失败诊断。
- `retry_task_attempt` 和 `retry_remaining_work` 变成内部恢复 API；普通用户不需要显式操作。
- 只有不确定外部副作用继续进入 Kernel recovery。
- 失败 Task 可以被当前明确的新用户请求自然 supersede，不要求先手动清理旧 Task。

退出条件：第一次失败后，下一轮能读取真实错误并修改代码；不会重复执行完全相同的失败命令；用户无需理解 retry 命令。

### 阶段 P2：收敛 Workspace、文件观察和交付

实施范围：

- 继续采用当前单一 In-place Workspace 方向。
- 把文件变更观察作为事实记录，不再把 publication/delivery 中间状态呈现为用户确认。
- 普通代码修改使用 Workspace 内 live file 语义。
- 明确需要稳定字节的输入、下载和跨任务 handoff 才建立 ArtifactVersion。
- `fileOutputs` 只表示用户明确要求下载/交付的文件，不作为普通 Workspace 修改的额外确认门槛。

退出条件：连续修改同一个文件不会产生多份内部副本；完成后直接展示改动文件、验证结果和运行输出。

### 阶段 P3：后续可选 Harness 适配

只有 P0/P1/P2 已经稳定后，确实需要支持 DeepSeek Harness 原生 ACP/持久 Session 时才实施：

- Pi 继续复用现有 AgentHarness session/turn 机制，不在 MetaWork 重写模型循环。
- 对支持 ACP/持久 Session 的 DeepSeek Harness，增加独立 Adapter；不把 ACP/SDK 协议逻辑嵌入 Kernel。
- 仅做协议 Adapter，映射 `prompt accepted`、`turn started`、`tool result`、`service feedback`、`agent settled` 和 `final result`。
- 恢复时优先使用 Harness continuation/session resume；不确定外部副作用仍由 MetaWork 独立核对。不得为此新增一套 MetaWork Agent 状态机。

退出条件：Pi、Codex 和 DeepSeek Harness 共享同一薄输入协议，但保留各自真实能力差异；MetaWork 不再重复实现 Agent loop。

## 6. 需要删除或收缩的现有机制

以下机制不应继续作为普通任务的默认门槛：

- 普通 Workspace 修改前的接受/交付状态；
- 旧服务 `failed` 对新任务的隐式阻断；
- 仅因为 Attempt 结束就把服务失败提升为 Task 终态；
- 把“继续未完成任务”设计成用户必须理解的内部恢复命令；
- 让 Planner 为每个微步骤重新规划；
- 让 Runtime 复制 Pi 已经具备的工具调用、模型重试和上下文循环。

需要保留的底层能力：

- Workspace 所属与路径 containment；
- ResourceLease 写入互斥；
- Executor 进程生命周期和凭据隔离；
- 未知外部副作用的 uncertainty/recovery；
- 最终文件、服务和验收结果验证；
- 结构化事件和可诊断日志。

## 7. 验收方案

### 用户目标闭环

- “写 Hello World 并保存到 Workspace”直接完成，无接受按钮。
- “把 Hello World 改成 See you later”直接修改原文件并返回文件内容。
- “运行这个程序”直接执行并返回 stdout、stderr 和退出码。
- “写一个 BS 服务并启动”生成服务、启动、健康检查并返回访问地址。

### 自动修复

- 服务第一次启动失败，Harness 读取 stderr 后修复端口/命令/代码并重新启动。
- 测试失败后，Harness 修改代码并再次运行测试。
- 旧 Task failed、旧 service failed、旧 process 已退出时，新任务仍能完成。
- 同一错误连续出现时，最终消息必须包含真实错误、已尝试的修复和下一步需要用户提供的信息。

### 交互收敛

- 普通读写、测试和本地服务启动不要求用户确认。
- 模糊覆盖目标时只问一个明确问题。
- 外部不可逆操作需要确认时，确认内容必须包含具体操作、目标和原因。
- 用户再次输入同一目标时，不要求先点击“继续未完成任务”。

### Harness 对齐

- Pi 工具失败会回到模型上下文，而不是直接终止 Task。
- Pi follow-up/steering 能继续当前执行上下文。
- Provider 临时错误使用已有自动重试能力。
- DeepSeek Harness Adapter 能区分 prompt 入队、turn 完成、工具事件和最终结果。
- Executor 完成不直接等于 MetaWork 验收完成，Runtime 仍独立验证真实 Workspace 和服务状态。

## 8. 迁移和兼容策略

1. 旧 Task、旧 Attempt、旧 publication 和旧 service record 全部保留为历史事实。
2. 新任务使用新的 Run Contract，不修改历史记录的含义。
3. 旧 `failed` 服务记录在首次访问时转换为历史诊断状态，不自动删除用户数据。
4. 旧 Worktree binding 不直接恢复到新 In-place 流程；恢复时生成新的执行上下文。
5. 现有 Kernel 事件和数据库迁移先增加兼容字段，再逐步收缩用户可见状态。
6. 只有完成 P0/P1 的回归测试后，才更新相关 ADR、`CONTEXT.md` 和技术总览。

## 9. 本次评审需要确认的架构选择

建议采用以下默认选择：

1. **保留 Planner → Work Graph → Kernel → Executor 主架构**：Planner 生成 Graph，Kernel 审核/授权 Graph，Executor 执行 Graph 中的 Subtask。
2. **保留 Kernel 的基础设施控制面职责**：负责资源、权限、配置和恢复事实，不负责普通代码执行的语义循环。
3. **以 Pi Agent Loop 作为 MetaWork Executor 的行为基线**：不重写模型/工具循环。
4. **以 DeepSeek Harness 的 Workspace、Session、Turn、Step 和事件分层作为后续适配基线**：通过 Adapter 接入，不把其运行时嵌入 Kernel。
5. **服务启动失败自动反馈并修复**：不要求用户显式重启。
6. **普通 Workspace 操作默认直接完成**：只有歧义、缺失信息、不可逆操作或自动修复耗尽才询问用户。
7. **先做 P0/P1，再决定是否接入 DeepSeek Harness ACP**：先修复 MetaWork 当前执行闭环，再增加新的 Harness 类型。

本方案获评审通过后，下一步才进入 P0 的代码设计、测试先行和 ADR/`CONTEXT.md` 更新。本轮没有修改执行代码，也没有启动新的 Server 或创建新的数据根。

## 实施记录（2026-10-27，P0 第一批）

（历史批次记录，当前状态见文档头与第四、五批。）当时状态：**评审通过，P0 第一批已实施；P0 自动修复 continuation、P1、P2 待实施**。

已交付的代码（与技术实施方案 §4.1、§4.2、§4.3 对应）：

1. **Run Contract 内部模型**：`src/execution/run-contract.ts` 提供
   `RunContractProjection`、`projectRunContract()` 和 `runContractDiagnostics()`，
   由已授权的 `SubtaskExecutionContext` + execution binding 派生；每次 Attempt 在
   `ExecutionResult.diagnostics.runContract` 中记录同一份有界视图。它只是输入与
   诊断投影，不引入新的调度权威、turn 循环或重试预算。
2. **服务身份与当前规格优先**（ADR-0051）：
   - `specificationRevision` 只 hash 启动契约，不再包含 `taskId`；
   - 服务记录按 `(account, workspace, serviceId)` 查询（`findForWorkspace()`）；
   - 同规格的旧 `failed`/`stopped` 记录只作诊断，不再阻断当前任务启动；
   - 同 Workspace 同 revision 的登记由当前 Task 接管（Kernel 与 Storage 同步放宽
     “归属不匹配”到真实的移交语义），不同 Workspace 或不同 revision 仍按原规则拒绝；
   - In-place Workspace 中上一个 Task 写下的 manifest，只有在本 Workspace 已登记
     完全相同启动契约时才被采纳。
3. **服务诊断**：`ManagedLocalServices.observe()` 返回 Runtime 专用诊断
   （workspace、revision、进程标识、退出事实、有界脱敏日志尾部、最近健康状态、
   可自助修复标记）。公开 `LocalServiceView` 保持不泄露进程标识。
4. **`startRequestedPublishedService()` 重写**：删除“发现旧记录且当前任务不是 retry
   就只执行 `status()`”的分支；始终由当前规格驱动 Kernel 授权启动/重启；未达健康时
   统一走 `handleServiceVerificationFailure()`，把真实诊断（退出事实、健康状态、
   日志尾部、revision）作为持久验证失败与用户可见原因记录；端口占用、规格冲突
   分别给出可操作文案。

验证：

- `npx tsc --noEmit` 通过。
- 聚焦测试全部通过：`tests/execution/`（102 文件）、`tests/storage/`、
  `tests/kernel/managed-service-handover.test.ts`、`tests/execution/run-contract.test.ts`。
- 新增回归：旧 failed 记录不阻断新任务、同 serviceId 跨 Workspace 隔离、服务退出
  诊断、跨 Task manifest 移交与拒绝外来 manifest、Kernel 移交授权矩阵、Run Contract
  投影与诊断边界。

P0 第二批（2026-10-27，服务修复 continuation 已实施）：

- 服务未达健康先记录 `repair_pending`，Task 保持 running（phase `retrying`），
  不再直接变成 failed。
- 产出该服务的已完成 Subtask 受控重开，Kernel 授权 `continuation` +
  `metawork:service-repair:v1` payload，最多三轮；诊断经 recovery packet 真正进入
  Executor prompt，Executor 自行修复并自测服务。
- Runtime 每轮重新验证服务；修复轮次改动启动契约时，先经 Kernel 显式 `update`
  授权绑定新 revision 再启动。
- 预算耗尽后以真实错误 + 已尝试轮数收尾，代码保留。
- Schema 60 增加 `repair_pending` 操作结论。

P1/P2 已实施（2026-10-27，第三批）：

- **P1**：一个 Attempt 内的 turn/工具/退避循环保持由 Harness 独占；失败分类按 §4.3 落地
  （可修复执行错误 → 反馈/授权续做，基础设施错误 → 既有退避，真实阻断 → 一次明确询问或
  预算耗尽后带诊断收尾）。用户再次提出同一目标时，Planner 的 `get_task_context`
  暴露结论 reason、非 success 操作结果与最近失败 Attempt，Executor 上下文通过
  `previousRound` 携带同一 Conversation/Workspace 的最近失败诊断；终态 Task 不占名额、
  不被改写，新请求自然取代它，无需 task id 或先清理旧 Task。`/task retry` 降为次要显式恢复。
- **P2**：工作区文件状态只反映文件事实，普通 In-place 完成不再出现"等待用户接受"的交付
  状态；四个 acceptance 入口复核完成（In-place 无 acceptance gate、`accept_result` 仅由
  用户命令或未认证结果触发、Web 只展示交付事实）；`fileOutputs: []` 的代码任务不要求额外
  报告文件，ArtifactVersion 仅用于下载/跨任务 handoff。
- **P3**：只做文档记录，未进入。

内部恢复与验收收尾（2026-10-27，第五批）：`retry_remaining_work` 已成为内部恢复协议
（服务修复/交付失败后自动创建续做任务，只补剩余交付与服务启动，且不再链式重试）；
§9.2 验收矩阵新增"stopped 后显式启动""规格变更须经授权 update 后启动""健康检查 503 永不伪装
成功且真实状态保留"三项覆盖，并修复了进程退出后观测清空真实 HTTP 状态的问题；
`npm run build`（含 Web）与聚焦套件通过。仍未执行：native Server 单实例检查、真实 Provider
端到端用户验收、P3 可选 Adapter。

评审修复（2026-10-27，第四批）：服务修复的授权顺序（先授权后重开、拒绝回滚）、Kernel
binding 成员校验、修复目标的服务归属证据、服务修复预算只计有效轮次、`previousRound`
的 retry 关系与“紧邻上一轮”约束、Planner 的六态枚举 / `none` 原因 / 失败 Attempt
终态集合 / account 隔离，均已按上表修复并有回归测试。
