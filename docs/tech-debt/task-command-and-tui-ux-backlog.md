# 任务指挥、命令系统与 TUI 用户体验优化清单

> 状态：第一阶段已完成部分基础整治，后续能力待逐项实施  
> 创建日期：2026-07-13  
> 范围：命令契约、任务生命周期控制、任务队列、执行器交互、TUI/飞书展示模型  
> 用法：后续优化时按编号选择条目，完成后将 `[ ]` 更新为 `[x]`，并补充实现说明、验证命令及相关 ADR/PR。
>
> 第一阶段实现记录：层级命令树、逐层补全、现有命令可用性和执行中断整治已落地；四个可见占位及未来能力见 [pending-command-implementations.md](./pending-command-implementations.md)。

## 1. 背景与目标

MetaClaw 的定位不是普通聊天客户端，而是负责任务理解、任务拆解、策略授权、调度执行、恢复和交付的任务指挥中心。目前用户输入主要分为 Slash Command 和自然语言意图，但命令帮助、实际执行语义、任务控制能力和前端展示之间仍有不一致。

本清单的目标是：

- 让命令描述、自动补全、帮助页面和实际副作用来自同一份契约。
- 让暂停、停止、取消、恢复、重试等任务生命周期操作具有明确且可靠的语义。
- 补齐任务指挥中心常见的创建、排队、优先级、截止时间、解释、产物和事件查询能力。
- 在不绕过 PlanningAgent、PolicyKernel 和任务审计的前提下，支持用户指定或咨询执行器。
- 将 TUI/飞书从“解析输出字符串”逐步迁移为消费结构化展示事件。
- 提高新用户的可发现性，让用户始终知道当前焦点、输入模式、系统状态以及下一步可以做什么。

## 2. 现状问题清单

### 2.1 命令文案与实现漂移

- [x] **AUDIT-001** `/executor route <任务描述>` 现已作为明确的 `unavailable` 占位展示，不再伪装为已实现能力。
- [ ] **AUDIT-002** `/help` 声称自然语言可以识别“暂停”，但 `IntentTaskControl` 没有 `pause_task`。
- [x] **AUDIT-003** `/task pause <id>` 会先持久化状态，再中断该任务实际使用的 Executor。
- [x] **AUDIT-004** `/task cancel <id>` 会先持久化状态，再中断该任务实际使用的 Executor。
- [x] **AUDIT-005** `/profile`、`/learning`、`/task index rebuild|search` 等能力均由统一命令树生成帮助。
- [ ] **AUDIT-006** `/executor` 的命令说明、usage 和结果文案大量使用英文，与整体中文界面不一致。
- [x] **AUDIT-007** 规范入口 `/task attach <taskId> <resource...>` 统一使用“资源”表述。
- [x] **AUDIT-008** 已移除用户入口 aliases 和隐式默认动作，缺参、未知节点和相似建议由 CommandCatalog 统一处理。

### 2.2 当前前端展示限制

- [x] **AUDIT-009** 主 TUI 已支持目录、子命令、枚举和动态引用的逐层 Tab 补全。
- [ ] **AUDIT-010** 当前运行面板只展示任务数量、当前任务和最近事件，缺少阶段、进度、耗时、队列位置、阻塞原因和下一步。
- [ ] **AUDIT-011** 用户无法持续看到当前焦点是普通对话还是某个任务。
- [ ] **AUDIT-012** 用户无法明确知道当前输入处于普通意图、任务 follow-up、Executor 向导或未来的执行器咨询模式。
- [ ] **AUDIT-013** TUI 通过字符串前缀判断输出类型，文案变化可能影响渲染分类。
- [ ] **AUDIT-014** 命令执行结果通常缺少结构化的状态变化、影响范围和推荐下一步。
- [ ] **AUDIT-015** 危险操作缺少统一的确认交互和影响预览。

## 3. 命令契约与命令目录

### 3.1 建立唯一命令契约

