# TUI 用户可见输出技术债清单

- 状态：持续收集，尚未进入实现
- 建档日期：2026-07-14
- 当前范围：只记录问题、复现、原因与代码位置，不在本文档建档阶段修改实现

本文档用于逐项记录 TUI 中会直接影响用户体验的问题。每个问题在进入修复前，应先确认真实数据流、根因、影响面、已有测试约束和未来验收标准。

## TUI-OUTPUT-001：执行器内部过程被完整展示给用户

- 状态：已完成（2026-07-15）
- 实施计划：`docs/plans/2026-07-15-tui-output-001-executor-final-result.md`
- 结果：executor 过程输出不再进入共享会话；Codex 最终消息通过显式文件协议读取；每个 subtask 只显示一次最终结果，TUI 动画留在动态区域，飞书消费相同最终结果协议。

### 用户观察

任务运行期间，TUI 会持续输出大量蓝色内容，例如：

- MetaClaw 注入给执行器的任务说明、恢复上下文和会话上下文；
- 执行器的中间分析、工具调用相关文本和命令行过程输出；
- 文件扫描结果、长篇报告正文和其他增量 stdout/stderr；
- `tokens used` 等执行器统计信息；
- 执行器最终回答。

这些内容均带有类似 `Executor: codex-cli｜#task_...` 的前缀。终端自动换行后，一部分续行看起来没有前缀，但仍属于同一条执行器进度输出。

### 期望行为

用户可见的蓝色执行器区域只展示执行器最终结果，并且只展示一次。以下内容不应进入用户对话记录：

- 系统提示、任务提示和恢复上下文；
- 工具调用及工具返回的中间过程；
- 推理过程、调试日志和普通增量 stdout/stderr；
- token 统计等命令行运行元数据。

运行中仍可保留简短且稳定的状态提示，例如“执行中”，但具体呈现方式需要在修复设计阶段确定。错误、权限请求和真正需要用户处理的阻塞信息不能被静默隐藏。

### 结论

蓝色内容不是独立、结构化的“MetaClaw 与执行器对话”。它是 MetaClaw 将执行器命令行输出转换成普通字符串进度行后，写入共享会话输出形成的混合流。其中可能同时包含：

1. MetaClaw 构造并注入的上下文，被执行器命令行输出回显；
2. Codex CLI 的人类可读运行过程；
3. 工具与文件操作过程；
4. 最终回答和运行统计。

TUI 没有识别这些内容的语义，只要行以执行器进度前缀开头，就会将其归类为 `agent` 并显示为蓝色。

### 最小复现与已有测试约束

已在 Docker 测试镜像中运行：

```text
docker run --rm metaclaw-test npx vitest run tests/tui/execution-progress.test.ts -t "shows execution preparation and executor progress lines while a task is running"
```

结果：1 个测试通过。

该测试目前明确断言以下执行器中间状态必须出现在 `app.lastFrame()`：

- `已启动 codex-cli 执行器`
- `正在检索市场份额数据`

因此，当前不符合用户预期的行为不仅存在于实现中，也被已有测试固定为 UI 合同。未来修复时必须同步调整这项测试，不能只改渲染颜色或局部隐藏文本。

### 已确认的数据流

```text
Codex CLI 人类可读 stdout/stderr
  -> CommandLineExecutorAdapter 逐块读取并拆成文本行
  -> formatExecutorProgress 仅过滤少量已知噪声
  -> ExecutorProgressEvent(kind: status | log)
  -> ExecutionProgressService 添加 Executor 前缀
  -> SessionExecutionCoordinator.appendOutput
  -> SessionSnapshot.output（共享用户输出）
  -> TUI classifyOutputLine(kind: agent)
  -> blueBright 渲染
```

最终结果还有一条独立路径：完整 `stdout.trim()` 被作为 `execution.output` 返回，再由交付服务生成任务结果。也就是说，当前架构可能同时展示增量过程和最终结果；非文件型任务还可能再次展示整段原始 stdout。

### 根因

根因不是单一的 TUI 配色问题，而是执行层到会话层之间缺少有类型的可见性边界：

