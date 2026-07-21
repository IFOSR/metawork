# Phase 4：持久恢复、Fallback、Retry、Replan 与 Kernel 可用性规则实施计划

## 计划状态

- **计划日期**：2026-07-21
- **当前状态**：实施中
- **完成日期**：未完成
- **实现提交**：未产生
- **架构依据**：[ADR-0020](../adr/0020-core-module-ownership-and-dependency-direction.md)、[ADR-0022](../adr/0022-unified-kernel-control-plane-and-decision-ledger.md)、[ADR-0023](../adr/0023-durable-kernel-workflow-recovery-and-availability.md)

## 目标与控制链

Phase 4 把 Phase 3 的同步、at-most-once 控制循环升级为可跨进程恢复的串行控制面。Planning、retry、fallback、replan、等待和 AgentClass 可用性仍只由同一个纯 `ControlKernel` 决定：

```text
KernelEvent → durable inbox → KernelWorkflow → snapshot
  → ControlKernel.decide → immutable decision ledger + pending application
  → idempotent Runtime apply → normalized observation inbox → next decision
```

Application Shell 只依赖：

```ts
interface KernelWorkflow {
  submit(event: KernelEvent): Promise<KernelWorkflowResult>;
  recover(): Promise<KernelRecoveryReport>;
}
```

`submit` 先持久化再由当前进程串行 drain；`recover` 在 Session/Gateway 接收输入前完成。自动等待中的 blocked Task 继续占用唯一活动槽。

## 改动范围

### 1. Kernel v2 与失败策略

- `execution_outcome` 使用受控 `KernelFailure`，包含 kind、scope、code 和有界净化摘要；capacity 继续使用独立事件且不进入健康历史。
- timer 明确 `capacity | retry | availability` 唤醒类型、来源 Decision 和触发时间。
- 增加人工恢复事件、replan generation/revision 事实、continuation/fallback attempt 元数据。
- 增加 `wait_for_retry`、`request_replan`、`resolve_recovery`；每个 Decision 仍只有一个高层 action，ID 仍由 event ID 确定性派生。
- preferred 的 network/timeout/infrastructure/heartbeat 首次失败分别等待 5/30 秒并只 continuation 一次；之后顺序 fallback，每个 fallback 只执行一次。
- task/domain failure 不重试原 AgentClass；恢复安全时 fallback，候选耗尽后每 generation 自动 replan 一次。contract correction 保持独立的一次机会。

### 2. Completion Protocol v2、Work Graph v5 与 revision

- Completion Protocol 硬升级为 `completed | failed` 判别联合；Executor 只能报告 capability mismatch、task failure 或 quality failure，基础设施错误由 Adapter 规范化。
- Planning/Work Graph 硬升级 v5，引入受控 `task_evidence` context ref、generation 和 graph revision。
- replan 保留旧 revision 的 done receipt/handoff/artifact，不可变地转为 Task evidence；取消旧 revision 未完成节点；新 revision 只描述剩余工作，依赖不得跨 revision。
- 每次用户新计划或显式恢复创建 generation；自动 replan revision 不重置每 generation 一次的额度。

### 3. SQLite v24 与原子边界

新增：

- `kernel_events`：durable inbox，状态 `pending | processing | processed | dead_letter`，含 `available_at`。
- `kernel_decision_applications`：状态 `pending | applying | applied | uncertain | failed`，保存唯一幂等键、apply 次数、observation 和安全错误。
- `kernel_effect_outbox`：外部消息/附件的可靠投递与 uncertain 处理。
- `executor_attempt_runtime`：continuation token、workspace baseline/delta、进度和来源 attempt。
- `work_graph_revisions`：Task、revision、generation、授权 Decision及 active/superseded/completed 状态。

同时扩展 Subtask、attempt receipt 和健康投影的 revision、attempt kind、source attempt、结构化 failure 与恢复元数据。`kernel_decisions` 保持不可变；Decision issuance、application 创建和来源 event 推进必须在同一事务中。terminal receipt、Subtask landing、WorkUnit release 和 outcome event 插入必须原子提交。

v23 Decision 不盲目补应用：可证明后置条件时标记 applied；不能证明的状态变更进入 uncertain，由人工解决。有效 v4 图无损提升为 v5 revision 1，生产不保留 v4 执行路径。

### 4. Durable apply 与 startup recovery

- 重复 event 加载已有 Decision/application 并继续恢复，不再因重复 issuance 直接停止。
- 每个 handler 以 Decision ID 检查后置条件，必要时补应用，并返回稳定 observation。
- startup 固定顺序：reconcile applying → 安全 pending → orphan attempt → 到期 event → 静止后开放输入。
- 崩溃 attempt：已有 receipt 则复用；仍持有 claim 则终止、落 heartbeat_lost 并释放；尚未启动则可应用原 Decision。旧 attempt 永不原地重放。
- 删除 startup、heartbeat、timer、planning 路径中的手写 `decide + issue + apply` 旁路。

### 5. AgentClass 可用性、continuation 与恢复包

