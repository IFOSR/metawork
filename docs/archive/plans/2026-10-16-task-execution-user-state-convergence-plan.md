# 任务执行结果、验收与用户状态收敛计划

- 计划日期：2026-10-16。
- 状态：已实施（2026-10-16）；进入目标对齐 review。
- 关联方案：[任务执行可靠性统一方案](2026-10-15-task-execution-reliability-unified-plan.md)、[阻塞任务恢复操作入口](2026-10-14-blocked-task-interaction-fix.md)。
- 关联契约：[ADR-0032 结果优先交付与完成认证](../adr/0032-result-first-delivery-and-completion-certification.md)、[Task lifecycle state contracts](../current/task-lifecycle-state-contracts.md)。

## 1. 这次问题要解决什么

本次 PDF/PPT 任务暴露的是一条状态链没有闭合，而不是 Executor 没有完成：

```text
Executor 退出并写出文件
  → 完成元数据格式不完整
  → 自动修正后仍没有验收证据
  → 结果被保存，但没有完成认证
  → Subtask = awaiting_decision
  → Kernel 记录 block_work
  → 旧命令把内部事实翻译成“当前卡住”
```

其中有三个不同问题，必须分开处理：

1. **执行事实**：Executor 是否退出、是否产生了本次授权的文件或文本结果。
2. **确定性认证**：文件是否存在、路径是否安全、声明的交付物是否齐全、发布是否可进行。
3. **业务接受**：用户是否愿意接受当前安全结果作为最终交付，或要求重新执行。

Kernel 只负责前两类确定性事实和状态推进，不对报告内容做第二个模型式的质量评审。Executor 完成也不能直接等于任务完成，因为未认证的结果不能自动发布、不能释放下游依赖；但未认证也不等于任务“阻塞”。

本计划的目标是：保留内部审计和恢复事实，同时让所有产品表面只显示四种用户状态：**等待中、执行中、需要处理、已结束**。用户不再看到“阻塞”“当前卡住”或要求用户执行内部 `unblock` 的文案。

## 2. 目标状态和结果决策

### 2.1 四种用户状态

`TaskView.userState` 是 Web、Desktop、TUI、Feishu、Dashboard、CLI 的唯一状态入口：

| 用户状态 | 何时使用 | 用户能做什么 |
| --- | --- | --- |
| 等待中 | 有明确的自动推进者，例如容量名额、重试唤醒、Planner 计划或依赖尚未满足 | 查看原因，等待系统继续 |
| 执行中 | 有活动 Attempt、文件发布或交付正在进行 | 查看进度、发送消息或取消（按现有授权） |
| 需要处理 | 没有安全的自动下一步，但仍有结果确认、补材料、授权、恢复或交付动作 | 查看原因并执行唯一的下一步操作 |
| 已结束 | 成功、失败或取消已经形成终态 | 查看结果；失败可发起新的重试 |

内部 `Task.lifecycle`、Subtask `blocked`、Kernel `block_work`、Attempt `uncertain` 可以继续存在，用于决策账本、资源清理和恢复；它们不得直接成为用户标签或文案。

### 2.2 当前案例的最终投影

当前 PDF/PPT 案例应投影为：

- 用户状态：**需要处理**；
- 原因：已生成安全的 PDF/PPT，但完成认证缺少声明的验收证据；
- 操作：**接受并交付** 或 **重新执行**；
- 限制：在用户接受前，不进入正式 publication、不释放下游 Subtask、不把 Task 标记为成功；
- 不显示：`blocked`、`当前卡住`、`no runnable Subtask while work remains`。

如果没有可验证的安全结果（没有结果文件、文件路径不安全、结果不属于本次授权 Attempt，或结果已损坏），则投影为**已结束**，原因明确写为“执行失败：未生成可交付结果”，同时提供“重新执行”。这种情况不需要把用户留在一个等待内部恢复的状态。

## 3. `awaiting_decision` 的语义收敛

`awaiting_decision` 继续作为内部 Subtask 协议状态，但它不再隐含“正在等待用户”。进入该状态时必须同时写入一个持久化的 pending-decision fact，至少包含：