- 内部审计事件、临时运行状态、工具过程和用户最终结果都被降级为普通字符串；
- `ExecutionProgressService` 将每条进度直接写入用户共享输出，没有独立的瞬时状态或内部事件通道；
- Codex 适配器消费的是人类可读 CLI 输出，没有使用结构化事件或显式的“最后一条消息”结果接口；
- `formatExecutorProgress` 是少量噪声的拒绝列表，任何未命中的提示、上下文、报告正文和统计信息都会穿透；
- TUI 只能根据字符串前缀着色，无法判断一行是否应当展示给用户；
- 最终交付路径与进度路径彼此独立，无法保证最终结果只显示一次。

更深层的设计债是：当前共享的 `output: string[]` 同时承担了用户对话记录、运行进度展示和部分执行审计三个职责。

### 代码位置

| 位置 | 当前职责与问题 |
| --- | --- |
| `src/executor/codex-args.ts`：`buildCodexNonInteractiveArgs` | 以普通 `codex exec` 人类可读模式运行；没有启用结构化输出或显式提取最后消息。 |
| `src/executor/codex-cli.ts`：`CodexCliAdapter` | 直接继承通用命令行适配器，没有 Codex 专用的事件解析与最终结果提取。 |
| `src/executor/command-line-adapter.ts`：`execute`、`emitProgressLines`、`flushProgressBuffer` | 将 stdout/stderr 的几乎每个文本行发送为 `onProgress`，同时又把完整 stdout 作为最终 `output` 返回。 |
| `src/executor/error-utils.ts`：`formatExecutorProgress` | 只过滤少量已知噪声；其余任意执行器文本原样进入进度流。 |
| `src/execution/execution-progress-service.ts`：`createTracker` | 给每个事件添加 `Executor:` 前缀并无条件调用 `appendOutput`，把内部进度写入用户输出。 |
| `src/session/session-execution-coordinator.ts`：`execute` | 将进度追踪器直接连接到会话 `callbacks.appendOutput`，没有单独的内部事件或瞬时状态通道。 |
| `src/session/session-execution-coordinator.ts`：`handleSuccessfulExecution` | 成功后又将 `execution.output` 交给最终交付路径，形成与进度输出并行的第二条展示路径。 |
| `src/delivery/verification-and-delivery-service.ts`：`buildCompletionLines` | 文件任务省略正文，但非文件任务可直接追加完整 `execution.output`；无法确认其中是否只是最终回答。 |
| `src/tui/app.tsx`：`classifyOutputLine`、`getLineColor` | 仅把 `Executor:` 前缀归为 `agent` 并染成蓝色，不负责语义过滤。 |
| `tests/tui/execution-progress.test.ts` | 当前明确断言执行器中间状态应出现在用户可见 TUI，需要在修复时反转这一合同。 |
| `tests/execution/execution-progress-and-workspace-services.test.ts` | 当前覆盖进度被追加到输出的行为；未来需拆分“审计被保留”与“用户不可见”两个断言。 |

### 影响与风险

- 严重干扰正常对话，最终结果容易淹没在大量过程文本中；
- 内部提示、恢复上下文和偏好信息可能不必要地暴露给终端用户，具有隐私和安全边界风险；
- 输出量随任务复杂度增长，降低 TUI 可读性并增加渲染压力；
- 字符串前缀已经进入共享会话输出，因此只在 TUI 组件中隐藏会留下被污染的持久化记录，也可能继续影响网关或通知渠道；
- 如果直接在执行器入口丢弃所有进度，又可能破坏技能事件、证据记录、故障诊断和真正需要用户响应的阻塞信息。

### 非约束性的修复方向

后续设计应优先建立数据边界，而不是继续增加字符串过滤规则：

1. 将执行器事件区分为内部审计、瞬时状态、用户动作请求、错误和最终结果；
2. 尽可能使用 Codex 的结构化输出，或显式提取最后一条 assistant 消息；
3. 保留工具和技能事件用于审计、证据和调试，但不写入用户对话输出；
4. TUI 运行中只消费紧凑的瞬时状态，完成后只追加一次最终结果；
5. 在会话层定义统一可见性规则，避免 TUI、网关和通知渠道各自维护字符串黑名单。

这里列出的方向不代表已经选定实现方案。

### 未来验收标准

