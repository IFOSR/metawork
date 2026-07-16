# Kernel 决策权散落 Runtime 技术债

> 状态：已盘点，待建控制面策略层  
> 创建日期：2026-07-16  
> 关联 ADR：ADR-0006（fallback chain + replaceable failure judgment）、ADR-0013（planner-first work-unit dispatch）、ADR-0014（PlanningAgent / PolicyKernel boundary）  
> 用途：记录当前“策略决策散落在 session/execution runtime，PolicyKernel 只审 plan”的架构缺口。本文只登记债务与目标边界，不在此直接改实现。  
> 边界：本文讨论的是 **决策权归属**，不是要求把 claim / 跑 executor / 写库 / 发消息等副作用搬进 `policy-kernel.ts`。

## 总体判断

当前自然语言主路径的授权缝是：

```text
PlanningAgentPlan → PolicyKernel → KernelDecision → Runtime apply
```

这个边界对 **plan 授权** 是成立的：`PolicyKernel` 不写存储、不 claim、不调 executor、不发 delivery。  
但对 **调度与失败恢复** 来说，大脑残缺：

```text
你期望的控制面：
  Plan / ExecutionOutcome / TimerTick / CapacitySignal
    → Kernel（决策）
    → Runtime（执行 decision）

当前实现：
  Plan → PolicyKernel（accept / rewrite / reject / clarify）
  执行失败 / 无容量 / 定时恢复 → session + execution 内 if-else 直接落态
```

结果是：

1. `src/kernel/` 过窄，只覆盖 plan admission；
2. 失败分类、block/park、是否自动恢复、候选探测等策略散落在 runtime；
3. ADR 已写的 fallback / replan / retry cap / 熔断大多未落地；
4. 测试与场景验证无法把“kernel 调度行为”当作单一入口断言。

**应聚合的是决策策略，不是执行代码。**  
目标形态：Kernel 拥有调度与失败策略的最终解释权；Runtime 拥有全部副作用。

## 1. 已确认的正确切分

| 职责 | 应归属 | 现状 |
| --- | --- | --- |
| 理解用户意图、提出 work graph / 候选执行器 | Planner | 已有 `src/planning/` |
| 授权 plan：schema、单活跃任务、未知 executor rewrite、risk/confidence | Kernel | 已有 `src/kernel/policy-kernel.ts` |
| claim / release / heartbeat、真正跑 adapter、写 task/subtask/work unit 状态 | Runtime | 应在 runtime；大体也在 session/execution |
| 按失败原因选择 recovery、是否换 peer、是否 replan、熔断与次数上限 | Kernel / Policy | **缺失或散落** |
| 定时器、事件到达后触发一次裁决并 apply | Runtime 触发 + Kernel 决策 | 现在 timer 自己拍板 |

## 2. 当前散落在 Runtime 的“本应是 Kernel 决策”的点

### 2.1 执行失败分类与任务落态（高优先级）

| 位置 | 当前行为 | 问题 |
| --- | --- | --- |
| `src/executor/error-utils.ts`：`isRecoverableExecutorFailure` | 用正则识别网络 / timeout / 权限失败 | 策略藏在工具函数名与词表里；语义还与 ADR-0006 “force-majeure vs capability” 直觉相反 |
| `src/session/session-execution-coordinator.ts` 失败分支 | recoverable → `markDispatchBlocked`；否则 task `parked`；subtask 标 `blocked` | Runtime 同时做 **判定 + 落态**，无 `RecoveryDecision` |
| 同文件 claim 失败 | 无 idle work unit → task blocked + recoverable hint | “等容量”策略写死在 coordinator，不是 kernel decision |

Kernel **不会**产出 park / suspend / retry / switch_candidate 等决策；冲突时对 plan 直接 `reject`。

### 2.2 自动恢复 / “重试”触发（高优先级）

| 位置 | 当前行为 | 问题 |
| --- | --- | --- |
| `src/session/metaclaw-session.ts`：`maybeReconcileBlockedTasksOnTimer` | 按配置间隔扫描 blocked 任务，executor 可用则 `unblock` + `resume-blocked` 再调度 | 定时器路径直接决定“可以恢复”，不经 PolicyKernel |
| 同文件：`isTimerRecheckableBlockedTask` | 权限失败不自动解阻；材料/等待类 reason 不自动解阻；其余 recoverable 可恢复 | 又一套策略表，与 coordinator / error-utils 并列 |
| `ExecutionRuntime.run` | 单次 `executeOnce` | 无同 executor N 次重试、无 backoff、无 attempt cap |

现状最接近“自动重试”的是 **blocked 后定时再调度**，不是 kernel 规定的 retry policy。

