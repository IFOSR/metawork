# 会话任务卡片替换为 DAG：设计 + 实施计划

- 状态：已实施（本地验证），等待用户网页确认
- 计划日期：2026-11-11
- 实施日期：2026-11-11

## 实施记录（2026-11-11）

已按第 6 节 1→8 步完成：

1. `web/src/task-dag.ts`：卡片推导（`collectExecutionCards`、`executionCardState`、`settleTerminalStep`、
   `preparationStatus`、`activityStatusFor`、耗时与健康标签）原样迁出，行为不变；新增
   `taskDagNodeDetails()`（节点级 执行器·模型 / 当前步骤 / 耗时）与 `taskDagSummary()`（头部
   「当前阶段 · 已完成 x/y」）。
2. `web/src/components/TaskDagPanel.tsx`：会话任务 DAG，支持 `workGraph` 预载或按 `taskId` 自取；
   规划期（无 Task）与读取中各有占位文案；节点点击回调 `onSelectSubtask`。
3. `web/src/components/WorkGraphDiagram.tsx`：新增可选 `nodeDetail`，在节点内渲染状态、执行器·模型、
   当前步骤与耗时；`work-graph-layout.ts` 节点尺寸随之调整为 268×148（轨迹 DAG 同样生效）。
4. `ObservedConversationView`：最新 Turn 渲染 `TaskDagPanel`（`latest || turnIsLive`），历史 Turn 的
   `TurnExecutionRecap` 改为 `!latest && !turnIsLive`，同一 Turn 不再出现两份 DAG。
5. `TrajectoryView`：删除 `LiveExecutionPanel`（Execution Summary）及其 `executionTraceEvents` /
   `onOpenSubtaskDetail` 入参；`WorkGraphPanel`、Summary、Narrative、Timeline、EventTable 保留。
6. `ExecutionDetailDrawer`：无执行事件时显示「尚未开始」+ 计划事实（目标、当前状态、所需能力、验收标准）。
7. 清理：删除 `LiveExecutionPanel.tsx`、未被引用的 `ConversationView.tsx` 及卡片专属 CSS
   （保留 LivePlanningPanel 复用的面板外壳与 `execution-card` 基础样式）。
8. 文档：本节 + `docs/current/technical-overview.md` 的 Web 呈现说明。

验证：`npx tsc --noEmit`（src + web）通过；`npm run build` 通过；`npx vitest run tests/web` 58 文件
374 项全通过。轨迹浏览器 E2E（opt-in）中的卡片选择器已改为 `.task-dag-panel` / `.work-graph-diagram-node`，
未在本机运行。
- 范围：仅 Web 呈现层。删除重复的任务执行卡片，用 DAG 作为任务视图；不改执行契约、不改存储、不新增后端接口

## 1. 目标

1. 会话里的任务执行卡片换成 DAG，且**任务进行中就能看到** DAG（不再只有完成后展开轨迹才可见）。
2. 轨迹页删掉重复的 Execution Summary 卡片，保留轨迹里现有的 DAG。
3. 卡片上的信息与交互（执行器/模型、当前步骤、耗时、进度、阻塞原因、点开看执行详情）迁移到 DAG。
4. 全站不再有第二份任务卡片视图。

非目标（本轮明确不做）：

- 不做 Manager → Router → Executor 的核心数据流转图。
- 不新增后端投影/接口（原方案的 `GET /api/execution/tasks/:taskId/flow` 取消）。
- 不改 Router / Executor / 交付执行逻辑，不改 Task 状态机，不引入第二套状态推导，不加动效。

## 2. 现状（已核实）

| 位置 | 组件 | 现状 |
| --- | --- | --- |
| 会话 · 最新 Turn | `web/src/components/ConversationView.tsx:118` → `LiveExecutionPanel` | 只有任务执行卡片（`LIVE EXECUTION`），DAG 不可见 |
| 会话 · 历史 Turn | `TurnExecutionRecap`（`ObservedConversationView.tsx:459`）→ `WorkGraphPanel` | 折叠后是 DAG，保留 |
| 轨迹页 | `web/src/components/TrajectoryView.tsx:55` → `LiveExecutionPanel`（完成态标题为 `EXECUTION SUMMARY`） | 与下方 DAG 重复，需删除 |
| 轨迹页 · DAG | `web/src/components/TrajectoryView.tsx:60` → `WorkGraphPanel` | 保留不动 |
| 轨迹页 · 其余 | `TrajectorySummary` / `ExecutionNarrative` / `TrajectoryTimeline` / `TrajectoryEventTable` | 保留不动 |

现有数据源（复用，不新增）：