- 用户可见 TUI 中不出现任务提示、恢复上下文、工具调用过程、普通 stdout/stderr 或 token 统计；
- 执行器最终回答清晰展示且只出现一次；
- 运行中仍有简短状态反馈，不会表现为无响应；
- 错误、权限请求和需要用户决策的阻塞信息仍能可靠显示；
- 内部进度、技能事件和证据仍可供审计与诊断，但不会污染用户会话记录；
- 文件型和非文件型任务均遵守相同的最终结果可见性规则；
- 多 work unit、多执行器和任务恢复场景不会串流或重复最终结果；
- TUI、脚本模式、网关和通知渠道的可见性行为有明确且一致的测试；
- 原有 `tests/tui/execution-progress.test.ts` 改为断言中间过程不可见、最终结果可见；
- 增加包含提示回显、工具过程、token 统计和最终回答的适配器回归样本，验证最终结果提取不会依赖脆弱的文本黑名单。

### 修复前仍需决策的问题

- 紧凑运行状态是否写入滚动记录，还是只在固定状态区域瞬时显示；
- 不同执行器的“最终结果”由统一协议提供，还是由各适配器负责提取；
- 哪些错误属于内部可重试事件，哪些必须立即展示给用户；
- 多个 work unit 分别有最终结果时，用户看到逐项结果还是聚合后的单一结果；
- 历史持久化输出是否需要迁移或仅从新会话开始应用新可见性规则。

## TUI-OUTPUT-002：MetaClaw 将规划与授权决策过程展示给用户

- 状态：已完成（2026-07-15）
- 2026-07-15 实机补充：TUI-OUTPUT-001 已验证通过，Executor 过程输出已消失；本项现在可独立聚焦 MetaClaw、PlanningAgent、PolicyKernel、Runtime 与 Work Unit 的用户可见投影。
- 完成记录：已按 [TUI-OUTPUT-002 实施计划](../plans/2026-07-15-tui-output-002-metaclaw-output-simplification.md) 从共享 session 输出移除内部规划、授权、召回细节与 Work Unit 过程；保留蓝色阶段标题、实际 Executor 选择、Executor 最终结果、绿色完成汇报和可操作的 clarification/reject 提示。Docker 全量回归通过。

### 用户观察

用户输入简单问候“你好”后，TUI 当前显示：

```text
【MetaClaw｜理解用户请求】
→ MetaClaw：正在分析目标、上下文与可执行边界
→ MetaClaw：已识别普通对话
→ MetaClaw：执行策略：直接回答，不创建任务
→ MetaClaw：由 PlanningAgent 直接作答
-> PlanningAgent: recognized conversation turn
-> PolicyKernel: accept (direct reply authorized)
你好！有什么需要我帮你处理的？
```

中间的白色内容描述了 MetaClaw 内部的意图识别、规划器分支、授权结果和运行策略。它们对普通用户没有行动价值，并显著增加每轮对话的视觉噪声。

### 期望行为

相同输入只展示请求阶段标题和最终答复：

```text
【MetaClaw｜理解用户请求】
你好！有什么需要我帮你处理的？
```

以下内部过程不进入用户可见对话：

- `正在分析目标、上下文与可执行边界`；
- 意图分类结果，例如“已识别普通对话”；
- 内部执行策略，例如“直接回答，不创建任务”；
- PlanningAgent 的分支说明；
- PolicyKernel 的 outcome、reason 和授权细节。

本项首先以 `direct_reply` 普通对话为明确场景。任务创建、任务控制、澄清和拒绝分支也使用相同的内部进度格式化入口，后续设计需要统一区分必要的用户提示与内部诊断，不能简单删除所有错误或澄清信息。

### 2026-07-15 实机截图补充：任务执行场景

在真实 Docker SSH TUI 中，TUI-OUTPUT-001 修复后的输出已经形成清晰的三层结果：

1. 蓝色 Executor 最终结果是正确输出，应完整保留；
2. 绿色 MetaClaw 任务完成汇报、摘要、下一步和产物路径是正确输出，应保留；
3. Executor 最终结果之前仍存在大量白色内部决策与调度文本，需要由 TUI-OUTPUT-002 收敛。

#### 应保留的执行前状态

执行前只保留蓝色阶段标题，例如：

```text
【MetaClaw｜理解用户请求】
【Executor: codex-cli｜派发准备】
【MetaClaw｜提取最近历史记录上下文】
【MetaClaw｜构建执行上下文】
【MetaClaw｜执行上下文准备完成】
```

Executor 选择是唯一允许保留的白色说明。它需要让用户知道 MetaClaw 实际选择了哪个执行器：

```text
→ Executor: codex-cli 将处理该任务
```

该说明应继续由 Executor 派发准备块承载，不需要同时显示 PlanningAgent、PolicyKernel 或 Runtime 的选择依据。

