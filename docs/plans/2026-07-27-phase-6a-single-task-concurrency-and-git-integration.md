# Phase 6 上：单 Task 异步并发与 Git 成果集成

## 计划状态

- **计划日期**：2026-07-27
- **当前状态**：已完成
- **完成日期**：2026-07-27
- **实现提交**：Phase 6 上实现与 closing commit（本计划随提交落库）
- **上位路线图**：[Planner、Kernel 与并发调度收敛路线图](2026-07-16-planner-kernel-concurrency-convergence-roadmap.md)
- **架构决策**：[ADR-0025](../adr/0025-single-task-concurrency-and-git-publication.md)

## 目标与边界

本阶段保留 ADR-0011 的单活顶层 Task 约束，在一个 Task generation 内交付最终并发底座。Work Graph 只表达依赖；Kernel 依据纯事实授权确定性的 dispatch batch；Runtime 并行启动 attempt、管理资源和 Git 副作用，并在成果发布成功后才完成 Subtask。

Phase 6 下只增加多 Task 候选、公平性、饥饿保护和顶层 admission hard cut，不重写本阶段的 frontier、batch、attempt supervisor 或 publication seam。

本阶段不实现数据库语义合并、活跃数据库/WAL/journal/log/cache 管理和 Git LFS。现有 Phase 5 checkpoint/CAS 继续保存 Git 无法覆盖的恢复材料，但不扩展为第二套版本合并系统。

## 不变量

1. Planner 只拥有语义规划和交付意图；Kernel 只拥有并发、恢复和冲突升级策略；Runtime 只拥有隔离执行、资源租约和 Git 副作用。
2. PlanningAgentPlan v6、Work Graph v5 和 Completion Protocol v2 不变，不新增 execution layer。
3. 一个 Subtask 同时最多有一个 pending 或 active attempt；一个 attempt 严格绑定一个 WorkUnit 和一个短命容器。
4. 持久 worktree owner 是 `(taskId, generationId, subtaskId)`；retry、fallback、continuation 和 merge repair 复用该 worktree，但创建新 attempt、WorkUnit claim 和容器。
5. Executor 不能执行 Git 命令或写 `.git`；Runtime 独占 merge、add、commit 和 publication。
6. attempt 成功不等于 Subtask 完成。只有 publication 成功后，result、artifacts、handoff、workspace state 和 `done` 才原子发布。
7. publication 顺序由图拓扑层、首次 batch 授权顺序和 Subtask ID 决定，不能由 attempt 完成时序决定。
8. merge conflict 不影响 AgentClass 健康、普通 retry/fallback 或普通 automatic-replan 配额。
9. Runtime 不静默覆盖冲突版本，也不修改、合并或推送用户分支。

## 公开接口与模块归属

### Work Graph

`src/work-graph/` 新增纯函数 `deriveRunnableFrontier(graph, facts)`。它根据当前 revision、依赖完成事实和 Subtask 生命周期推导拓扑层与稳定顺序，不输出或持久化 execution layer。

### Kernel v4

`ControlKernel.decide(event, snapshot)` 保持唯一纯决策入口。v4 scheduling snapshot 包含单 Task 候选、frontier、pending/active dispatch、AgentClass availability、资源冲突事实、全局上限和空闲 slot。

`dispatch_batch` 一次授权多个 item。每个 item 固定 `attemptId`、`subtaskId`、`agentClass`、`attemptKind`、资源 grant 和顺序。新增 `merge_conflict_observed`、`merge_repair` attempt kind 和 `request_merge_replan`，但不新增 Planner 冲突解决 Subtask。

### Execution

`DurableKernelWorkflow` 继续串行 issue/apply。`dispatch_batch` 的 apply 只事务性插入 child dispatch items，随后立即完成。独立 attempt supervisor 以 `attemptId` 幂等地认领和启动 child item，单项 race 或失败不取消 sibling。

publication worker 按稳定顺序串行发布候选成果。Subtask 生命周期为：

```text
ready -> running -> awaiting_integration -> done
                         |
                         v
                 awaiting_decision
                         |
                         v
                 running(merge_repair)
                         |
                         v
                 awaiting_integration
```

### Storage v26

- `kernel_dispatch_items`：保存 child item 的 `pending_launch`、`launching`、`running`、`terminal`、`cancelled` 和 `uncertain` 生命周期；部分唯一索引保证同一 Subtask 最多一个 pending/active attempt。
- `workspace_publications`：保存 candidate commit、原 completion payload、稳定顺序、repair/replan 预算和最终 integration commit。
- `workspace_merge_attempts`：不可变保存 base/ours/theirs、冲突路径、文件策略、Kernel Decision 和结果。

v3 Kernel applied ledger 继续作为审计。升级不运行双契约；遗留 pending/processing application 在 startup reconciliation 中 fail closed 并转换为 v4 scheduling/recovery event。

## Git 工作区与发布

所有新文件任务统一由内部 Git 管理：

- Git source 克隆为 Task generation 内部 bare repository。
- 非 Git source 导入不可变初始快照并初始化内部 bare repository。
- 每个 Subtask 使用自己的持久 branch/worktree。
- 下游只合并直接依赖的已发布 branch，并使用完整 Git ancestry merge，不使用 cherry-pick。
- generation integration branch 只承担 publication gate、冲突账本和最终结果，不作为所有下游的隐式基线。