- [ ] **CMD-001** 引入结构化 `CommandSpec`，至少描述：
  - 命令名与 aliases。
  - 分类和一句话摘要。
  - 支持的命令形式与 usage。
  - 每种形式的实际效果。
  - 示例。
  - 风险等级。
  - 是否会改变任务状态。
  - 是否会中断 Executor。
  - 是否会自动重新调度。
- [x] **CMD-002** `/help` 从 CommandCatalog 命令树动态生成。
- [x] **CMD-003** TUI Slash Command 建议来自同一 CommandCatalog。
- [x] **CMD-004** 支持 `/help <commandPath...>` 查看任意目录或叶子。
- [x] **CMD-005** CommandCatalog 统一处理缺参、未知节点、usage 和相似建议。
- [ ] **CMD-006** 统一命令类别，例如：任务、队列、执行器、记忆、学习、配置和全局操作。
- [ ] **CMD-007** 统一面向用户的中文术语；内部名可在高级信息中保留。

### 3.2 深化命令模块

- [x] **CMD-008** Session 已改用封装 `complete/describe/execute/listActions` 的 CommandCatalog。
- [x] **CMD-009** task 动态引用按操作允许状态过滤，并在手输无效 ID/状态时返回原因。
- [x] **CMD-010** TUI 只消费 CommandCatalog 返回的补全状态、候选和 replacement range。
- [ ] **CMD-011** 将 `CommandResult.data` 的临时对象逐步替换为可判别联合类型，避免调用方按可选字段猜测结果。

### 3.3 命令契约测试

- [ ] **CMD-012** 每个命令契约中的示例都必须可以被 Router 正确解析。
- [ ] **CMD-013** `/help` 中展示的每个命令和子命令都必须有真实处理分支。
- [ ] **CMD-014** 所有已注册命令都必须出现在命令目录和帮助输出中。
- [ ] **CMD-015** 状态改变命令必须测试实际 Task 状态、Executor 中断和调度副作用，而不只断言输出字符串。
- [ ] **CMD-016** 对 TUI 命令建议、参数提示和状态相关可用性增加回归测试。

## 4. 任务生命周期语义修正

### 4.1 明确 pause、stop、cancel、clear

- [ ] **LIFE-001** 正式定义 `pause/stop`：中断当前执行、保存恢复快照、将任务转为 `parked`、允许后续恢复。
- [ ] **LIFE-002** 正式定义 `cancel`：中断当前执行、将任务转为 `cancelled`、默认不可恢复，但保留审计记录。
- [x] **LIFE-003** `/task clear` 按范围持久化取消，并中断受影响 running task 的实际 Executor。
- [x] **LIFE-004** `/task pause <id>` 会中断该任务的全部 active execution。
- [x] **LIFE-005** `/task cancel <id>` 会中断该任务的全部 active execution。
- [x] **LIFE-006** Executor 返回后重新检查任务状态，迟到结果不会覆盖用户设定状态。
- [ ] **LIFE-007** 中断时记录：用户操作、原状态、新状态、执行器、执行轮次、中断原因和恢复入口。
- [x] **LIFE-008** 当前语义固定为中断目标 Task 的全部 active execution，不影响其他任务。

### 4.2 自然语言与命令语义对齐

- [ ] **LIFE-009** 扩展 `IntentTaskControl`，评估加入 `pause_task`、`cancel_task`、`retry_task`、`set_priority` 和 `set_focus`。
- [ ] **LIFE-010** PlanningAgent、Plan Schema、Plan Validator、PolicyKernel 和 Runtime 必须使用同一套任务控制词汇。
- [ ] **LIFE-011** `/help` 只描述 PlanningAgent 正式支持且有测试覆盖的自然语言能力。
- [ ] **LIFE-012** 对缺少明确目标的“暂停”“取消”“恢复”请求，若不能唯一绑定任务，应要求澄清而不是猜测。

## 5. P0 常用指令

### 5.1 显式创建任务

