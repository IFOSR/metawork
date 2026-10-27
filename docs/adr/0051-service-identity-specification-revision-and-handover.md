# ADR-0051: 服务身份、规格 revision 与跨 Task 移交

- 状态：已接受并实施
- 日期：2026-10-27
- 关联：[Agent 执行架构重构方案](../plans/2026-10-27-agent-execution-architecture-realignment-plan.md)、[技术实施方案](../plans/2026-10-27-agent-execution-architecture-realignment-implementation-plan.md)、ADR-0024、ADR-0050

## 背景

受管本地服务的持久身份同时混用了服务标识和所属 Task。`managed_local_services`
的主键已经是 `(account, workspace, service_id)`，但 `specificationRevision`
把 `taskId` 也计入 hash，Kernel 又要求登记的 `task_id` 必须等于当前资源 Task。
结果是：同一 Workspace 中，一个新 Task 只要请求完全相同的服务契约，就会因为
"服务标识已绑定其他启动规格" 或 "服务归属不匹配" 被拒绝；旧 `failed` 服务记录
同样会被当成当前任务的阻断条件而非诊断输入。2026-10-27 评审确认的 BS 服务案例
就是这样在代码和自测都已通过后仍被上层判为失败。

## 决策

1. 服务身份是 `(accountId, workspaceId, serviceId)`。记录上的 `taskId` 是
   **出处（provenance）**，不是身份的一部分；当前 Task 重新启动同一启动契约时，
   该字段随之移交到当前 Task。
2. `specificationRevision` 只描述**启动契约**：服务标识、命令、参数、相对目录、
   环境引用、回环地址/端口、健康检查路径、启动窗口和显式重启策略。它不包含
   `taskId`，因此同一契约被后续 Task 重新请求时 revision 保持不变。
3. Kernel 的授权判断按 "同一 Workspace + 同一 revision" 认定继承登记：满足该
   条件时由当前 Task 接管服务；Workspace 不同或 revision 不同仍分别按
   "服务不属于该 Workspace" 和 "需要显式服务更新授权" 拒绝。
4. Runtime 的启动决策以**当前任务规格**为准：同规格的旧 `failed`/`stopped`
   记录只用于诊断和清理，不阻断本轮启动；存活进程只被观察，不重复启动。
5. In-place Workspace 中由上一个 Task 写下的 `.metawork-service.json`，仅当本
   Workspace 已登记完全相同的启动契约时才可被当前 Task 采纳；否则仍然按
   "服务规格不属于当前任务" 拒绝。
6. 服务诊断是 Runtime 事实，不是公开视图字段。`observe()` 返回 Workspace、
   revision、进程标识、退出事实、有界脱敏日志尾部、最近健康状态和
   "Agent 是否可自行修复"；公开 `LocalServiceView` 继续只包含状态、URL 和消息。

## 约束

- 规格变更仍必须经过显式 `update` 授权；revision 不匹配不得静默替换。
- 已运行进程的停止/重启仍只由 Kernel 授权的服务操作驱动，Runtime 不重复启动。
- 记录移交写入 `task_id` 时该 Task 必须存在（外键约束即所有权事实）。
- 日志尾部进入诊断或恢复输入前必须脱敏并保持有界。
- 服务标识在同一 Workspace 内唯一；无 Workspace 的裸查询仍拒绝推测归属。

## 影响

- `src/core/local-service-revision.ts`：revision 材料不再包含 `taskId`。
- `src/storage/managed-local-service-repo.ts`：写入以 revision 判定冲突，并在
  同 revision 时移交 `task_id` 与规格快照。
- `src/execution/managed-local-service.ts`：Workspace 复合查询、当前规格优先的
  启动、跨 Task 规格继承、`observe()` 诊断。
- `src/kernel/control-kernel.ts`：同 Workspace + 同 revision 的登记继承授权。
- `src/execution/kernel-execution-runtime.ts`：服务启动不再因旧记录退化为
  `status()`；未达健康时统一由 `handleServiceVerificationFailure` 记录真实诊断。

## 补充决策（2026-10-27，服务修复 continuation）

服务未达健康不是 Task 终态。补充规则：

1. Runtime 记录 `repair_pending` 服务操作（真实诊断、有界脱敏日志尾部、
   revision、来源 Attempt），Task facts 因此保持 `running`（phase `retrying`），
   不再解释为 `failed`。
2. 产出该服务的已完成 Subtask 受控重开：`completed → awaiting_completion` 是
   completed 节点唯一的出向转换，只用于 Kernel 授权的修复轮次；节点不会回到
   `pending`，历史 receipt/Attempt 保持不变。
3. Kernel 是修复预算与顺序的权威：`dispatch_requested` 携带
   `attemptKind: 'continuation'` 与 `metawork:service-repair:v1` payload，
   Kernel 依据 `serviceRepairAttemptsBySubtask` 与 `repairOrdinal` 只授权下一轮，
   最多三轮；超出预算返回 `block_work` 并给出真实错误。
4. Runtime 每轮之后重新验证服务；修复轮次修改了启动契约（端口/命令/健康路径）
   时，通过显式 Kernel `update` 授权绑定新 revision 后再启动。
5. 诊断必须真的到达 Executor：runner 把 payload 投影为 recovery packet
   （`failure.kind = 'service'` + 服务规格 + 退出事实 + 健康状态 + 日志尾部），
   prompt 渲染该 packet 并要求模型自行修复并自测服务。
6. 操作键、trace 键与 dispatch 事件 id 都包含服务标识、revision、来源 Attempt 与
   轮次，因此不同轮次的失败事实不会互相覆盖。

Schema 60 把 `repair_pending` 加入归一化操作结论。