文件策略：

- 文本文件优先使用 `.gitattributes`，内容探测兜底，允许 Git 三方合并。
- Office、PDF、图片、音视频、SQLite 等二进制可追踪但不自动合并；实际写集合形成后，publication 前申请 generation/repo-relative-path 独占 lease。
- 发现不可自动合并冲突时停止发布并上报 Kernel，不选择任一版本。

## 冲突修复链

首次 publication conflict 后，当前 Subtask 尚未 `done`，进入同一原 AgentClass 的 `merge_repair`：

1. 文本 repair 获得冲突标记和 base/ours/theirs；二进制 repair 获得两份只读版本并重新生成唯一目标。
2. 使用 native continuation；不支持时注入 Phase 5 recovery packet。
3. Executor 只编辑允许的冲突路径，并返回 `metaclaw:merge-repair:v1`，不得修改原 completion、handoff 或 acceptance。
4. Runtime 验证无 unmerged entries、无冲突标记、改动未越界，随后重新提交 publication。
5. 首次冲突后最多授权三次 repair attempt；每次使用新 attempt 和新容器，保留 worktree 和 Git 历史。
6. 第三次失败后，每条 conflict chain 只允许一次独立 Planner conflict replan；该预算不占普通 automatic replan。仍失败则 park。

## 实施顺序

1. 冻结本计划、ADR-0025 和文件合并技术债。
2. 交付纯 frontier、Kernel v4 决策和 SQLite v26。
3. 交付 dispatch supervisor、Adapter attempt 可重入、精确取消和多 attempt 投影。
4. 统一 Git workspace，改为 dependency ancestry merge，交付 publication gate 和 `awaiting_integration`。
5. 交付文本/二进制策略、三次 repair、conflict replan 和 crash recovery。
6. 删除单节点 dispatch、Runtime 局部策略状态、Adapter 单 active container、新任务 directory fallback、dependency cherry-pick 和 Task 单 running-executor 投影。
7. 更新 CONTEXT、技术总览和路线图，声明 Phase 6 上完成、Phase 6 下待规划。

## 验收

- 纯规则：多节点 frontier、稳定排序、batch 最多四项、去重、capacity/health/partition 过滤和确定性 Decision ID。
- Runtime：至少两个 attempt 真实重叠；单项失败不取消 sibling；同一 Subtask 无双 attempt；精确 attempt/Task cancel。
- Git：Git 与非 Git source 初始化、持久 worktree 接管、完整依赖 ancestry、文本自动合并、二进制独占和用户分支零修改。
- 冲突：乱序完成仍稳定发布；原 AgentClass 最多修三次；第四次进入独立 conflict replan；预算互不污染。
- 原子性：`awaiting_integration` 时下游不可运行；publication 成功才原子发布 completion facts 和 `done`。
- 恢复：覆盖 batch、container、candidate、publication、conflict、repair 和落库各 crash window。
- 最终验证：host `npm run lint`、`npm run build`；Docker 全量测试、并发竞争测试、canonical Codex/Pi image 测试和真实单 Task 并发 smoke。

## 实际交付与验证（2026-07-27）

已交付：

- Work Graph 纯 frontier、Kernel v4 deterministic `dispatch_batch`、SQLite v26 durable child/publication/merge audit。
- 最多四个异步 attempt 的 supervisor、同 AgentClass Adapter 可重入、attempt 精确取消和多 attempt UI 汇总。
- Git/非 Git source 的统一内部 bare repository、Subtask 持久 worktree、直接依赖完整 ancestry merge 和稳定 publication gate。
- `awaiting_integration` 原子完成边界、文本/二进制策略、原 AgentClass 三次 `merge_repair`、一次独立 conflict replan 和 crash reconciliation。
- 并发收尾中删除了同层同 AgentClass 禁令，并修复了每个 batch item 独立资源 grant 与 generation Git 初始化竞态。

已通过：

- `npm run lint`
- `npm run build`
- 最终 `Dockerfile.test` 镜像全量回归：199 个测试文件、806 个测试通过；5 个文件跳过，包含 17 个既有/显式环境门控测试。
- 显式 Docker sandbox 集成：两个真实 attempt 容器同时处于 running，workspace 完全隔离，2/2 通过。
- canonical attempt image build 与 CLI 校验：Codex `0.144.1`、Pi `0.80.2`。
- Session 并发 smoke：两个同 AgentClass sibling attempt 真实重叠，故意反转完成顺序后仍按首次 dispatch 顺序集成。

真实 provider smoke：

- 经用户明确授权后，使用 `metaclaw-runtime:phase5` 控制容器运行 `node /app/scripts/smoke-metaclaw-real-task.mjs`；宿主机仅执行 Docker CLI，Planner、Kernel、Runtime、Codex Executor 和 smoke 校验均位于 Docker。
- smoke 使用隔离网络、临时 workspace 和容器只读 env 挂载，真实 Codex Executor 成功生成并发布 `smoke-result.md`；命令以 exit code 0 结束，随后清理临时容器、网络和工作目录。