- [ ] **CORE-001** 新增 `/new <目标>`，显式创建并规划一个任务。
- [ ] **CORE-002** 支持规范形式 `/task new <目标>`，`/new` 作为快捷入口。
- [ ] **CORE-003** 支持可选参数：优先级、截止时间、固定 Executor、资源和是否包含最近对话上下文。
- [ ] **CORE-004** 已有 running task 时，新任务默认进入队列或要求用户选择，不再简单拒绝。

### 5.2 状态查询

- [ ] **CORE-005** 新增 `/status`，复用现有 Dashboard/TaskStatus 展示模块。
- [ ] **CORE-006** 支持 `/status running|blocked|queue|<taskId>`。
- [ ] **CORE-007** 将 `/dashboard` 保留为全局盘面命令，并考虑让 `/status` 成为更易发现的入口或别名。

### 5.3 可靠停止

- [ ] **CORE-008** 新增 `/stop [taskId]`，默认作用于当前 running task。
- [ ] **CORE-009** `/stop` 必须执行 Executor 中断、任务快照、状态转换和 Runtime 清理。
- [ ] **CORE-010** `/stop` 完成后展示明确恢复入口，例如 `/resume <taskId>`。

### 5.4 取消、恢复和重试

- [ ] **CORE-011** 增加 `/cancel [taskId]` 作为针对当前焦点/指定任务的快捷命令。
- [ ] **CORE-012** 增加 `/resume [taskId]` 作为针对 parked/blocked task 的快捷命令。
- [ ] **CORE-013** 新增 `/retry <taskId>`，创建新的 execution attempt，保留原失败记录。
- [ ] **CORE-014** `/retry` 支持指定 Executor、从失败 subtask 重试和补充恢复说明。

### 5.5 当前焦点

- [ ] **CORE-015** 新增 `/focus <taskId|conversation|none>`。
- [ ] **CORE-016** 明确定义 focus 对自然语言 follow-up、`/attach` 默认目标和最近上下文的影响。
- [ ] **CORE-017** 切换 focus 后在前端持续展示当前焦点，而不只输出一次结果。

## 6. P1 任务指挥中心指令

### 6.1 队列控制

- [ ] **QUEUE-001** 新增 `/queue`，展示 running、ready、parked、blocked 和预计下一个任务。
- [ ] **QUEUE-002** 展示队列顺序、等待时间、优先级、调度原因和当前不可执行原因。
- [ ] **QUEUE-003** 支持 `/queue top <taskId>` 或 `/queue move <taskId> top`。
- [ ] **QUEUE-004** 支持 `/queue move <taskId> before <otherTaskId>`，前提是 Scheduler 具有明确稳定的人工排序信号。
- [ ] **QUEUE-005** 评估队列整体 pause/resume 能力，并与单任务 pause 区分。

### 6.2 优先级与截止时间

- [ ] **QUEUE-006** 新增 `/priority <taskId> normal|high|urgent [原因]`。
- [ ] **QUEUE-007** 优先级变化必须真实影响 Scheduler，而不只是修改展示字段。
- [ ] **QUEUE-008** 新增 `/deadline <taskId> <时间|clear>`。
- [ ] **QUEUE-009** 时间解析后展示绝对时间和时区，避免只保存模糊的“明天”。

### 6.3 决策解释

- [ ] **OBS-001** 新增 `/explain [taskId]`。
- [ ] **OBS-002** 解释任务为何被选择、为何被阻塞、为何使用当前 Executor、为何排在当前队列位置。
- [ ] **OBS-003** 将 PlanningAgent reason、PolicyKernel decision、Scheduler reason 和恢复策略组织为用户可理解的摘要。

### 6.4 产物和事件

- [ ] **OBS-004** 新增 `/artifacts [taskId]`，展示产物路径、类型、来源 Executor、验证状态和创建时间。
- [ ] **OBS-005** 新增 `/events [taskId] [--last N]`，展示结构化任务时间线。
- [ ] **OBS-006** 将 `/executor route-feedback` 定位为高级诊断入口，普通用户优先使用 `/explain` 和 `/events`。
- [ ] **OBS-007** 新增 `/archive <taskId>` 和适当的批量归档能力，保留历史和检索能力。