#### 应隐藏的白色内部输出

除上述 Executor 选择说明外，截图红框中的其他白色文本都不应进入用户可见会话，包括但不限于：

- MetaClaw 的意图分类结果和执行策略，例如“已识别可执行任务”“创建可追踪任务并派发给 codex-cli”；
- PlanningAgent 的 plan 类型或结果，例如 `proposed executable work graph`；
- PolicyKernel 的授权结果、数量和原因，例如 `accept (work graph authorized)`、`authorized 1 subtask(s)`；
- Runtime 的候选路由、复杂度判断和派发说明；
- 任务创建诊断行；
- 上下文召回数量、构建进度和执行准备说明；
- `[Planner: dispatch] ...` 调度行；
- `Work Unit ... started` 生命周期行。

目标投影示例：

```text
【MetaClaw｜理解用户请求】
【Executor: codex-cli｜派发准备】
→ Executor: codex-cli 将处理该任务
【MetaClaw｜提取最近历史记录上下文】
【MetaClaw｜构建执行上下文】
【MetaClaw｜执行上下文准备完成】
【Executor: codex-cli｜最终结果｜#task_x / #subtask_y】
<Executor 最终回答>
✓ 任务完成 (...)
<MetaClaw 最终汇报与产物信息>
```

本次补充只确认截图红框内的决策与调度文本边界。截图中未框选的“不确定记忆”和“任务队列前五”面板是否继续展示，不在这次补充中作新决定。

### 最小复现与已有测试约束

已在 Docker 测试镜像中运行：

```text
docker run --rm metaclaw-test npx vitest run tests/tui/conversation-routing.test.ts -t "handles simple conversation without creating a task"
```

结果：1 个测试通过，耗时约 2.34 秒。

该测试当前明确断言普通对话页面必须包含以下过程文本：

- 请求理解阶段；
- 已识别普通对话；
- 直接回答、不创建任务；
- 由 PlanningAgent 直接作答；
- 最终直接回复。

因此截图中的冗余信息是被已有 TUI 测试固定的当前行为，不是终端渲染异常。未来回归测试需要保留标题和最终回复的正向断言，并将所有中间决策行改为反向断言。

### 已确认的数据流

```text
用户提交自然语言
  -> MetaclawSession.handleNaturalLanguageInput
  -> MetaclawSession.handlePlanningKernelDecision
       -> appendOutput("【MetaClaw｜理解用户请求】")
       -> appendOutput("正在分析目标、上下文与可执行边界")
       -> PlanningAgent.plan
       -> PolicyKernel.authorizeDirectReply / decide
  -> KernelDecisionApplier.apply
       -> recordPlanningDecision（独立审计记录）
       -> formatKernelProgress
       -> callbacks.appendOutput（白色决策过程）
       -> callbacks.deliverDirectReply
  -> MetaclawSession.deliverDirectReply
       -> appendOutput（最终用户答复）
       -> recordInteraction（只记录最终答复）
  -> SessionSnapshot.output
  -> TUI classifyOutputLine
  -> system/context 行渲染
```

### 根因

该问题由两个连续的展示决策造成：

1. `handlePlanningKernelDecision` 在调用规划器之前，把标题和“正在分析”同时写入共享会话输出；
2. `KernelDecisionApplier.apply` 在每一种 kernel decision 上都无条件调用 `formatKernelProgress`，再把生成的内部诊断行写入同一个共享会话输出。

`formatKernelProgress` 名义上是 progress formatter，实际同时暴露了领域内部结构、英文诊断字符串和授权原因。它没有用户可见性级别，也没有区分可操作提示与审计信息。

最终答复并不依赖这些过程行：`direct_reply` 会通过 `deliverDirectReply` 单独追加 `plan.response.directReply`。规划决策也不依赖 UI 文本保存：`KernelDecisionApplier.recordPlanningDecision` 已经将 plan、decision、outcome 和 reason 写入 `planning_decisions` 审计记录。ADR 0014 要求保留这条审计边界，但没有要求将审计细节展示给用户。

因此，问题的本质仍然是“内部事件”和“用户投影”共用字符串输出，而不是规划与授权过程本身不应存在。

### 代码位置

