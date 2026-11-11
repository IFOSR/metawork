# Manager 的 Workspace 事实与澄清边界

- 计划日期：2026-11-11。
- 状态：P0、P1 与 P2 文档部分已落地，待用户真实会话验证；真模型 smoke scenario 未做。
- 本批验证日期：2026-11-11（仅本改动直接相关文件，未跑泛化套件）。
- Closing commit：无。按仓库要求仅本地修改，未 commit、push。
- 依据：[ADR-0055 D6](../adr/0055-no-kernel-target-architecture-and-contract-reset.md)、
  [ADR-0015](../adr/0015-planner-owned-semantics-and-tool-mediated-context.md)、
  [CONTEXT.md](../../CONTEXT.md) 的 Manager 边界与 Conversation Git Worktree 契约。

## 问题

一次真实 Turn 中，用户在同一 Conversation 里从“设计判定方案”继续到“直接把这个服务实现了吧”。
Manager 没有产出写计划，而是返回 `clarification`，正文为：

> 当前工作区 /Users/yuanjubian/program/test 是只读的，我没法把服务代码写进去并跑起来。两种方式你选一个：(A) … (B) …

用户被要求为“系统能不能写”做决策，而这既不是用户意图歧义，也不是真实阻塞。

## 证据

- Conversation `conv_DTAHMAkk0RBw`，Turn `turn_pQNI6VRbysuR`（2026-11-11T06:59:06Z）。
- Manager 会话记录（隔离实例）：
  `/tmp/mw-planning-e2e-RDW7Um/accounts/local-default/manager/sessions/401bc118…/2026-11-11T05-48-49-234Z_….jsonl`。
  Turn prompt 原文含 `workspace: /Users/yuanjubian/program/test (只读)`；Manager thinking 原文为
  “Note: workspace is 只读 (read-only). … If truly read-only, we can't implement files”，
  随后提交 `action: "clarification"`、`workspaceIntent.operation: "ambiguous"`。
- 同一 Conversation 的 Turn 1 已出现同一误判：`workspaceIntent.operation: "read_only"`，
  reason 写“工作区 … 为只读”，并对用户复述“工作区为只读”。
- 该 Workspace 实际可写：`workspace_git_roots` 为 `state=ready`，
  `conversation_git_worktrees` 已为本 Conversation 建好 worktree；
  同一 Workspace 的另一 Conversation `conv_v1WHidqdqcpe` 于 2026-11-11T03:36Z
  经合并队列交付 `workbuddy-vs-doubao-qwen.pptx`（用户目录 mtime 11:36），
  证明写入链路正常。
- 运行时侧没有拒绝：`workspaceIntent.operation='ambiguous'` 只是让
  `plan-admission-policy` 走 clarification 分支；clarification 不创建 Task、
  Attempt、Worktree 或写租约（`conv_DTAHMAkk0RBw` 仍只有 Turn 1 一个 Task）。

## 根因

三处叠加，全部是上下文构造问题，不是执行/权限判定问题：

1. **措辞层**：`renderTurnPrompt` 把 `mode === 'read_only'` 渲染成
   `workspace: <root> (只读)`，把“Manager 自己的检视范围”表达成“目标目录属性”。
2. **事实缺席层**：Manager system prompt 只有一串否定约束
   （read-only inspect、Never edit files），缺少正向授权
   （写由 Executor 在 Conversation Git Worktree 执行、由 Runtime 合并回 Workspace），
   模型自然选择最保守路径。
3. **数据层**：`resolveManagerScope` 在生产上恒为 `writable: false`，
   `mode: 'write'` 分支不可达，只存在于单元测试，属于二次踩坑地雷。

## 设计原则：三类事实分离

| 事实 | 归属 | 呈现对象 | 是否可变用户问题 |
| --- | --- | --- | --- |
| Manager 工具面只读、不能 shell/edit | Manager extension | 仅 Manager | 禁止（也不得向用户复述） |
| 任务执行面：写发生在 Conversation Git worktree，由 Runtime 合并回 Workspace | Runtime，逐 turn 提供 | Manager（用于正确规划） | 禁止 |
| 用户意图歧义：做什么、目标路径、范围、覆盖、高风险、冲突取舍 | 用户 | Runtime 提问 | 允许，且仅此一类 |

## 目标 Turn prompt

改前：

```
workspace: /Users/yuanjubian/program/test (只读)
```

改后：

```
workspace: /Users/yuanjubian/program/test
execution writes: Executor commits in this Conversation's Git worktree; the Runtime merges the result back into the Workspace. Declare file work with workspaceEffect/fileOutputs and workspaceIntent.
```

不再出现“只读/可写”二值标签，也不再出现任何关于 Manager 自身权限的描述。

## 落地清单

### P0-1 单一事实源与单一渲染点

- `src/planning/manager-host/protocol.ts`：`ManagerTurnInput.workspace` 收敛为 `{ root }`。
- `src/planning/manager-host/manager-planning-agent.ts`：`ManagerTurnScope` 删除 `writable`；
  planning 与 summary 两条路径都只传 `root`。
- `src/planning/manager-host/manager-agent.ts`：只保留一处渲染，
  输出 Workspace root 与执行写入事实。
- `src/server/server-composition.ts`：`resolveManagerScope` 删除 `writable: false` 死分支。

### P0-2 Manager 规则

`src/planning/manager-host/extension/index.ts` 的 system prompt 增加三条：

1. 请求要求产物时必须 `plan_work_graph` + `workspaceIntent`
   （`create_in_target` / `modify_existing` / `continue_existing_edit` / `run_in_target`），
   并在写子任务声明 `workspaceEffect` 与 `fileOutputs`；不得因“Manager 只读”降级为报告。
