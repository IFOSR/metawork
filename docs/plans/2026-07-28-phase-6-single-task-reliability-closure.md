# Phase 6 最终收口：单 Task 并发可靠性与 07-16 路线图关闭

## 状态

- 状态：已完成
- 计划日期：2026-07-28
- 完成日期：2026-07-28
- 实现提交：`feat: close single-task phase 6 reliability`（本计划随该提交落库）
- 关闭提交：同上

## 目标

完成 `2026-07-16-planner-kernel-concurrency-convergence-roadmap.md` 除多顶层
Task 并发外的全部完成条件。Phase 6 的最终能力边界为：

- 单顶层 Task 内按 Work Graph DAG 并发执行；
- attempt、WorkUnit、sandbox 和持久 worktree 隔离；
- Git 托管依赖组合、候选成果和最终集成；
- Task 与 Subtask 取消具有持久栅栏、精确终止和启动恢复；
- 多 attempt 故障独立恢复，耗尽预算后按 generation 合并 replan；
- 只有全部运行残留清零后才允许完整或显式部分完成。

ADR-0011 继续有效。多顶层 Task admission、优先级、公平性和饥饿保护移入
未来独立路线图，不属于本阶段实现或验收。

## 实施范围

### Kernel 与纯规则

- Kernel v4 新增 `task_cancel_requested`、`subtasks_cancel_requested`、
  `partial_result_acceptance_requested` 及 generation replan/quiescence 事实。
- 新增纯 `deriveCancellationClosure`，对原子目标批次计算传递下游闭包，
  按逆拓扑层和 Subtask ID 稳定排序。
- 已完成、跨 generation 或不存在的目标使整批请求失败关闭。
- 取消栅栏之后到达的 attempt outcome 一律为 `no_op`，不得触发健康惩罚、
  retry、fallback、block 或 replan。

### SQLite v27 与运行时

- dispatch、publication 增加持久 `cancelling/cancelled` 收束事实和取消审计。
- resource lease 增加 revocation-requested 事实；容器停止前仍保持占用。
- 新增 generation replan request，合并同一 generation/revision 的普通自动
  replan，并在旧图静止后只调用一次 Planner。
- Work Graph revision 记录 `full` 或 `partial_accepted` completion kind。
- 所有取消入口经 Durable Kernel event；取消 supervisor 精确终止 attempt，
  对账 sandbox 后释放 WorkUnit、lease 和 capacity，并在启动时幂等恢复。
- publication final transaction 重新校验取消栅栏；已经生成但未发布的 Git
  commit 仅留作审计，不发布 handoff/result/workspace state，也不自动 reset。

### 用户控制与完成门

- 新增 `/task <taskId> subtask cancel <subtaskId...>`。
- 新增 `/task <taskId> accept-partial`。
- 自然语言 Planner 不得直接取消 Subtask，只能提示使用显式命令。
- 部分取消后，未受影响的 sibling 继续；收束后 Task 进入结构化 `blocked`，
  只有显式部分接受才能以 `partial_accepted` 完成。
- `complete_task` 必须验证 dispatch、publication、sandbox、WorkUnit、lease、
  receipt、replan 和 Kernel application 均无阻塞残留。

## 验证

- 宿主机：`npm run lint`、`npm run build`。
- Docker：完整 Vitest/SQLite migration suite、并发竞争与故障恢复测试。
- Docker：canonical Codex/Pi image 验证与真实单 Task 并发 smoke。
- smoke 不在宿主机执行，并复用既有 Docker planner/executor 环境配置。

## 完成记录

2026-07-28 完成 Phase 6 最终收口：

- Kernel v4 已统一授权整 Task 取消、原子 Subtask 下游闭包取消、显式部分
  接受和 generation ordinary replan；取消后的晚到 outcome 为 `no_op`。
- SQLite v27 已交付 dispatch/publication `cancelling/cancelled`、lease revocation、
  generation replan request 和 revision completion kind，并通过空库、升级与重放迁移。
- cancellation coordinator 先提交持久栅栏，再等待 active launch/run 收束、精确
  停止 sandbox、释放 WorkUnit/lease/capacity；启动恢复先以 Docker labels 对账，
  避免 container-start crash window 提前释放资源。
- publication final transaction 已加入取消栅栏；merge 后取消只记录 observed
  integration commit，不发布 result、handoff、artifact 或 workspace completion。
- 多个失败会合并为同一 generation replan；Planner 只在 quiescence 后调用，
  exact token CAS 会拒绝取消后的晚到 plan。
- `/task <taskId> subtask cancel <subtaskId...>` 与
  `/task <taskId> accept-partial` 已接入 durable Kernel workflow；Planner prompt
  明确禁止自然语言直接修改 Subtask 取消状态。
- 完成门会检查 dispatch、publication、sandbox、WorkUnit、resource lease、
  attempt receipt、generation replan 和未落定 Kernel application；显式
  `partial_accepted` 是唯一非全 `done` 完成路径。
- `CONTEXT.md`、中英文技术总览、`ISSUES.md`、Phase 6 上计划、文档地图和
  07-16 路线图已同步；ADR-0011 保持有效，多 Task 调度移入未来独立路线图。

验证：

- 宿主机 `npm run lint` 通过。
- 宿主机 `npm run build` 通过。
- `docker build -f Dockerfile.test -t metaclaw-test .` 通过。
- `docker run --rm metaclaw-test npm test` 通过：202 个测试文件、817 个测试
  通过；5 个文件、17 个既有环境/未来范围测试跳过。
- canonical 容器 CLI 验证通过：Codex `0.144.1`、Pi `0.80.2`。
- Docker real-task smoke 重试后通过；真实 Codex
  Planner → Kernel → isolated Executor → Git publication 生成并验证
  `smoke-result.md`。smoke 未在宿主 Runtime 执行，宿主 wrapper 只负责 Docker
  镜像和控制容器编排。

07-16 路线图的七项总体完成条件全部关闭。多顶层 Task admission、优先级、
公平性和饥饿保护不计入本路线图完成条件。