- DAG 结构与节点状态：`GET /api/execution/tasks/:taskId/work-graph` → `WorkGraphPresentationProjection`（`src/management/work-graph-presentation-projector.ts`），节点含 `status` / `executionState` / `dependencies` / `schedulingDetail` / `routing` / `rejectedCandidates`。
- 阶段与尝试：`ExecutionTimeline`（`src/management/execution-projector.ts`），`execution` 阶段带 `SubtaskCard` 与 attempt 进度。
- 轨迹事件：`GET /api/conversations/:id/view/trace/:turnId`（事件已不带 status）。
- 抽屉：`ExecutionDetailDrawer`，由 `use-workspace-controller` 的 `executionDetail{subtaskId, subtaskTitle, turnId, turn?}` 打开；`LiveExecutionPanel` 现在的 `onSelectSubtask` 就是它的入口。

卡片内每子任务的状态/步骤推导逻辑（`LiveExecutionPanel` 的 `collectExecutionCards` 一族函数：`stateFromTraceEvent`、`activityStatusFor`、`executionCardState`、`settleTerminalStep`、`preparationStatus`、耗时格式化）是这批信息唯一的来源，必须原样保留并迁移，不能重写语义。

## 3. 已确认的产品决策

1. 会话里 DAG **只画最新 Turn**；历史 Turn 继续使用现有的折叠 DAG（`TurnExecutionRecap`）。
2. 卡片顶部原 `LIVE EXECUTION / EXECUTION SUMMARY` 一行，替换为一行「当前阶段 + 整体进度（完成 x/y）」。
3. 轨迹页要删的「任务卡片」仅指那个 Execution Summary 面板；轨迹的 `ExecutionTimeline` 属时间线，保留。
4. 未派发的子任务节点也可点击，抽屉只显示计划信息（目标、验收、所需能力、绑定候选）并标注「尚未开始」，不伪造执行事实。
5. 不做流转图；每个 Turn 只保留一份 DAG（同一 Turn 不得同时出现主 DAG 与 Recap DAG）。

## 4. 设计

### 4.1 会话：最新 Turn 的 DAG

- 位置：`ConversationView` 中最新 Turn 的 `LiveExecutionPanel` 槽位。
- 数据：`work-graph` 投影（结构/依赖/节点状态）+ `ExecutionTimeline`（attempt、执行器/模型、步骤、耗时）+ trace（阻塞原因、最近进度），与卡片同源。
- 节点信息分层：
  - 主行：子任务标题 + 状态徽标（未开始 / 等待依赖 / 执行中 / 阻塞 / 已完成 / 失败）
  - 次行：执行器 · Provider/Model、当前步骤、已耗时
  - 角标：等待或阻塞原因（`schedulingDetail` 等既有事实）
  - 依赖：连线；并行根节点并排；线性依赖纵向排列
- 头部一行：`当前阶段：<阶段> · 已完成 x/y`（如「Executor 执行中 · 已完成 1/3」）；已完成的 Turn 显示「已交付 · 产物 n 个」。
- 状态表达：仅静态色与描边，无动画（上一轮已移除脉冲动画，保持）。
- 无 Task 的窗口期（只有 Manager 规划、proposal 未准入）：显示一行「Manager 正在规划」占位，不渲染空 DAG。
- 空图但已有 Task：显示「等待派发」，不隐藏整个区块。

### 4.2 节点交互

- 点击节点 → 现有 `ExecutionDetailDrawer`（`onSelectSubtask(subtaskId, subtaskTitle)`）。
- 已派发：展示 attempt、进度、事件与结果（现有抽屉能力，不改）。
- 未派发：抽屉显示计划信息并标注「尚未开始」。实现方式：抽屉已有 subtask 信息与 timeline 上下文，仅在无 attempt 时补一段「尚未开始」说明与计划字段，不新增接口。

### 4.3 轨迹页

- 删除 `TrajectoryView` 中的 `LiveExecutionPanel`（即那张 Execution Summary 卡片）。
- 保留 `WorkGraphPanel` DAG、`TrajectorySummary`、`ExecutionNarrative`、`TrajectoryTimeline`、`TrajectoryEventTable`。
- 轨迹 DAG 仍沿用现有组件与交互，不改。

### 4.4 会话历史 Turn

- `TurnExecutionRecap` 保持折叠入口与 `WorkGraphPanel` 内容不变。
- 同一 Turn 只能出现一处 DAG：最新 Turn 由主 DAG 呈现时，Recap 不再渲染其 DAG（保留收起状态的「执行计划与子任务」入口文案，或者直接不渲染该 Turn 的 Recap，按实现时更简单者，默认：最新 Turn 不渲染 Recap 的 DAG 内容）。

