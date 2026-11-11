# MetaWork 无 Kernel 目标契约设计

- 日期：2026-11-07
- 状态：Accepted（随 [ADR-0055 Decision ledger](../adr/0055-no-kernel-target-architecture-and-contract-reset.md) 由产品 Owner 于 2026-11-07 豁免交叉评审接受）
- 替代：早先引用的 audit report / contract design / reset plan 草稿（不在工作区）
- 输入：[技术实施方案](2026-11-07-metawork-product-convergence-technical-implementation-plan.md) §4/§6、[复盘报告](2026-11-07-metawork-product-convergence-retrospective-report.md)、[P2-A spike](2026-11-07-p2a-upstream-pi-integration-spike.md)

本文只定义**可实施的契约**：谁拥有哪个决定、写哪张表、用什么幂等键、失败怎么表达。它不
规定 UI 细节、部署拓扑或具体额度数值（后者由产品输入给出）。

## 1. 职责与控制流

```text
Client (Web/Desktop/Feishu)
  └─ Gateway (auth principal, account/workspace scope)
      └─ Task Runtime.admit(request)                     [TaskAdmissionPort]
          ├─ Manager.plan(turn) ──────────────► proposal (Work Graph v7 / Plan v9)
          ├─ TaskRuntime.authorize(proposal)    ── graph revision + bindings persisted
          └─ for each ready Subtask:
              Router.decide(RouteRequest) ─────► RouteDecision | no_candidate
                └─ TaskRuntime.dispatch(decision)  ── attempt identity + claim + launch
                    └─ Executor (bundled Pi) ─────► AttemptReceipt / Result
                        └─ PermissionService.request(capability)
                             ├─ hard deny / always escalate / Manager.judge
                             └─ Host.enforce(boundary)
      └─ Publication (seal → FIFO merge → delivery)      [PublicationPort]
          └─ Manager.summarize(task) ─────► final answer
```

不可变约束见技术方案 §1.1；本设计不引入第二策略循环，也没有"协调器"角色。

## 2. Owner 端口（消费者拥有接口，SQLite 只实现）

| 端口 | 拥有者 | 关键方法（输入 → 输出） | 唯一写事务 |
| --- | --- | --- | --- |
| `TaskAdmissionPort` | Task Runtime | `admit(TaskAdmissionRequest) → {taskId, graphRevision, generationId}` | Task + Subtask + revision + admission identity |
| `TaskLifecyclePort` | Task Runtime | `transition({taskId, from, to, expectedStateVersion, reason}) → TaskStateChange` | `tasks.state_version` CAS |
| `RouteDispatchPort` | Task Runtime | `decide(RouteRequest) → RouteDecision`；`dispatch({decisionId, attemptOrdinal}) → Attempt` | route fact + attempt claim（同事务） |
| `AttemptLifecyclePort` | Attempt Runtime | `claim/lease/heartbeat/terminalize` | `attempts` + `attempt_claims` |
| `PermissionPort` | Permission Service | `request(PermissionRequest) → decision`；`apply(decisionId) → applied` | `permission_requests` + `permission_decisions` |
| `PublicationPort` | Publication | `seal(attemptId) → changeId`；`merge(changeId)`；`deliver(jobId)` | `workspace_changes` → `merge_jobs` |
| `RecoveryPort` | Task Runtime | `reconcile(now) → RecoveryAction[]` | `recovery_items`（append-only） |
| `CancellationPort` | Task Runtime | `cancel(taskId, reason)` | cancellation fact + slot release |
| `MeteringPort` | Metering | `record(ModelUsageFact)`；`aggregate(range)` | `model_usage_facts`（call key 唯一） |

依赖方向：`session/gateway → ports → adapters`；Router/Manager/Permission **不导入** storage 或
process adapter（ADR-0020 方向保持不变）。

## 3. 持久事实（fresh schema）

只列新建/收敛的表；`official-server` 的账号/许可/支付不在此库。