| 位置 | 当前职责与问题 |
| --- | --- |
| `src/session/metaclaw-session.ts`：`handlePlanningKernelDecision` | 在规划开始前同时追加保留标题与应隐藏的“正在分析”文本，随后调用 PlanningAgent 和 PolicyKernel。 |
| `src/session/kernel-decision-applier.ts`：`apply` | 先持久化规划决策，再无条件把 `formatKernelProgress` 返回的全部文本追加到用户输出。 |
| `src/session/kernel-decision-applier.ts`：`formatKernelProgress` | 为 `direct_reply`、`plan_work_graph`、`task_control` 等分支拼装内部规划、授权与运行策略文本。截图中的大部分白色内容直接来自这里。 |
| `src/session/metaclaw-session.ts`：`deliverDirectReply` | 单独追加真正的用户答复，并将最终答复记录为 interaction；证明最终交付不需要依赖决策过程文本。 |
| `src/session/metaclaw-session.ts`：`appendOutput` | 将标题、内部过程和最终回复无差别推入同一个 `output` 数组并通知订阅方。 |
| `src/tui/app.tsx`：`classifyOutputLine` | 将请求理解标题归为 `context`，其余箭头行及未匹配行归为 `system`；只负责样式，不知道哪些内容是内部审计。 |
| `tests/tui/conversation-routing.test.ts` | “handles simple conversation without creating a task” 当前正向断言冗余过程文本必须出现。 |
| `docs/adr/0014-planning-agent-policy-kernel-boundary.md` | 要求 direct reply 仍经过 kernel 构造的 decision 并写审计记录；不要求在用户 UI 中展示 decision 细节。 |
| `docs/adr/0012-persistent-planner-subtask-runtime.md` | 明确 `MetaclawSession.output` 只是 UI projection，不是规划恢复或任务状态的事实来源，为精简投影提供了架构依据。 |

### 影响与风险

- 简单问候也产生多行系统输出，破坏正常聊天的轻量感；
- 暴露 `PlanningAgent`、`PolicyKernel`、decision outcome 和 reason 等内部实现词汇，增加用户理解成本；
- 中英文内部诊断混排，产品呈现不一致；
- 用户容易把内部授权结果误认为需要关注或响应的状态；
- 所有 decision 分支共用 formatter，若直接整体删除，可能一并隐藏澄清、拒绝、任务控制结果或执行派发中的必要反馈；
- 如果只在 TUI 按字符串过滤，共享输出仍会保留噪声，其他会话渠道仍可能看到相同内容。

### 非约束性的修复方向

后续设计可以将 `KernelDecisionApplier` 的职责拆成两个投影：

1. 始终保留结构化 `planning_decisions` 审计记录；
2. 根据 decision 类型生成最小的用户可见结果，而不是输出完整内部推理轨迹。

对于 `direct_reply`，用户投影已经明确：保留 `【MetaClaw｜理解用户请求】`，随后直接展示 `plan.response.directReply`。运行中的临时状态如确有需要，应使用独立的瞬时状态通道，不写入滚动对话。

这里不预先规定其他 decision 类型的最终文案，也不代表已经选定实现方案。

### 未来验收标准

- 输入“你好”时，用户可见输出包含且只包含请求理解标题与最终答复；
- 不显示“正在分析”、意图分类、执行策略、PlanningAgent 说明或 PolicyKernel outcome/reason；
- `planning_decisions` 仍完整记录 plan、decision、outcome 和 reason；
- `recordInteraction` 仍只记录用户输入与最终直接答复；
- direct reply 不创建任务，也不调用 executor，现有语义保持不变；
- 现有 TUI 用例改为断言标题和最终回复可见、全部中间过程不可见；
- 对 clarification、reject、task control 和 plan work graph 分别增加测试，确保用户必须处理的信息不会随内部诊断一起消失；
- TUI、脚本模式、网关和通知渠道对内部决策信息采用一致的可见性规则。

### 修复前仍需决策的问题

- `【MetaClaw｜理解用户请求】` 是每轮都持久显示，还是未来改成瞬时阶段状态；
- 对任务型请求，用户需要看到哪些简短阶段反馈，例如“任务已创建”或“正在执行”；
- clarification 和 reject 的用户文案由 plan、kernel decision 还是独立 presentation 层负责；
- 是否建立统一的结构化 presentation event，彻底移除依赖字符串前缀的渠道过滤。

## TUI-OUTPUT-003：二级命令 group 被错误显示为带斜杠的一级命令