## 7. P2 指定执行器与直接咨询

### 7.1 正式派发任务

- [ ] **EXEC-001** 新增 `/dispatch <executor> <目标>`。
- [ ] **EXEC-002** `/dispatch` 必须创建或继续正式 Task/Execution Attempt，不得直接绕过任务运行时调用 Executor。
- [ ] **EXEC-003** `/dispatch` 仍需经过 PolicyKernel、任务准入、审计、材料注入和结果持久化。
- [ ] **EXEC-004** 支持 `/dispatch <executor> --task <taskId> <后续目标>`，作为指定执行器的 follow-up。
- [ ] **EXEC-005** Executor 不存在、不可用或能力不匹配时，给出可选执行器和原因。

### 7.2 咨询执行器

- [ ] **EXEC-006** 在具备可靠只读约束后新增 `/ask <executor> <问题>`。
- [ ] **EXEC-007** `/ask` 默认不创建正式任务、不修改任务状态、不写文件。
- [ ] **EXEC-008** 支持 `/ask <executor> --task <taskId> <问题>`，向指定执行器提供关联任务上下文。
- [ ] **EXEC-009** 为 `/ask` 建立 Adapter 级只读模式、只读 workspace 或等价的副作用限制；不能只依赖提示词承诺只读。
- [ ] **EXEC-010** `/ask` 结果必须记录为 interaction，并标记咨询 Executor、关联任务和权限模式。

### 7.3 执行器交接

- [ ] **EXEC-011** 新增 `/handoff <taskId> <executor> [说明]`。
- [ ] **EXEC-012** handoff 应创建新的执行轮次或 follow-up subtask，不覆盖历史执行记录。
- [ ] **EXEC-013** 新 Executor 应接收前一执行器结果、失败原因、材料、快照和用户补充说明。

### 7.4 产品约束

- [ ] **EXEC-014** 不提供绕过 PlanningAgent、PolicyKernel、Task Persistence 和 Execution Runtime 的“裸 Executor 聊天通道”。
- [ ] **EXEC-015** 前端明确区分：普通对话、执行器咨询、正式任务派发和任务交接。

## 8. TUI 与用户展示优化

### 8.1 命令面板与参数提示

- [ ] **UI-001** 输入 `/` 时按命令分类展示建议，而不是只按固定优先级平铺。
- [x] **UI-002** Tab 每次只补全光标所在的一层/token。
- [x] **UI-003** 当前输入位置会展示参数说明、枚举或动态候选。
- [x] **UI-004** task 候选按操作允许状态过滤；无候选时展示所需参数/状态说明。
- [ ] **UI-005** 命令建议中区分安全查询、状态修改和危险操作。

### 8.2 当前焦点和输入模式

- [ ] **UI-006** 输入区域持续展示当前焦点：普通对话、指定任务或无焦点。
- [ ] **UI-007** 输入区域持续展示当前模式：意图理解、任务 follow-up、Executor 注册向导、执行器咨询等。
- [ ] **UI-008** 明确告诉用户当前自然语言输入预计会聊天、创建新任务还是继续当前任务。
- [ ] **UI-009** Executor 注册向导展示当前步骤、总步骤、取消方式和已收集信息摘要。

### 8.3 运行状态面板

- [ ] **UI-010** 当前任务展示 Executor、执行阶段、当前 subtask、运行时间和进度。
- [ ] **UI-011** 展示 ready 队列中的前若干任务及其优先级和顺序。
- [ ] **UI-012** 展示 blocked task 的原因以及用户需要补充的材料或条件。
- [ ] **UI-013** 展示 parked task 的暂停原因和恢复入口。
- [ ] **UI-014** 最近事件应选择用户可理解的重要事件，不应简单使用任意最后一条日志。
- [ ] **UI-015** 运行中持续展示可执行快捷操作，例如 `/stop`、`/status <id>` 和 `/events <id>`。

### 8.4 结果和下一步