“熔断”不新增事实源或状态机。Kernel 依据最近 10 次结构化 attempt 和显式时间纯派生：disabled 或 class 级 auth/config/adapter 永久不可用；10 分钟内连续三次 class 级 network/timeout/infrastructure 进入 5 分钟 cooldown；到期后的下一次串行 dispatch 是唯一 probe。capacity、task failure、contract failure、取消和 host shutdown 不影响派生可用性。

Canonical Routing Capability 增加 `read_only | workspace_reconcilable | external_non_idempotent` 恢复安全级别。Adapter 可尽早持久化 continuation token；Codex 使用 session ID 和 `codex exec resume`。无原生 resume 时构建有界恢复包，记录来源失败、进度、attempt 前基线以及路径/hash/diff 摘要；不回滚用户 dirty changes，不复制完整文件到 ledger。外部非幂等能力只有存在幂等键或能证明未提交副作用时才能自动恢复。

### 6. Replan、outbox 与人工恢复

- `request_replan` handler 调 Planner 并返回 `plan_proposed`；上下文只含目标、结构化失败、已尝试候选、旧 revision 完成证据和剩余目标，不含 raw response。
- 新 proposal 完整通过 schema/context/capability/graph/admission 校验，原子激活新 revision。
- 内部状态与 effect outbox 同事务；支持 provider 幂等键。发送结果未知且 provider 不支持幂等时标记 uncertain，不自动重发。
- 增加 `/task recovery <taskId>` 和 `/task recover <taskId> <itemId> assume-applied|retry`；命令只提交 `recovery_resolution_requested`。

### 7. LangGraph 门控 spike

领域契约和 fault-injection 测试冻结后，才评估 Functional API `entrypoint/task` 与独立 SQLite checkpointer。`thread_id = kernel:v2:<rootEventId>`；checkpoint 使用独立 `workflow-checkpoints.sqlite`，主库在 checkpoint 丢失后仍能独立恢复正确性。禁止 LangGraph retry policy、LangChain model/agent abstraction和领域类型中的 LangGraph 字段。

只有 crash matrix 全通过、删除的自研 cursor/replay 代码比新增 glue 至少多 30%、checkpoint 丢失可恢复且不保留双生产路径时才采用。否则删除 spike 和依赖，保留自研 `KernelWorkflow`，并关闭对应技术债。

## 实施原则与禁止项

- Kernel 保持纯、确定性、无 Repository/时钟/Adapter/LangGraph 依赖；显式时间只作为事实输入。
- Runtime 只应用授权并规范化 observation，不得配置隐藏语义 retry/fallback。
- ledger 是授权审计事实源；inbox、application、outbox 和 checkpoint 各自只拥有自己的生命周期，不形成第二份领域真相。
- 所有外部或跨事务副作用必须有稳定幂等键或 uncertain 人工恢复路径；不承诺无法证明的 exactly-once。
- hard cut 只保留 v2/v5 与单一 workflow 生产路径，不用 feature flag 长期维持双实现。
- Phase 4 保持单活跃 Task、单 active attempt、串行 dispatch；partition/lease 和并发仍分别属于 Phase 5/6。

## 测试与验收标准

### Pure Kernel

- 覆盖完整 failure taxonomy/scope、retry budget、fallback 顺序、backoff、cooldown/probe、task failure、候选耗尽、单次 replan 和 revision quota。
- 相同 event/snapshot 产生完全相同 Decision；Kernel 不访问 Repository、时钟、Adapter 或 LangGraph。

### Persistence 与 fault injection

- v23→v24、v4→v5 revision 迁移；ledger/inbox/application/effect 唯一约束和不可变性。
- receipt、Subtask、WorkUnit release、observation 原子；duplicate event/resume 不重复副作用。
- 覆盖 issuance/application/process/token/receipt/observation/external-send/checkpoint 各崩溃窗口。

### Runtime、Replan 与产品行为

- Codex native continuation、恢复包 fallback、workspace delta、dirty baseline 和 external non-idempotent fail closed。
- done 旧节点不可变、旧未完成节点取消、task evidence、active revision frontier、最终聚合和 generation cap 正确。
- startup 开放输入前完成恢复；等待 Task 占用活动槽；cancel 使 wake no-op；人工恢复不绕过 Kernel。
- 最终输出、handoff、artifact 和外部消息不得自动重复发布。

### 架构与命令

- Kernel 不依赖 Session/Runtime/Storage/LangGraph；Session/Gateway 只依赖 `KernelWorkflow`；Runtime 不依赖 Planning 实现；不存在手写 issue/apply/recovery 旁路。
- `npm run lint`
- `npm run build`
- Docker/Linux 聚焦与全量测试
- Planner→Kernel→retry/fallback→Executor、Codex continuation、自动 replan revision、checkpoint 删除恢复和 external uncertain 人工解决 smoke。

## 完成回填要求

完成时更新本节状态、完成日期、实际交付行为、验证命令及 closing commit；同步回填总体路线图和 ADR 索引，归档本计划与 LangGraph 技术债结论，再激活 Phase 5。未完成上述回填前不得宣布 Phase 4 完成。