- 决策主体：`kernel`、`user` 或 `recovery`；
- 决策原因：`uncertified_result`、`missing_material`、`permission`、`uncertain_application` 等有限枚举；
- 可执行动作：`accept_result`、`retry_attempt`、`resume_after_input`、`resolve_recovery`；
- 结果引用、Attempt 引用和幂等键；
- 创建时间、最近提示时间和已执行动作。

只有 `decisionOwner = user` 且事实可由用户处理时，才投影为“需要处理”。Kernel 内部等待重放、恢复或清理时，若有明确自动推进者投影为“等待中”；若没有自动推进者但需要系统修复，则投影为“需要处理”，原因必须说明下一步，不得泛化为“卡住”。

## 4. 验收、接受和失败的分叉

### 4.1 Kernel 确定性完成认证

完成认证只检查可重放的事实：Attempt 身份和终态、声明的 `fileOutputs`、文件存在及路径边界、结果完整性、publication 前置条件、交付记录和下游依赖。认证失败必须返回结构化原因，例如 `completion_malformed`、`completion_acceptance_mismatch`、`missing_declared_output` 或 `unsafe_output_path`，不得只返回“无可运行 Subtask”。

### 4.2 安全未认证结果的用户接受

扩展现有 `partial_result_acceptance_requested` 路径，使安全的 `uncertified_result` 能够由用户明确选择：

- **接受并交付**：再次执行确定性文件/路径/授权检查，写入用户接受 fact，进入既有 publication 和交付链；交付成功后才释放 Subtask done、Task 完成和下游 handoff。
- **重新执行**：保留原 Attempt receipt 和原结果，创建新的受授权 Attempt；不得覆盖历史证据，不得默认重复可能已经发生的外部副作用。

“接受并交付”不能绕过安全检查，也不能把自然语言中的“看起来完成了”当成认证。用户接受的是当前结果是否可以交付，不是替 Kernel 证明文件存在或路径安全。

### 4.3 没有安全结果的失败

当没有安全、可引用的结果时，Kernel 记录失败终态并将 Task 投影为“已结束”，原因明确说明失败阶段和可重试动作。重试是新的 Attempt；历史失败 Attempt 只读保留。这样用户不会被迫理解内部恢复协议，也不会因为无结果而看到长期“需要处理”。

### 4.4 外部不确定性和交付失败

- 外部副作用是否发生不确定：投影为“需要处理”，动作是恢复核对或人工确认；禁止自动重跑。
- 文件已生成但交付失败：投影为“需要处理”，只重试 publication/delivery，不重跑 Executor。
- 依赖尚未满足且有可继续分支：依赖 Subtask 投影为“等待中”；依赖失败且没有替代分支：投影为“需要处理”，说明需重试或补材料。

## 4.5 验收责任必须分层

此前的结果优先修复已经解决了“安全业务结果不能因为完成元数据错误而丢失”，但没有完全解决验收责任混在一起的问题。本次案例正是因此暴露：Planner 写入了三个语义验收项，Executor 被要求返回 evidence；Runtime 又把同一组 evidence 复制到三个验收 key；Kernel 最后只做非空和 key 集合检查。这个检查本身很薄，但它仍把 Executor 没有提交证据表现成了整个任务不能继续。

后续必须固定以下边界：

| 层 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| Planner | 把用户目标拆成验收意图和可执行要求 | 不把自然语言质量判断变成 Kernel 可证明事实 |
| Executor | 实际完成工作，检查 PDF/PPT 内容、格式和来源，提交对每个验收意图的事实说明 | 不决定 Task、Dependency、Publication 状态 |
| Runtime | 保存原始结果和 Executor 说明；确定性检查 Attempt 身份、声明文件存在、路径安全、文件交付范围及可选格式解析事实 | 不重新评价研究结论是否正确 |
| Kernel | 检查事实是否来自本次授权 Attempt、结构是否完整、是否满足发布和下游释放前置条件，并授权状态迁移 | 不打开文档作内容评审，不判断“研究结论是否有道理” |

因此，“Kernel 薄验收”不是取消所有完成条件，而是把 Kernel 的条件限制为可重放的结构事实。对 PDF/PPT 案例：文件存在、路径安全和声明文件匹配可以由 Runtime 确认；页数、可解析性、中文显示和与上一轮研究的一致性，要么由 Executor 检查并提交事实说明，要么由独立的确定性文档检查器产生事实。Kernel 不应自行做内容判断。