2. 仅在用户意图不明确时 `clarification`：功能范围、目标路径、覆盖既有文件、
   高风险确认、冲突取舍。
3. 禁止就自身工具权限、Workspace 写模式、Executor 能力或 Runtime 限制向用户提问，
   也禁止向用户报告这些内容；系统不可执行时由 Runtime 自己给出结论与原因。

### P0-3 测试

- `tests/planning/manager-agent-rpc.test.ts`：删除 `toContain('只读')`；
  断言 prompt 不含 `只读/可写`，包含执行写入事实。
- `tests/planning/manager-planning-agent.test.ts`：scope 契约改为 `{ workspaceRoot, permissionProfileRef }`。
- `tests/planning/manager-provider-config.test.ts`、`tests/planning/manager-host-process-runner.test.ts`、
  `tests/manual/manager-real-turn*.test.ts`、`tests/e2e/packaged-pi-native.test.ts`：同步 `workspace: { root }`。
- 新增确定性场景：用户要求“实现服务”时，写计划得到 `workspaceAdmission.kind === 'write'`
  且不产生 clarification（scripted Manager，不依赖真模型）。

### P1 Runtime 拥有“真不可写”

- 把 Workspace Git 就绪度加入 `WorkspaceAdmissionFacts`。
- `resolveWorkspaceExecutionDecision` 在 `writes=true` 且 Git 根 `failed` 时返回
  `status:'rejected'` 并携带可行动原因（如 `workspace_git_failed: <error>`）。
- 该结果走 Runtime 失败呈现，不进入 clarification 通道；`initializing` 不拒绝。

### P2 文档与真实验收

- `README.zh-CN.md`、`CONTEXT.md` 相关句子改为“Manager 检视范围为只读；写入在
  Conversation worktree 完成并合并回 Workspace”，避免读者继续复述“Workspace 只读”。
- `npm run smoke:metawork` 增加“在当前 Workspace 实现一个最小 BS 服务”scenario，
  验证真实模型产出写计划、合并队列落盘与服务启动。

## 合法澄清白名单（保留）

高风险确认、状态变更置信度 < 0.45、计划本身为 clarification、
resume/abandon 未指明 Task、`workspaceIntent` 为 `ambiguous` / 无 targetPaths /
置信度 < 0.3、未绑定 Workspace、合并冲突选择文件版本。

移出白名单：Manager 自身权限、Workspace 可写性、Executor/AgentClass 可用性。

## 不做

- 不做输出文本后置过滤（禁止出现“只读”字样）。
- 不改 `PlanningAgentPlan` schema 版本、不加 DB 字段、不新增语义路由器。
- 不放宽任何 admission / 权限闸；写入仍走 worktree + 合并队列 + publication gate。
- 不把 Manager 的能力状态放进 Web 的“需要你回答”卡片。

## 验收

P0 完成后重放该类请求，期望：Manager 直接产出 `plan_work_graph`（`create_in_target`，
前后端文件 + 启动验证子任务），Runtime 给 `write` admission，页面进入执行，
不再出现“需要你回答”。P2 的真模型 smoke 作为最终证据。

## 交付记录（2026-11-11）

改动的文件：

- `src/planning/manager-host/protocol.ts`：`ManagerTurnInput.workspace` 收敛为 `{ root }`。
- `src/planning/manager-host/manager-agent.ts`：删除“只读/可写”渲染，改为单一执行写入事实。
- `src/planning/manager-host/manager-planning-agent.ts`：`ManagerTurnScope` 删除 `writable`，
  planning/summary 两条路径只传 root。
- `src/planning/manager-host/extension/index.ts`：新增正向写授权、澄清范围与禁止能力提问三条规则。
- `src/server/server-composition.ts`：`resolveManagerScope` 删除恒假死分支；为
  `ConversationSession` 注入 Runtime 拥有的 Workspace 写就绪度。
- `src/core/workspace-execution.ts`：新增 `WorkspaceWriteState`、
  `WorkspaceAdmissionTargetFact` 与 `workspaceWriteStateOf`。
- `src/control/workspace-execution-decision.ts`：`writes=true` 且 Git 根 `failed` 时
  以 Runtime 原因 rejected；`initializing`/未知不阻塞。
- `src/control/control-contracts.ts`、`src/execution/plan-admission-policy.ts`、
  `src/account/generation-replan-worker.ts`、`src/session/conversation-session.ts`、
  `src/session/metaclaw-session.ts`：传递可选的 Workspace 写就绪事实。
- `README.zh-CN.md`、`CONTEXT.md`、`docs/README.md`：口径与索引更新。

测试（仅本改动直接相关文件，7 文件 90 项通过；`npx tsc --noEmit` 通过）：

- `tests/planning/manager-agent-rpc.test.ts`：prompt 不含只读/可写，包含执行写入事实。
- `tests/planning/manager-planning-agent.test.ts`：新增“实现服务 → 写计划 → write admission、
  无 clarification”确定性用例。
- `tests/planning/manager-extension.test.ts`：断言新的 Manager 规则。
- `tests/control/workspace-execution-admission.test.ts`：Git 根 `failed` 拒绝、
  `initializing`/未知放行、就绪度投影映射。
- `tests/planning/manager-provider-config.test.ts`、`manager-transport-selection.test.ts`、
  `manager-host-process-runner.test.ts`：scope 契约随类型收敛。
- `tests/manual/manager-real-turn*.test.ts`、`tests/e2e/packaged-pi-native.test.ts`
  仅同步类型，未运行（需要真实打包 Pi）。

待办：真模型验证（P2 smoke scenario）与用户在真实会话中重放截图那一轮。