### 2.3 备选执行器与 fallback chain（高优先级）

| 位置 | 当前行为 | 问题 |
| --- | --- | --- |
| `src/kernel/policy-kernel.ts`：`rewriteUnknownExecutors` | 过滤不在 catalog 的候选，可能 `rewrite` | 只做 catalog scrub，不做失败后换 peer |
| `src/execution/work-unit-claim-service.ts`：`claim` | 按 `candidateAgentClasses` 找 idle；没有则顺序 probe/provision | 这是 **启动时找容量**，不是失败后 fallback |
| `src/execution/execution-runtime.ts` | `fallbackExecutors` / `fallbackReason` 字段存在，但成功路径填空数组 | ADR-0006 的 chain + failure judgment **未接入执行失败路径** |

文档方向：force-majeure 不换 peer、capability 短板才换 peer、链耗尽回用户。  
代码方向：失败后 block/park，**不会**按 planner 备选名单自动换 executor 再跑。

### 2.4 回传 Planner / replan（高优先级）

| 位置 | 当前行为 | 问题 |
| --- | --- | --- |
| ADR-0013 Future Work | 基础设施失败自动恢复、任务/质量失败 replan、风险失败人工 | 未实现 |
| 执行失败路径 | 释放 work unit，block 或 park | **没有** “何时强制回 Planner” 的决策与触发 |
| `src/planning/codex-planning-agent.ts` 的 `attemptCount` | Planner 自身 schema repair / 不可用时的尝试 | 与 executor 失败熔断无关 |

### 2.5 熔断、次数上限、应急细分（中高优先级）

| 期望策略 | 现状 |
| --- | --- |
| 同 subtask / 同 executor 最大尝试次数 | 无 |
| 连续失败打开 circuit、冷却后再试 | 无 |
| 断网 / 超时 / 权限 / 写库失败 / 缓存溢出等分类决策 | 仅有粗粒度 recoverable regex；写库失败、缓存溢出等无专门策略 |
| 候选耗尽后的终端行为 | claim 阶段 probe 失败会标 failed work unit；执行失败后无统一 “chain exhausted → replan/clarify” |

### 2.6 执行器实时状态（中优先级，部分合理）

| 位置 | 当前行为 | 判断 |
| --- | --- | --- |
| `src/execution/work-unit-claim-service.ts` | starting / idle / claimed / running / waiting / failed / heartbeat_lost / release | **资源状态机**，副作用侧合理留 Runtime |
| `src/storage/work-unit-repo.ts` | 持久化与 heartbeat 过期 | 存储层，合理 |
| 缺失部分 | 根据 health / capacity / circuit 决定能否派发、是否换候选、是否熔断 | **决策** 应上收 Kernel；现在没有统一入口 |

### 2.7 与 Kernel 重名但实际是 Runtime 应用的代码（中优先级，命名债叠加）

| 位置 | 当前角色 | 问题 |
| --- | --- | --- |
| `src/session/kernel-decision-applier.ts` | 应用 `KernelDecision`：建任务、task control、直答、澄清 | 名字像 kernel，目录在 session；是 Runtime apply，不是 policy |
| `src/session/session-execution-coordinator.ts` | 执行主循环 | 名称与目录都像 session，实为 execution control plane 的应用层 |
| `src/session/task-admission-gate.ts` | 调度前单活跃任务 gate | 与 PolicyKernel 单活跃规则同产品策略的另一半，却在 session |

这些文件不一定要在本债关闭前全部搬家，但它们放大了“kernel 职责不清”的观感，并成为策略继续往 session 堆的路径依赖。

## 3. 影响

- **无法按场景测 “kernel 调度行为”**：同工作区冲突、失败重试、换 peer、回 planner、熔断等，要么根本没有 decision，要么藏在 session timer / coordinator 分支。
- **策略双轨 / 多轨**：plan 冲突走 `PolicyKernel.reject`；执行冲突/失败走 admission gate、error-utils、coordinator、timer 各自规则，容易漂移。
- **ADR 契约与实现脱节**：0006 / 0013 / 0014 写了 failure judgment、replan、retry，实现仍是 plan-only kernel + 临时 runtime 启发式。
- **演进成本高**：以后加熔断、抢占、分区租约、并行调度时，若继续写进 session/execution，控制面会更碎，而不是收敛到可测 policy。
- **命名误导**：`kernel-decision-applier` 在 session、真正失败策略不在 kernel，新同学容易把“执行编排”当成“策略内核”，或反过来把 PolicyKernel 误当成整颗大脑。

## 4. 非约束性目标形态

不要求一次大搬家，但方向应固定为：