当前链路的具体错位有两处：

1. `completion-correction` 是“只修元数据”的 Attempt，明确禁止重新执行、使用工具或检查文件，却仍被期待补出三个验收项的业务 evidence。它最多只能引用 Runtime 已经确认的文件事实，不能凭空补齐内容一致性证明。
2. `validateAcceptance` 只看到一个全局 evidence 数组，并将其复制到每个 acceptance key；它无法表达“哪一条证据覆盖哪一个验收意图”，也不应该被误解为已经完成了三项业务验收。

收敛方案是：初次 Executor Attempt 必须在完成工作后逐项说明检查结果；Runtime 保留这些说明并生成确定性文件事实；Kernel 只验证授权身份、证据结构和发布前置条件。若初次 Attempt 产生安全文件但没有证据，自动修正不得伪造或猜测证据，应直接保留安全结果并投影为“需要处理”，交给用户接受或重新执行。只有具备 Executor 说明或确定性检查事实时，Kernel 才能认证完成。

## 5. 实施范围和阶段

### 阶段一：冻结协议和诊断事实

1. 在 `src/task/task-view.ts`、`src/task/task-user-state.ts` 和 `src/task/task-lifecycle.ts` 固化四态投影优先级及原因枚举。
2. 为 completion certification、pending user decision、publication/delivery failure 统一结构化错误和事实引用。
3. 保留现有 `blocked` 字段和历史数据可读性，禁止新增依赖原始 `status` 的用户文案。
4. 将 `block_work` 的错误汇总保留 `awaiting_decision` Subtask 的真实原因，避免再次被泛化成无可运行节点。

### 阶段二：完成认证和用户决策闭环

1. 在 Kernel workflow 中区分 `block_work` 内部控制动作与用户状态投影。
2. 接通安全未认证结果的“接受并交付 / 重新执行”命令，使用 durable pending-decision fact 和幂等键。
3. 让接受动作经过同一套文件存在、路径安全、publication 和交付检查；接受成功前不推进 done/downstream。
4. 让无结果失败直接形成可解释终态，并提供新 Attempt 重试入口。

### 阶段三：统一所有产品表面

1. Web、Dashboard、TUI、Feishu、CLI 和 Session presentation 全部只消费 `TaskView.userState`、`userStateReason`、`nextAuthorizedAction`。
2. 清理 `blockedTasks`、`task.status === 'blocked'`、`canCancel` 和原始 Kernel phase 直接生成产品文案的路径。
3. 内部查询可以保留 `blocked` 兼容筛选和数据库字段，但返回标签统一为“需要处理”，命令帮助和按钮不再要求 `/task unblock`。
4. 将“当前卡住”“阻塞原因”“等待解除阻塞”等旧文案改为结果导向的原因和下一步，例如“结果待验收”“文件交付失败，请重试交付”“没有可继续的执行记录，请重新执行”。

### 阶段四：恢复、迁移和兼容

1. 历史 `tasks.status = 'blocked'`、旧 dependencies blocker、旧 Attempt receipt 和旧 TaskView 均继续可读；启动时只重建投影，不改写历史事实。
2. 旧任务根据现有 durable facts 映射到四态；有安全未认证结果的历史任务进入“需要处理”，无结果且失败证据完整的任务进入“已结束”。
3. 恢复只使用现有 Kernel route；不添加第二调度器、不偷偷恢复旧任务、不自动重跑不确定外部动作。
4. 完成所有表面迁移后，再删除仅用于用户显示的旧 blocked 分支；内部恢复和审计分支继续保留到兼容窗口结束。

## 6. 文件和模块边界

主要改动集中在以下所有权边界：

- `src/task/`：四态 TaskView、原因和动作投影；
- `src/kernel/`：决策账本、pending decision、完成认证拒绝和用户动作授权；
- `src/execution/`：Attempt 终态、结果引用、publication/delivery 失败和重试边界；
- `src/session/`、`src/commands/`：命令准入、统一中文文案和动作结果；
- Web/TUI/Feishu adapters：只渲染 TaskView，不自行解释原始状态；
- `tests/`：优先覆盖上述所有权边界的确定性 fixtures 和跨表面投影。

