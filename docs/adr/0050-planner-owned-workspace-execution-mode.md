# ADR-0050: 单一 In-place Workspace 执行模型

- 状态：已接受并实施
- 日期：2026-10-25
- 取代：[Planner 主导的 Workspace 执行模式设计](../plans/2026-10-25-planner-owned-workspace-mode-design.md)
- 实施方案：[单一 In-place Workspace 技术实施方案](../plans/2026-10-25-in-place-only-workspace-execution-implementation-plan.md)

## 决策

MetaWork 新任务只有一种 Workspace 写入语义：Executor 在 Conversation 绑定的
Workspace 中直接执行。Planner 只声明读写意图、目标 Workspace-relative 路径和
文件策略；Kernel 将其解析为 `read` 或 `write` admission。写入 admission 在
Executor 启动前申请物理路径 Workspace write lease，冲突任务进入
`resource_waits` 并在租约释放后重新校验 binding。

普通编辑、新建文件、继续编辑和目标 Workspace 命令都使用同一目标目录。系统不
为新任务复制 Workspace、创建 Git worktree、生成候选目录或执行二次 publication。
Attempt 记录 before/after snapshot、变更清单、receipt 和 uncertainty；成功的
In-place Attempt 直接完成 Subtask，并由结果记录服务登记声明的文件。

`read_only` 是访问事实，不是第二种执行模式。只读 Attempt 可以通过受控的只读
边界读取 Conversation Workspace，临时文件进入 Runtime scratch 目录，不申请
Workspace write lease，也不创建 publication。声明 `fileOutputs` 的报告自动按
写入 admission 处理。

旧 Worktree binding、候选 publication 和自动复制结果只作为历史事实迁移并停放，
不得重新 dispatch 或静默切换目录。显式配置
`METACLAW_EXECUTOR_BACKEND=worktree` 会失败并要求重新规划为目标 Workspace
执行。

## 约束

- `authorizedWorkingDirectory` 只能是目标 Workspace 根或受控 scratch 根。
- 目标路径必须是 Workspace-relative，并由 Kernel 校验 containment 和声明输出覆盖。
- 同一物理 Workspace 或重叠父子路径由 ResourceLease 串行化；不同 Workspace 可并行。
- Executor 崩溃后存在未知写入时进入 uncertainty，恢复不得盲目重放。
- Web、Desktop、TUI、Gateway 只展示目标 Workspace 和变更事实，不展示候选发布模式。

## 迁移

schema 58 将未完成的历史 Worktree publication 停放；旧 binding 在恢复时明确拒绝。
历史 nullable/兼容列可以保留用于诊断，但新代码不得读取其模式选择语义。