## 5. 数据契约变更

无。DAG 只用现有 `work-graph` 投影、`ExecutionTimeline` 与 trace 事件；不新增端点、不改存储写入、不改服务端投影。

## 6. 实施步骤

1. **抽出纯推导模块**：把 `LiveExecutionPanel` 内的 `ExecutionCard` 推导（`collectExecutionCards`、`stateFromTraceEvent`、`activityStatusFor`、`executionCardState`、`settleTerminalStep`、`preparationStatus`、耗时格式化）移到 `web/src/task-dag.ts`，签名与语义保持不变，`LiveExecutionPanel` 改为引用（此步保证行为可对照）。
2. **新增 DAG 组件** `web/src/components/TaskDagPanel.tsx`：输入 `turn` / `workGraph` / `timeline` / `nowMs`，输出节点+连线+头部一行「当前阶段 · 完成 x/y」，节点点击回调 `onSelectSubtask`。
3. **接入会话**：`ConversationView` 用 `TaskDagPanel` 替换最新 Turn 的 `LiveExecutionPanel`；无 `taskId` 时显示规划占位。
4. **去重**：最新 Turn 不再渲染 `TurnExecutionRecap` 的 DAG 内容（历史 Turn 不变）。
5. **轨迹清理**：`TrajectoryView` 删除 `LiveExecutionPanel`，其余区块不动。
6. **抽屉补未开始态**：`ExecutionDetailDrawer` 对无 attempt 的子任务显示「尚未开始」与计划字段。
7. **删除卡片渲染**：移除 `LiveExecutionPanel` 的卡片渲染路径与仅卡片使用的 CSS；确认无残留引用后删除该组件文件。
8. **文档**：本计划补完成记录；`docs/current/technical-overview.md` 的 Web 呈现说明更新为「会话=最新 Turn DAG，轨迹=DAG + 时间线，无任务卡片」；`CONTEXT.md` 仅在涉及不变量时改（本轮不改执行契约，默认不动）。

## 7. 测试

- `tests/web/task-dag.test.ts`：纯推导模块迁移后的断言（节点状态、步骤、耗时、阻塞原因、settle 规则），覆盖进行中与已完成两种 Turn。
- `tests/web/task-dag-panel.test.ts`：渲染断言（节点数、状态徽标、头部「完成 x/y」、点击回调、无 Task 占位、无动画类）。
- 更新受影响断言：`tests/web/execution-detail-events.test.ts`、`tests/web/trajectory-view.test.ts`、`tests/web/live-planning-panel.test.ts`（卡片移除后按 DAG 结构断言）。
- 构建检查：`npx tsc --noEmit`（src + web）、`npm run build`。

## 8. 风险

- **信息丢失**：卡片删除后若 DAG 未承载「步骤/耗时/阻塞原因」，进行中就没地方看了。缓解：第 1 步先抽纯模块，DAG 复用同一推导，行为可对照。
- **重复 DAG**：最新 Turn 与 Recap 同时出现两个 DAG。缓解：第 4 步显式去重。
- **空态**：规划期无 Task、等待派发期无节点。缓解：两种占位文案，不渲染空图。
- **回滚**：新组件独立，可恢复 `ConversationView` / `TrajectoryView` 的接线回退；无后端与存储变更，回滚无数据风险。

## 9. 验收标准

1. 进行中的 Turn 在会话里直接看到 DAG，节点显示执行器/模型、当前步骤、耗时与等待/阻塞原因。
2. 会话中不再出现任务执行卡片；同一 Turn 只出现一份 DAG。
3. 轨迹页不再出现 Execution Summary 卡片，DAG 与时间线、事件表正常。
4. 点击任意节点打开执行详情；未派发节点标注「尚未开始」并显示计划信息。
5. 完成后的 Turn：会话最新 Turn 显示「已交付 · 产物 n 个」，历史 Turn 仍可通过折叠入口查看 DAG。
6. 无 Task 的 Turn 显示「Manager 正在规划」占位，不出现空图。
7. 全程无动画；`tsc` 与 `npm run build` 通过，第 7 节测试通过。

## 10. 与上一版方案的差异（本轮删除项）

- 取消核心数据流转图（Manager → 准入 → Router → 执行 → 校验 → 交付）及其节点输入/输出面板。
- 取消新增后端只读投影 `TaskFlowProjection` 与 `GET /api/execution/tasks/:taskId/flow`。
- 取消轨迹页 `WorkGraphPanel` 被替换的计划：轨迹 DAG 保留原样。