不在本计划范围内：重新设计 Planner 拆解、增加第二个内容质量评审模型、改变 Executor 权限、回写历史 Attempt、把用户接受变成自动成功，或借机删除内部恢复所需的安全事实。

## 7. 验收矩阵

### 结果和决策

- Executor 已退出且生成安全 PDF/PPT、但缺验收证据：显示“需要处理”，可查看文件并选择接受或重新执行。
- 用户接受后，文件再次通过确定性检查，publication 和交付成功，才显示“已结束/成功”。
- 用户选择重新执行，原 Attempt 和结果保留，新 Attempt 不重复未经确认的外部副作用。
- Executor 退出但没有安全结果：显示“已结束/执行失败”，原因具体，可重新执行。
- 完成元数据格式错误时保留真实错误码，不显示“无可运行 Subtask”。

### 状态和界面

- 四种 `userState` 在 Web、Dashboard、TUI、Feishu、CLI 完全一致。
- 任意用户入口都不出现“阻塞”“当前卡住”“等待解除阻塞”或内部 `unblock` 操作。
- 内部 `blocked`、`awaiting_decision`、`block_work` 仍可在审计/诊断详情中查询，但不泄漏到用户主状态。
- 用户可以在需要处理状态发送消息、查看结果和执行唯一授权动作；后台任务不会错误锁住会话。

### 恢复和安全

- publication/delivery 失败只补交付，不重新执行 Executor。
- 外部副作用不确定时不自动重跑，恢复动作幂等且有明确证据。
- 重启、重连和历史任务迁移后，投影仍由 durable facts 得出，不依赖内存标记。
- 未认证结果不会自动标记 done，也不会释放下游 handoff。

## 8. 交付门槛和审阅点

本计划先作为提案交用户审阅。确认后按四个阶段逐阶段实施，每阶段都要记录定向测试和真实端到端证据；任一阶段未通过，不把“局部测试通过”表述为整个状态收敛完成。

用户审阅时重点确认三项产品决策：

1. 本次 PDF/PPT 这类“有安全结果但未认证”的任务统一进入“需要处理”，提供“接受并交付 / 重新执行”。
2. “没有安全结果”的任务直接进入“已结束/执行失败”，保留重新执行入口。
3. “阻塞”只保留为内部事实和诊断字段，所有用户表面统一使用四种状态及具体下一步。

确认这三项后，再进入代码实施和平台验收。

## 9. 本次实施记录与目标对齐 review

已完成：

- 安全但未认证的 `execution_result_observed` 不再由 Kernel 生成最终 `block_work`；改为 durable `await_user_decision`，Runtime 将结果保留在 `awaiting_decision`，Task 进入可恢复的等待处理状态。
- `TaskView` 从 `uncertified_result` receipt 推导用户决策事实，统一投影为“需要处理”，原因明确说明“接受并交付 / 重新执行”，并暴露 `accept_result` 动作。
- 增加 `/task accept-result`，通过既有 Kernel durable control event；接受时再次验证 Attempt、safe projection、Task/Subtask/result 身份和结果完整性，随后进入既有 completion/publication 链，不重跑 Executor。
- 旧任务盘面、Task status 和 Session 状态文案不再把内部 `blocked` 直接显示为“当前卡住”或 `[BLOCKED]`；兼容字段和恢复命令仍保留用于历史数据和内部协议。
- 完成验收责任边界保持分层：Executor/Runtime 产生结果事实，Kernel 只授权结构化状态迁移与确定性接受检查。

验证：`npm run lint` 通过；完整 `npm test` 通过（552 个测试文件、3705 个测试通过，18 个文件/32 个测试按仓库既有条件跳过）；TaskView、Kernel control、Runtime recovery、声明文件交付和用户旅程定向测试均通过，Kernel 原有两项“安全结果应阻塞”的断言已按新契约改为“请求用户决策”。

剩余平台门槛：Web/Desktop/TUI/Feishu 的完整端到端截图和真实用户点击验收仍需在集成环境执行；这些表面已消费统一 TaskView 投影，内部 `blocked` 字段继续保留为诊断兼容事实。