- [ ] **UI-016** 所有状态改变结果都展示 `原状态 → 新状态`。
- [ ] **UI-017** 展示是否已停止 Executor、是否保存快照、是否重新调度。
- [ ] **UI-018** 所有任务结果都提供一组结构化 Suggested Actions。
- [ ] **UI-019** 阻塞结果展示阻塞原因、缺少条件和可复制的恢复命令。
- [ ] **UI-020** 完成结果展示摘要、产物和 follow-up 入口。
- [ ] **UI-021** 失败结果区分可重试失败、需要补充材料、执行器不可用和不可恢复错误。

### 8.5 危险操作确认

- [ ] **UI-022** 为 `/tasks clear all`、取消 running task、批量归档和高风险 dispatch 建立统一确认模型。
- [ ] **UI-023** 确认前展示影响任务数量、running task、将被终止的 Executor 和是否可恢复。
- [ ] **UI-024** 支持显式 `--yes` 用于脚本模式，同时交互模式默认要求确认。
- [ ] **UI-025** 确认状态必须是结构化 Session State，不再通过输出字符串判断是否等待确认。

### 8.6 新会话和空状态

- [ ] **UI-026** 新会话为空时展示自然语言、新建任务和状态查询示例。
- [ ] **UI-027** 存在未完成任务时，启动页优先展示可恢复、阻塞和高优先级任务。
- [ ] **UI-028** 启动建议提供可执行命令，而不只显示描述性文字。
- [ ] **UI-029** 明确提示 `/` 打开命令面板、`/help` 查看详细帮助、方向键查看历史。

### 8.7 术语和语言

- [ ] **UI-030** 默认用户界面统一使用中文。
- [ ] **UI-031** 默认展示使用“执行器类型”“执行实例”“执行轮次”等用户术语，高级诊断中再展示 AgentClass/WorkUnit 等内部名。
- [ ] **UI-032** 统一任务状态中文标签：排队中、执行中、已暂停、已阻塞、已完成、已取消、已归档。
- [ ] **UI-033** 对 `blocked` 区分“等待材料”“等待权限”“等待外部服务”等用户可理解的原因类别。

## 9. 结构化展示模型

### 9.1 替换字符串分类

- [ ] **VIEW-001** 将 `SessionSnapshot.output: string[]` 逐步迁移为结构化 `SessionViewEvent[]`。
- [ ] **VIEW-002** 至少定义：用户输入、规划进度、上下文召回、任务状态变化、Executor 进度、结果、警告、命令结果和确认请求。
- [ ] **VIEW-003** 删除或缩小 TUI `classifyOutputLine()` 对具体中文文案和符号前缀的依赖。
- [ ] **VIEW-004** 结构化事件携带 taskId、executorName、timestamp、severity 和 suggestedActions 等必要字段。

### 9.2 统一跨渠道展示

- [ ] **VIEW-005** 由 `SessionPresentationService` 或新的展示模块负责生成稳定 ViewModel。
- [ ] **VIEW-006** TUI、飞书和未来 Web UI 消费同一套结构化语义，各自只负责渠道渲染。
- [ ] **VIEW-007** 渠道适配器不再通过字符串匹配识别任务状态、结果块和队列块。
- [ ] **VIEW-008** 为结构化 View Events 增加序列化兼容策略，避免持久化或 Gateway 升级时破坏历史消息。

### 9.3 扩充 Session ViewModel

- [ ] **VIEW-009** 当前运行任务增加：阶段、开始时间、耗时、Executor、当前 subtask、进度和执行轮次。
- [ ] **VIEW-010** 队列项增加：标题、状态、顺序、优先级、等待时间和调度原因，而不只暴露 ID。
- [ ] **VIEW-011** blocked/parked 项增加原因、下一步和建议命令。
- [ ] **VIEW-012** Session Snapshot 增加当前焦点、当前输入模式和 pending confirmation/wizard 等结构化状态。

## 10. 调度与准入配套调整