- 状态：已完成（2026-07-15）
- 完成记录：已按 [TUI-OUTPUT-003 实施计划](../plans/2026-07-15-tui-output-003-command-suggestion-slashes.md) 将斜杠层级规则统一收口到 `CommandCatalog`。根级 group/action 带 `/`，nested group/action 不带 `/`；TUI 直接渲染 Catalog label，与 Tab replacement 保持一致。Docker 全量回归通过。

### 用户观察

在 TUI command 建议菜单中，同一级候选的斜杠格式不一致：

```text
/executor
  list
  show
  /register
  unregister
  feedback

/learning
  candidates
  approve
  reject
  promote
  skill-feedback
  /patch
```

`/register` 和 `/patch` 看起来像新的一级全局命令，但它们实际只能作为 `/executor register ...` 和 `/learning patch ...` 的二级路径使用。

### 期望行为与语法规则

命令建议应遵守统一且与 command tree 层级一致的规则：

1. 只有根级全局命令 token 带 `/`，例如 `/executor`、`/learning`、`/config`；
2. 根命令之后的 command path 节点都不带 `/`，无论该节点是可执行 action 还是仍有 children 的 group；
3. action 的位置参数、可选参数和动态引用也不带 `/`；
4. Tab 补全写入编辑器的文本必须与菜单展示遵守同一规则。

期望菜单为：

```text
/executor
  list
  show
  register
  unregister
  feedback

/learning
  candidates
  approve
  reject
  promote
  skill-feedback
  patch
```

### 对“命令实现是否仍未统一”的结论

命令的定义、路径解析、补全、参数校验、`/help` 和执行目前确实统一使用 `CommandCatalog` 与 `src/commands/command-tree.ts`。当前代码没有把 `/register` 或 `/patch` 注册成另一套扁平一级命令，也不是旧 alias 与新 command tree 同时生效。

但统一只完成到了命令语义层，展示契约仍被拆在两处：

- `CommandCatalog.nodeSuggestion` 根据节点的 `kind` 生成 label；
- TUI 的 `formatCommandSuggestionLabel` 又根据 replacement 的位置决定是否补 `/`。

因此可以概括为：command tree 已统一，command suggestion 的层级展示语义尚未统一。

### 最小复现

临时诊断用例直接调用真实的 `createDefaultCommandCatalog().complete()` 和真实的 `formatCommandSuggestionLabel()`，分别检查 `/executor ` 与 `/learning ` 的二级候选是否以 `/` 开头。Docker 结果稳定失败：

```text
/executor  -> expected [], received ["/register"]
/learning  -> expected [], received ["/patch"]
```

2 个用例均在约 2.29 秒内失败。临时诊断文件在采集结果后已删除，没有作为实现改动保留。

现有永久测试也已单独运行：

```text
docker run --rm metaclaw-test npx vitest run tests/tui/editor-submission.test.ts -t "shows the slash for a root command suggestion without changing nested suggestions"
```

结果：1 个测试通过。该测试只使用二级 action `show` 验证“不增加斜杠”，没有使用二级 group，因此无法发现 `/register` 和 `/patch` 的异常。

### 已确认的数据流

```text
src/commands/command-tree.ts
  -> executor group
       -> register group
            -> wizard action + fallback action
  -> learning group
       -> patch group
            -> candidates / approve / promote actions
  -> CommandCatalog.complete
  -> CommandCatalog.nodeSuggestion
       -> group label = "/" + node.name（不检查层级）
       -> replacement 仅在 start === 0 时增加 "/"
  -> MetaclawSession.completeCommand
  -> TUI getCommandSuggestions
  -> formatCommandSuggestionLabel
       -> 只给根级 replacement 补斜杠
       -> 已带斜杠的 nested group label 原样返回
  -> command 建议菜单
```

### 根因

`CommandCatalog.nodeSuggestion` 当前使用下面的展示规则：

```text
group  -> label 带 /
action -> label 不带 /
```

这条规则把“节点是否还有 children”错误等同于“节点是否是根命令”。实际上，`group` 表示路径还能继续向下解析，并不表示它一定在 command tree 根级。

`register` 是 group，因为它既支持 fallback action `/executor register <executorName>`，又包含 `wizard` 子节点；`patch` 是 group，因为它包含 `candidates`、`approve` 和 `promote`。所以它们被统一的 catalog 错误加上 `/`。同级的 `list`、`show`、`candidates` 等是 action，因而没有 `/`。