```text
src/kernel/   # 控制面决策（可拆多文件，统一 Decision 模型）
  plan 授权
  failure / recovery 策略
  admission / 冲突 / 抢占策略
  熔断与 retry cap
  （未来）workspace partition / 租约授权

src/session/  # 入口、组装、UI/会话投影（逐步变瘦）
src/task/     # 任务状态机与调度执行细节
src/execution/# claim、run、work graph 物化等副作用
```

统一决策形状示例（示意，非最终 API）：

```text
Input:  Plan | ExecutionOutcome | TimerTick | CapacitySignal
Output: KernelDecision {
  outcome,
  runtimeAction,   // retry_same | switch_candidate | block_wait | park | replan | clarify | reject | no_op ...
  reason,
  constraints      // attemptsLeft, cooldown, selectedCandidate, ...
}
```

Runtime 只做：

```text
apply(decision) → 写状态 / claim / run / 投递 / 安排下一次 timer
```

不再在 coordinator 或 session timer 内用正则直接决定战略下一步。

## 5. 建议处理优先级

| 优先级 | 项 | 建议动作 |
| --- | --- | --- |
| P0 | 定义 `ExecutionOutcome` → `RecoveryDecision` 模型 | 先立类型与单测，不接副作用 |
| P0 | 上收 `isRecoverableExecutorFailure` + coordinator block/park 分支 | Kernel 出 decision；coordinator 只 apply |
| P0 | 上收 timer 自动 `resume-blocked` 规则 | timer 只触发 `decide`/`apply`，不内嵌策略表 |
| P1 | 落地 ADR-0006：失败后是否换 plan 内候选 | claim 探测与 post-failure peer retry 分离 |
| P1 | 定义 replan / 回传 Planner 触发条件与上限 | 与 retry cap、chain exhausted 一起设计 |
| P1 | retry cap / 简易熔断 | 防无限 block-recheck 循环 |
| P2 | 应急细分（写库失败、容量、heartbeat_lost 等） | 扩展 failure taxonomy，而不是继续堆 regex |
| P2 | 目录/命名收敛 | `kernel-decision-applier`、admission gate、execution coordinator 与 runtime/kernel 边界对齐 |

## 6. 明确不在本债范围

- 不把 `ExecutionRuntime` / adapter / SQLite 写入搬进 kernel。
- 不在本债中实现并行 worktree、跨 task 分区租约（见 `planner-workspace-partition-and-concurrency-debt.md`）；但那些能力未来的 **授权决策** 也应进入同一控制面，而不是再开一条 session 私规。
- 不把 Planner 语义路由重新散回 runtime；Planner 继续只提案。
- 不要求一次 PR 完成全部搬家；允许先“决策 API + 行为上收”，后“目录更名”。

## 7. 退出条件

同时满足后可关闭本技术债：

1. **单一决策入口**：plan 授权、执行失败恢复、定时恢复、候选耗尽、熔断相关策略均可表达为 `KernelDecision`（或同域 policy API），并有集中单测。
2. **Runtime 无战略分支**：`session-execution-coordinator` / `metaclaw-session` 定时器 / admission 路径不再私自用 regex 决定 retry/park/replan；最多做 decision apply 与基础设施错误上抛。
3. **失败策略可场景验证**：至少覆盖  
   - 网络/超时 → block_wait 或等价 decision；  
   - 权限 → 不自动解阻 / 需用户；  
   - capability 失败 → switch_candidate 或 park/replan（按已定 ADR）；  
   - 候选耗尽 → 终端 decision，而非静默空转；  
   - 超过 retry cap → 熔断或升级。
4. **ADR 对齐**：ADR-0006 / 0013 / 0014 中已接受的 failure/recovery 方向有实现锚点，或显式修订 ADR 声明缩窄范围。
5. **文档与命名不再把 PolicyKernel 描述成“整颗调度内核”却只审 plan**：要么扩展 kernel 能力，要么在文档中明确 control-plane 仍不完整——二者不可长期并存。

## 8. 当前临时行为（供对照，勿固化为契约）

- 有 running 顶层任务时，新 `plan_work_graph` / 非当前任务的 state-changing `task_control`：`PolicyKernel` **reject**。
- Kernel **不会** 挂起子任务排队；挂起/阻塞是 runtime 状态。
- 执行失败：recoverable → task blocked；其他 → task parked。
- blocked 可恢复任务：默认约 60s 定时检查，executor 可用则 `resume-blocked`。
- 无同一次 `run` 内自动重试；无 post-failure peer fallback 主路径；无执行熔断。
- Work unit 有 lease/heartbeat 状态机，但不驱动统一 kernel recovery decision。