- [ ] **SCHED-001** 重新评估“单一活动任务准入”与任务指挥中心队列需求的关系。
- [ ] **SCHED-002** 区分“禁止同时运行多个顶层任务”和“禁止在运行中创建待执行任务”；后者应考虑放开。
- [ ] **SCHED-003** 新任务在已有 running task 时默认进入 ready 队列，并明确展示排队原因。
- [ ] **SCHED-004** urgent task 不应隐式抢占；应通过明确策略决定排队、询问用户或中断当前任务。
- [ ] **SCHED-005** 人工优先级、截止时间、blocksOthers 和系统语义优先级必须有清晰的排序规则。
- [ ] **SCHED-006** Scheduler 对人工调整记录审计事件，`/explain` 可以解释最终顺序。

## 11. 验证要求

### 11.1 功能测试

- [x] **TEST-001** CommandCatalog 已覆盖 parser、help、completion、execute 和完整叶子集合一致性测试。
- [x] **TEST-002** running task 的 pause/block/cancel/complete/clear 已覆盖 active execution abort 回归测试。
- [ ] **TEST-003** 为迟到 Executor 结果与取消/暂停竞态增加回归测试。
- [ ] **TEST-004** 为新任务进入队列、优先级调整和队列重排增加 Scheduler 测试。
- [ ] **TEST-005** 为 `/dispatch`、`/ask`、`/handoff` 的审计和权限边界增加测试。
- [ ] **TEST-006** 为结构化 Suggested Actions 和危险确认状态增加 Session/TUI 测试。
- [ ] **TEST-007** 为飞书与 TUI 使用同一 View Event 的关键场景增加一致性测试。

### 11.2 验证命令

涉及 TypeScript 的修改至少运行：

```powershell
npm run lint
```

由于本项目的 SQLite 和 POSIX 路径测试不能可靠运行在 Windows Host，完整测试必须在 Docker 中运行：

```powershell
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
```

涉及 TUI、CLI 或 Gateway 行为时，在 PR/实现记录中附带终端输出或截图。

## 12. 推荐实施顺序

### 阶段 A：统一契约和修复错误描述

- [ ] 完成 `AUDIT-001` 至 `AUDIT-008`。
- [ ] 完成 `CMD-001` 至 `CMD-016`。
- [ ] 修复 `/help`、自动补全和实际处理分支之间的漂移。

### 阶段 B：修复任务中断语义

- [ ] 完成 `LIFE-001` 至 `LIFE-008`。
- [ ] 完成 `/stop`、可靠 `/cancel` 和可靠 `/task pause`。
- [ ] 增加中断竞态和迟到结果测试。

### 阶段 C：补齐最常用命令

- [ ] 完成 `/new`、`/status`、`/retry` 和 `/focus`。
- [ ] 让 running 状态下的新任务可以进入队列。

### 阶段 D：升级任务指挥能力

- [ ] 完成 `/queue`、`/priority`、`/deadline`、`/explain`、`/artifacts`、`/events` 和 `/archive`。

### 阶段 E：升级前端体验

- [ ] 完成子命令补全、输入模式、当前焦点、状态面板、Suggested Actions 和危险确认。
- [ ] 逐步迁移到结构化 Session View Events。

### 阶段 F：指定和咨询执行器

- [ ] 先完成 `/dispatch`。
- [ ] 建立可靠只读运行能力后再完成 `/ask`。
- [ ] 最后完成 `/handoff` 和跨执行器上下文交接。

## 13. 暂不包含的范围

以下内容不应在没有独立设计和验收标准时顺带实现：

- 不受约束、绕过任务与策略运行时的原始 Executor Shell/Chat。
- 无审计记录的强制状态修改。
- 默认自动抢占当前 running task 的 urgent 调度。
- 仅通过颜色和字符串前缀表达状态的临时 UI 补丁。
- 为每个操作增加一个一级命令、导致命令面板无限扩张；常见入口可以是别名，规范能力应尽量收敛到 `/task`、`/queue` 和 `/executor` 等领域命令下。