| 表 | 主键 | 唯一/幂等 | 说明 |
| --- | --- | --- | --- |
| `tasks` | `task_id` | — | 增加 `state_version`（CAS） |
| `work_graphs` | `(task_id, generation_id, revision)` | 唯一 | 取代 `work_graph_revisions` 名称；保留 `completion_requirements_json` |
| `subtasks` | `subtask_id` | 唯一 `(task_id, generation_id, node_key)` | `workspace_effect`, `file_outputs_json`, `status` |
| `attempts` | `attempt_id` | 唯一 `(subtask_id, attempt_ordinal)` | `route_decision_id`, `binding_fingerprint`, `terminal_state` |
| `route_decisions` | `route_decision_id` | 唯一 `(task_id, generation_id, subtask_id, attempt_ordinal)` | 记录候选/排除/理由/决策模型/配置 revision |
| `permission_requests` | `request_id` | 唯一 `(attempt_id, request_revision)` | capability、scope、limits、fingerprint |
| `permission_decisions` | `decision_id` | 唯一 `(request_id, request_revision)` | `grant|deny|escalate` + `applied_at`，append-only |
| `results` | `result_id` | 唯一 `(attempt_id, kind)` | 认证/未认证、内容哈希 |
| `workspace_changes` | `change_id` | 唯一 `(task_id, generation_id, result_commit)` | seal 产物 |
| `merge_jobs` | `job_id` | 唯一 `(workspace_id, sequence)`；`change_id` 唯一 | FIFO |
| `merge_files` | `(job_id, ordinal)` | 唯一 `(job_id, relative_path)` | 逐文件写回 |
| `deliveries` | `delivery_id` | 唯一 `(job_id)` | 交付终态 |
| `model_usage_facts` | `usage_id` | 唯一 `call_idempotency_key` | Token only；缺 usage 时 tokens NULL + `usage_source` |
| `usage_rollups` | `(account_id, provider_id, day, payer)` | 唯一 | 面向查询，可重建 |
| `recovery_items` | `recovery_item_id` | 唯一 `(kind, identity)` | 外部效果 unknown 时落此表并 fail closed |
| `idempotency_keys` | `(scope, key)` | 唯一 | 所有外部 effect 的统一幂等入口 |

`schema_meta(version)` 只允许一个 `CURRENT_SCHEMA_VERSION`。启动顺序：只读识别 marker →
空库建表 → 匹配则打开 → 其他情况在任何写操作前失败，错误内附备份路径与重置命令（D9）。

## 4. Route 契约

```ts
interface RouteRequest {
  taskId: string; generationId: string; subtaskId: string;
  graphRevision: number; attemptOrdinal: number;
  goal: string; acceptance: string[];
  configurationRevision: string;
  candidates: AgentClassCandidate[];          // 硬资格已过滤后的候选
  excluded: Array<{ agentClassRef: string; reason: ExclusionReason }>;
  modelCatalog: ModelCatalogEntry[];
}
interface RouteDecision {
  routeDecisionId: string; inputSnapshotHash: string;
  candidates: AgentClassCandidate[]; excluded: RouteRequest['excluded'];
  selected: { agentClassRef: string; providerRef: string; modelRef: string } | null;
  decisionModel: { providerRef: string; modelRef: string };
  rationale: string; configurationRevision: string; createdAt: string;
  outcome: 'selected' | 'no_candidate';
}
```

错误码：`route_invalid_output`、`route_unknown_agent`、`route_unknown_model`、
`route_timeout`、`route_process_exit`、`route_stale_decision`、`route_no_candidate`。
`route_stale_decision`（generation/revision 已变）必须重新请求 Router，不得复用旧决策。

## 5. Permission 契约

```ts
interface PermissionRequest {
  requestId: string; requestRevision: number;
  accountId: string; workspaceId: string; conversationId: string;
  taskId: string; generationId: string; subtaskId: string; attemptId: string;
  capability: string; partition: string; operation: string;
  scope: Record<string, unknown>; limits: Record<string, number>;
  profileRef: string; configurationRevision: string;
  process: { pid: number; startTime: string; exe: string };
  fingerprint: string;                        // 规范化后的请求指纹
}
type PermissionDecision = {
  decisionId: string; requestId: string; requestRevision: number;
  verdict: 'grant' | 'deny' | 'escalate';
  grantedScope?: Record<string, unknown>;      // 必须 ⊆ request.scope
  reason: string;
  source: 'hard_deny' | 'always_escalate' | 'manager' | 'user';
};
```

规则（D2）：hard deny 不调用 Manager；always escalate 直接建用户待办；其余才送 Manager
`judgePermission(request, boundedUserIntent, taskGoal, existingDecisions, profile)`。Manager
输出非法/超时/未知一律 `escalate`。Host 永远保留最终边界，模型结果不能放大能力。