与此同时，`nodeSuggestion.replacement.text` 已经正确使用 `replacement.start === 0` 判断根级：根 token 才写入 `/name`，二级 token 写入 `name`。这会造成 suggestion 的展示 label 与实际 Tab replacement 不一致。

TUI 最近增加的 `formatCommandSuggestionLabel` 解决了根级 action（例如 `/config`）缺少斜杠的问题：当 replacement 从 0 开始且 replacement text 带 `/` 时，它为 label 补 `/`。但该函数不会移除 catalog 已经错误添加给 nested group 的 `/`，所以修复根 action 后仍留下截图中的二级 group 问题。

### 代码位置

| 位置 | 当前职责与问题 |
| --- | --- |
| `src/commands/command-tree.ts`：`executorNodes` | `register` 正确建模为 nested group，包含 `wizard` child 和注册 fallback action；定义本身没有多余 `/`。 |
| `src/commands/command-tree.ts`：`learningNodes` | `patch` 正确建模为 nested group，包含 Patch 治理 actions；定义本身没有多余 `/`。 |
| `src/commands/command-tree.ts`：`createDefaultCommandCatalog` | 只注册 `/executor`、`/learning` 等根节点，没有注册扁平 `/register` 或 `/patch`。 |
| `src/commands/catalog.ts`：`CommandCatalog.complete` | 根据已解析 group 的 children 生成当前层候选，说明二级菜单仍来自同一棵 command tree。 |
| `src/commands/catalog.ts`：`CommandCatalog.nodeSuggestion` | 以 `node.kind === 'group'` 决定 label 是否加 `/`，忽略节点深度，是直接根因。replacement 却以 `start === 0` 判断根级。 |
| `src/tui/app.tsx`：`formatCommandSuggestionLabel` | 根据 replacement 判断根级并为根 action 补 `/`，但对 catalog 已带 `/` 的 nested group label 原样返回。 |
| `src/tui/app.tsx`：`applyCommandSuggestion` | 使用 replacement text，而非 label；因此菜单文字与 Tab 实际插入内容可能不一致。 |
| `tests/commands/catalog.test.ts` | 覆盖 root/child suggestion 的 `value` 和 replacement range，但没有断言 group label 的层级格式。 |
| `tests/tui/editor-submission.test.ts` | 覆盖根级 action `/config`、根级 group `/task` 和二级 action `show`，没有覆盖 nested group。 |
| `docs/current/technical-overview.md` | 明确 TUI 补全、`/help`、校验和执行应来自同一个 `CommandCatalog`，且旧扁平入口和 aliases 不再注册。 |

### 影响与风险

- 用户会误以为 `/register`、`/patch` 是可以独立执行的一级命令；
- 菜单 label 与 Tab 实际 replacement 可能不一致，削弱补全行为的可预测性；
- 任何未来新增的 nested group 都会自动复现相同问题；
- 只对 `register` 和 `patch` 做字符串特判会掩盖通用层级模型缺失，并在新增 group 时再次回归；
- catalog 与 TUI 同时承担斜杠展示规则，未来修改其中一侧容易再次产生根 action 或 nested group 的格式分歧。

### 非约束性的修复方向

后续应把“是否为根级 token”作为 suggestion 的唯一斜杠依据，不能使用 `group`/`action` 类型推断层级。可考虑：

1. catalog 输出规范化的 suggestion，其中 label 与 replacement 都由节点路径深度生成；
2. 或 catalog 只输出结构化层级信息，由统一 presentation formatter 生成 label 与 replacement；
3. 移除 catalog 与 TUI 两处重复的斜杠推断，确保同一规则同时服务菜单和 Tab 补全。

这里不预先选择具体实现方案。

### 未来验收标准

- 根级 group 和 action 均以 `/` 展示，例如 `/task`、`/config`；
- 所有二级及更深层 group/action 均不以 `/` 展示，例如 `register`、`patch`、`wizard`、`approve`；
- 菜单 label 与 Tab 写入编辑器的 replacement text 在同一层级上保持一致；
- `/register` 和 `/patch` 不会被解析或暗示为独立全局命令；
- `/executor register ...`、`/executor register wizard` 和 `/learning patch ...` 的执行语义保持不变；
- catalog 层增加 root group、root action、nested action、nested group 四种结构的表格化测试；
- TUI 层使用真实默认 catalog 覆盖 `/executor ` 与 `/learning `，而非只手工构造单个 `show` suggestion；
- 新增任意 nested group 时无需增加专门字符串规则即可自动得到无斜杠标签。
