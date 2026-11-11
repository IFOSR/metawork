# MetaWork Pi TUI 系统命令与 AI 任务分离设计

> Status: Completed
> Design date: 2026-08-28
> Review completed: 2026-08-28
> Implementation completed: 2026-08-29
> Review owner: Product / Architecture
> Governing decisions: ADR-0020, ADR-0031, ADR-0034

## 1. 目标

继续使用 `planner/AnyFusion-Pi` 中现有的 `@earendil-works/pi-tui`，只解决：

1. 系统命令与用户提交给 AI 的对话/任务必须明确分开。
2. 修复当前 TUI 中已经复现的基础交互 Bug。

不更换 TUI package，不迁移 TUI，不重构 Server/Client 架构，不改变 Web 体验。

## 2. 当前问题

真实 TUI 测试结果：

| 输入 | 耗时 | 是否进入 Planner | 当前展示 |
| --- | ---: | --- | --- |
| `/help` | 102 ms | 否 | 错误显示完整六阶段 |
| `/task list` | 81 ms | 否 | 错误显示完整六阶段 |
| `/does-not-exist` | 96 ms | 否 | 错误显示完整六阶段 |
| `/config` | 99 ms | 否 | 错误显示完整六阶段 |
| 普通自然语言 | 12.7 s | 是 | 显示真实 Planner/Kernel 过程 |

系统命令实际上没有被 Planner 解析。问题是 Gateway 和 TUI 把它包装、展示成了 AI
任务。

现有 `turn_started.payload.commandKind` 已经能够区分：

```text
user_message
slash_command
permission_resolution
cancel_turn
```

因此不需要新增 Gateway 事件或升级协议。

## 3. 两类交互

### 3.1 AI 对话或任务

只有 `commandKind === 'user_message'` 属于 AI 对话或任务：

```text
用户输入 -> Planner -> Kernel -> Executor（按需）-> 验证 -> 最终结果
```

它继续展示真实发生的理解、规划、授权、执行、验证和交付阶段，以及安全执行轨迹、
权限请求、Subtask 和结果。

### 3.2 系统命令

以下都属于系统命令或系统操作：

- `/help`、`/config`、`/workspace`、`/task list` 等 slash command；
- Client 本地处理的 `/exit`、`/conversations`；
- `/approve`、`/deny` 对应的权限决定；
- 取消操作。

系统命令必须：

- 不进入 Planner；
- 不显示六阶段任务进度；
- 不显示“最终结果”或“结果已验证”；
- 不等待当前 Conversation 中无关的后台任务；
- 直接显示紧凑的命令结果或命令失败。

成功示例：

```text
你
/task list

命令结果
当前没有正在执行的任务
```

失败示例：

```text
你
/does-not-exist

命令失败
未知命令：does-not-exist
输入 /help 查看可用命令
```

`/task resume` 等命令可以快速返回操作结果；被恢复任务后续产生的执行状态仍通过
现有 Runtime 事件正常更新。

## 4. 最小改动

### 4.1 Gateway

保留现有 Gateway v2 事件。只调整等待策略：

```ts
awaitAsyncWork: mailboxCommand.command.kind === 'user_message'
```

系统命令仍等待命令 handler 本身完成，包括校验、查询和持久化，但不再等待整个
Conversation 的 `backgroundWork`。

### 4.2 Pi TUI reducer

在现有 ViewModel 中增加两种 interaction：

```ts
type MetaWorkInteractionKind = 'system_command' | 'ai_turn';
```

分类规则：

```ts
commandKind === 'user_message' ? 'ai_turn' : 'system_command'
```

- `ai_turn` 继续使用现有 `MetaWorkTurnView`。
- `system_command` 只保存 running/completed/failed、命令输出和错误。
- result 和 terminal error 根据 interaction kind 写入对应视图。
- replay 与 live event 必须得到相同分类。

### 4.3 Pi TUI view

- 系统命令只渲染“命令执行中/命令结果/命令失败”。
- AI 输入继续渲染六阶段和最终结果。
- 类型必须来自 reducer，不通过解析输出文本猜测。

## 5. 同步修复的 Bug

本次同时关闭以下已复现问题：

- Orca 等 Terminal 中 Enter 无法稳定提交。
- 系统命令可能等待无关后台任务。
- 两条重复的 `connected` 状态。
- 新请求仍被旧命令结果占据主视区。
- 长命令输出导致 Composer 不可见或难以使用。
- `/conversations` 打开、选择、新建或 Esc 返回后焦点不稳定。
- 默认界面不必要地突出 Conversation/Task ID 或内部错误。
- reconnect/replay 后历史命令被误认为当前 AI Turn。

修复限定在现有 `pi-tui`、Gateway、reducer、view 和 selector 中，不演变为 TUI
重写。

## 6. Web 兼容

Web Client 不改页面、组件、样式和交互。本次不删除或改名现有 Gateway 事件，也不
减少 payload。

根仓库测试必须证明：

- `user_message` 的现有语义事件和结果保持不变；
- slash command 仍提供 Web 当前可消费的 result/final payload；
- Server 返回的信息仍是 Web 展示需求的超集；
- Web production build 通过，`web/src` 没有生产改动。