## 6. Kernel 决策映射（17 类，逐项落到唯一 owner）

| Kernel 决策 | 目标 owner | 说明 |
| --- | --- | --- |
| `authorize_task_plan` | Task Runtime.admit | 校验图/槽位/workspace/revision 后一次事务写入 |
| `dispatch_batch` | Task Runtime.dispatch | 每条来自一个 RouteDecision |
| `wait_for_capacity` / `probe_capacity` | Task Runtime.scheduler | 等待与探测，不产生决策账本 |
| `wait_for_retry` / `retry_remaining_work` | Task Runtime.recovery | 机械重试，受 D1 预算约束 |
| `complete_task` | Task Runtime.completion | receipt → dependency-ready → user-delivered |
| `request_replan` / `schedule_replan` / `queue_generation_replan` | Manager.replan + Task Runtime.jobs | 语义由 Manager，机械调度由 Runtime |
| `request_merge_replan` | Publication.recovery | 冲突修复属于交付 |
| `cancel_task` / `cancel_subtasks` | Task Runtime.cancellation | 幂等取消事实 |
| `accept_uncertified_result` / `accept_partial_result` | Task Runtime.completion | 用户决定 + 封存提交身份 |
| `grant/deny/escalate_capability` | Permission Service | §5 |
| `record_permission_resolution` | Permission Service | append-only |
| `park_for_replan` / `block_work` | Task Runtime.lifecycle | 结构化原因 + 待办 |
| `recover_workspace_attempt` / `resolve_recovery` | Runtime.recovery + Host | 只重试可证明幂等的 effect |
| `control_managed_service` | Task Runtime.services | 从已交付变更启动 |
| `no_op` | 删除 | 无决策层后不需要 |
| `defer_task_plan_for_availability` | Task Runtime.scheduler | 能力不可用时的排队事实 |

## 7. 命名与标识（D7）

| 旧 | 新 | 处理 |
| --- | --- | --- |
| `METACLAW_*` 环境变量 | `METAWORK_*` | 直接重命名，无兼容读取 |
| `metaclaw` / `anyfusion` CLI 别名 | 删除 | 只保留 `metawork`、`metawork-install` |
| `planner/AnyFusion-Pi` | 移除 | Manager/Executor 用打包的上游 Pi |
| `AnyFusion` / `MetaClaw` 文案 | `MetaWork` / `Manager` | 代码、UI、文档、注释 |
| `io.metaclaw.attempt-sandbox` 标签 | `io.metawork.attempt` | 仅新写入生效 |
| `anyfusion-*` 包名/镜像名 | `metawork-*` | 打包脚本与 manifest |

## 8. 网络与客户端契约（D10/D11/D14）

- 配置：`server.host`（默认 `127.0.0.1`）、`server.allowedOrigins`（默认空）、
  `server.trustProxy`（默认 false）。非回环监听必须显式配置且允许来源非空，否则拒绝启动。
- 认证：账号登录会话即凭据；所有非回环请求都要通过认证与账户/工作区授权。
- Origin/CSRF：canonical scheme+host+port 比对；拒绝 `null` 与通配凭据。
- 内部端点（Planner RPC、memory sidecar、official local service、MCP）只绑回环或 Unix socket，
  不继承 `server.host`。
- 客户端只投影：Task/Attempt/permission/trace/usage/memory 的读模型由 Gateway 提供，Web 不
  自算状态；`metawork` 要求先显式 `metawork server start`。

## 9. 验收接缝

| 契约 | 断言位置 |
| --- | --- |
| Route 唯一派发 | Router 单测（非法输出/未知 Agent/超时/并发 claim/过期决策/no-candidate） |
| Permission 三层 | hard deny 不可被 Manager/用户覆盖；作用域只能收窄；并发/重复/过期决定拒绝 |
| 交付 | seal→merge→delivery 的幂等重放；失败不重跑 Executor |
| Usage | 每次调用一条 fact；重复 callback 去重；北京时间聚合与逐行之和一致 |
| 网络 | loopback 默认、非回环未认证拒绝、origin 正反例、内部端口不对外 |
| 旧库 | 旧 schema 在任何写前失败，错误含备份与重置命令 |