## 7. 验收标准

- `/help`、`/config`、`/task list` 和无效命令不调用 Planner。
- 系统命令只显示命令结果/失败，不显示 AI 六阶段。
- 系统命令不等待无关后台任务。
- 普通输入仍显示真实 Planner、Kernel、Executor 和最终结果。
- `/approve`、`/deny` 和取消操作按系统操作展示。
- Enter 在 Orca、Apple Terminal 和常见标准 Return 输入下可用。
- 长输出下 Composer 仍可见、可输入。
- `/conversations` 返回后焦点恢复到 Editor。
- 连接状态只显示一次。
- 80 列窄屏、中文宽字符和 reconnect/replay 不破坏展示。
- Web 现有行为无回归。

## 8. 决策结论

保留现有 `pi-tui` 和 Gateway v2，只通过已有 `commandKind` 区分系统命令与 AI
对话/任务，修正系统命令等待策略，并修复已复现的基础交互 Bug。

## 9. 交付记录

本设计已于 2026-08-29 完成落地。交付行为包括：

- Gateway 仅为 `user_message` 等待 Conversation 语义异步工作；系统命令仍等待自身 handler 完成，但不等待无关后台任务。
- Pi TUI reducer/view 以 `commandKind` 稳定分类 `system_command` 与 `ai_turn`，系统命令独立投影命令输出/错误，不创建或污染 AI Turn。
- `/help`、`/config`、`/task list`、无效 slash command、权限决定、取消操作以及本地系统操作不显示 AI 六阶段、最终结果或结果验证；无效命令以“命令失败”展示。
- 修复终端尺寸、长输出 viewport、Composer 可见性、连接状态去重、selector 焦点/内部标识展示、replay/live 隔离和 Orca/标准 Return 输入交互问题。
- Web Client 生产代码保持不变；Web session identity 与 Workspace authorization principal 解耦，保留既有 Gateway v2 事件和 payload。

自动化验证已通过：根仓库 `npm run lint`；Gateway/Session/Catalog/Web runtime/Workspace 聚焦测试 61 tests；Pi TUI 全套 694 tests；Pi coding-agent 聚焦测试 43 tests；`npm --prefix planner/AnyFusion-Pi run build:offline`；`npm run build --prefix web`；并确认 `git diff -- web/src` 无生产代码变更。

真实验收已通过：80x24 TUI 中系统命令仅显示命令结果/失败，普通只读请求显示真实 Planner/Kernel 生命周期和“结果已验证”，selector 返回后 Editor 焦点恢复，`/exit` 不停止 Server；最新 Web bootstrap/session、Workspace API、WebSocket diagnostics 均成功，`/help` 未产生 trace/execution 事件，普通只读请求产生 Planner trace、结果交付事件、`result_completed(certification=certified)` 和 `final_answer`。

### 9.1 2026-08-29 后续修正

补充真实验收发现：`/task resume` 这类系统命令可以快速返回命令回执，但后台
Task/Executor 仍在继续运行。原实现把命令回执误当作任务终态，导致后续执行 trace
在 Pi 客户端被过滤，Web 也提前结束并持久化回合。

本次修正保持 Gateway v2 和严格 Completion Protocol 不变：

- `ConversationSession` 在启动后台执行前先登记工作，消除命令完成判断竞态。
- `final_answer` 在确有后台工作时携带 `backgroundWorkPending`，只表示命令回执已返回，
  不表示 Task 已完成。
- `trace_delta` 携带安全的 Task trace 状态与完成时间；Web/TUI 将命令输出和后台
  Executor/Subtask 投影并行展示。
- Web 历史回合保存 `interactionKind`，系统命令不再被渲染成普通 AI 最终答案；
  `completion_malformed` 仍保持 fail-closed，并以执行失败/校验失败状态呈现。
- `/task resume` 的命令回执以首个权威 Kernel Decision 为准：只有
  `resume_task` 才显示“恢复执行已开始”；`no_op`、`block_work` 或
  `park_for_replan` 必须明确说明没有启动新的 Executor，并保留 Kernel 原因。
  Guidance 也只在 Kernel 实际授权 resume 后生成，不能用“上下文已恢复”掩盖
  `running Task has no exact recoverable Subtask`。

本次修正验证：根仓库 lint、Gateway/Session/Web runtime 59 个聚焦测试、Web production
build、Planner TUI 客户端 32 个聚焦测试、Planner 离线 build 均通过。

权威 resume 回执的追加验证：121 个根仓库 Session、Gateway/Web、Kernel/recovery、
startup recovery 聚焦测试及 32 个 Planner TUI 测试通过；生产构建和安装级
`metawork build` 通过。真实 Web 对同一 `awaiting_decision` 天气任务再次执行
`/task resume`，页面明确显示 `resume has no recoverable Subtask`、未启动新的
Executor，且保留原 attempt 的完整历史过程和详情入口。

Closing commits: `22f2a2d`, `4ea15dd`, `600db39`, `aeaa585`, `e554bac`.
