# Phase 5：资源分区、短命沙箱与运行时提权实施计划

## 计划状态

- **计划日期**：2026-07-22
- **当前状态**：已完成并归档
- **完成日期**：2026-07-22
- **实现提交**：`aae3d64`；本次文档回填由紧随其后的 closing commit 完成
- **所属路线图**：[Planner、Kernel 与并发调度收敛路线图](../../plans/2026-07-16-planner-kernel-concurrency-convergence-roadmap.md)
- **架构依据**：[ADR-0020](../../adr/0020-core-module-ownership-and-dependency-direction.md)、[ADR-0023](../../adr/0023-durable-kernel-workflow-recovery-and-availability.md)、[ADR-0024](../../adr/0024-resource-partition-sandbox-and-runtime-elevation.md)

## 目标与边界

Phase 5 在继续保持单活跃 Task、单 active attempt 和串行 dispatch 的前提下，交付最终资源安全底座：每个 attempt 使用独立短命 Docker 容器，每个 Task generation + Subtask 使用持久 workspace，原始仓库、Task 资料与依赖输入只读，工作目录与临时目录可写。Planner 不枚举具体权限；Runtime 根据 AgentClass permission profile 和 Task 绑定资源构造默认授权，Executor 只在越过默认边界时提交结构化 capability request，ControlKernel 依据显式规则作出唯一战略决策。

Phase 5 不实现多 Task 调度、并发 frontier、公平性、并行结果合并、用户分支合并或云对象存储。Work Graph 保持 v5；PlanningAgentPlan 仅为精确用户授权回复升级到 v6。

## 模块与 owner

| 行为 | 唯一 owner | 公开 seam | 禁止依赖 |
| --- | --- | --- | --- |
| partition identity、覆盖、冲突和 grant/lease 不变量 | Resource Model | 纯类型、规范化和冲突函数 | Session、Storage、Docker、时钟 |
| 默认 permission profile 与 canonical image | Routing/AgentClass catalog | 受控 profile/image 查询 | Planner-safe catalog 不暴露权限细节 |
| permission、partition wait 与 recovery 决策 | ControlKernel | `decide(event, snapshot)` v3 | Repository、文件系统、Docker、原始错误文本 |
| workspace、checkpoint、lease、sandbox 和 capability broker | Execution Runtime | apply/observe ports | 未经 Kernel 授权的策略判断 |
| Docker、SQLite、Git/CAS 与外部 effect | Adapters | Resource/Execution 拥有的 ports | 反向调用 Session 或选择 fallback |
| 用户入口与状态投影 | Application Shell | permission command/message facade | 直接写 grant/lease Repository |

## 领域契约

- `PartitionIdentity` 是 `repository | worktree | path | logical | external_object` 判别联合；canonical key 不包含供 Executor 自由提供的宿主绝对路径。
- access 只使用 `read | write`；重叠资源中只要一方 write 即冲突，path 使用父子覆盖，logical/external 使用分段通配。
- AgentClass 增加 `executionImageRef`、`resolvedImageId` 和 `permissionProfileId`。canonical class 强制收敛；自定义 class 缺少可验证 image/profile 时不可执行，绝不回退到宿主进程。
- `request_capability` 只接收 capability、resource、operation、reason 和 `once | attempt`；Runtime 负责 canonicalization 和预算，Kernel 不解析 stderr。
- grant/request 使用稳定 fingerprint。读取/网络 grant 默认最长 15 分钟、100 次、100 MiB；secret、external mutation 和 repository promotion 为最长 5 分钟的一次性 grant；grant 不跨 attempt。
- 平台逃逸、Docker socket/设备/宿主 namespace、绕过代理、系统凭据探测和权限策略持久弱化为不可覆盖拒绝。

## 控制流

1. Kernel 在 `dispatch_attempt` 中授权由 Runtime 构造的默认 resource grant。
2. Runtime 原子 claim WorkUnit 与 resource lease，确保持久 workspace，随后创建带稳定 labels 的受限 Docker attempt。
3. Executor 默认在私有 workspace 内执行；越界时调用 capability broker。Runtime 持久化 request、记录关键 checkpoint、暂停容器、将 `permission_requested` 提交同一 DurableKernelWorkflow。
4. Kernel 只返回：`grant_capability`、`deny_capability` 或 `escalate_capability`。前两种恢复同一容器；第三种触发最小 Planner 复核。
5. 若需要用户输入或 replan，旧 attempt 终止、容器销毁、active lease 释放而 workspace 保留。用户通过命令/按钮或 Planner 解释的自然语言确认精确 request；`permission_resolution_received` 再由 Kernel 决定，许可后创建新的 recovery attempt。
6. 外部操作只由 capability proxy/outbox 执行；Executor 永远不直接写宿主资源。

## Workspace、Docker 与恢复

- WorkspaceStore 位于 `${METACLAW_HOME}/workspace-store`，内容对象按 SHA-256 去重；SQLite 只保存 URI、hash、大小与引用。
- Git generation 从原仓库 HEAD、dirty diff 和 untracked hash 建立受管 baseline；每个 Subtask 使用受管 bare repo 的独立 worktree，`.git` 对 Executor 只读。Runtime 校验后提交到 `metaclaw/<task>/<generation>/<subtask>`，不写原仓库、不 merge、不 push。
- 非 Git workspace 使用 reflink/overlay COW，安全不可用时复制；不得把可写树硬链接到 source/CAS。checkpoint 只发生在开始、显式 checkpoint、权限挂起、成功、失败和取消。
- Docker attempt 使用非 root、read-only rootfs、drop all capabilities、no-new-privileges、资源上限、RO source/input/handoff/`.git`、RW workspace 和 tmpfs `/tmp`；attempt 不挂载 Docker socket或宿主 namespace。
- Runtime 通过 Docker CLI/Engine port 创建兄弟容器。Docker 不可用时规划/查询仍可用，执行以结构化 configuration failure 阻塞。
- 启动恢复双向核对数据库与 container labels：orphan container 清理，missing container 产生 `sandbox_lost`，遗留 running/paused attempt checkpoint 后销毁并交回 Kernel，已退出结果只落账一次。

## 数据迁移与 hard cut

SQLite v25 归档旧 `worktree_leases`，新增 resource lease/wait、workspace/checkpoint/object、permission request/grant/user authorization 和 attempt sandbox 表，并扩展 AgentClass image/profile 字段。历史 Kernel v2 ledger 保持审计；新事件/Decision 使用 v3。Work Graph v5 不迁移、不 park。旧活跃宿主 attempt 在启动时作为 sandbox missing 事实恢复，不保留宿主 Executor 兼容路径。

PlanningAgentPlan v6 新增 `authorization_resolution` 与精确 request ID 的 approve/deny；它只解释用户对既有 request 的回答，不能改写 resource、scope 或 grant。命令 `/permission approve|deny <requestId>` 与 Gateway/Feishu 结构化入口产生同一个 Kernel event，不直接写授权。

## 架构收敛

- 工作图纯规则的公开入口归 `src/work-graph/`；Kernel 不再导入 Planning 内部规则。
- KernelExecutionRuntime 迁入 Execution application 层，Session 只依赖 facade。
- Executor registry 改依赖 AgentClass lookup port；SubtaskAttemptRunner 通过 attempt/lease port 判断当前 claim，不直接查询数据库。
- Resource/Execution 定义 persistence ports，Storage 只实现；删除宿主 Executor spawn、bypass-sandbox、旧 WorkspaceTargetService 和旧 worktree lease 生产入口。
- 若实施中无法一次移除某个历史违规 seam，必须在本计划记录具体调用方和 Phase 5 内删除点；不得新增消费者。

## 验收

- 纯测试覆盖五类 identity、路径逃逸、通配、冲突、三种 permission Decision、硬禁区、TTL/预算、duplicate event/request/apply 和跨 Task 授权拒绝。
- Repository/容器测试覆盖 lease 竞争、幂等 heartbeat/release、Git 原仓库不变、托管分支、非 Git checkpoint/CAS、pause/recovery/cancel/orphan cleanup。
- 真实容器测试证明 source/input/`.git` 只读，workspace/tmp 可写，无 Docker socket/privileged/private-network bypass；默认权限不产生 request，allow/deny/escalate/user-confirmation 全链可恢复。
- 运行 `npm run lint`、`npm run build`、Docker/Linux 全量测试、canonical attempt image build 及真实 `npm run smoke:anyfusion`。
- 完成时回填本节完成日期、实际行为、验证结果和 closing commit；同步更新 ADR 索引、CONTEXT、technical overview、Docker/AgentClass 文档和总体路线图，再归档本计划。未回填前不得宣布 Phase 5 完成。

## 实际交付与验证

Phase 5 按本计划完成：Resource Model、AgentClass image/profile hard cut、SQLite v25、Kernel v3、PlanningAgentPlan v6、持久 workspace/checkpoint/CAS、受管 Git workspace、resource lease/wait、短命 Docker attempt、attempt-scoped model gateway、结构化 capability request、精确用户授权入口和 sandbox recovery 已进入生产路径。宿主 Executor fallback、bypass-sandbox、旧 WorkspaceTargetService、旧 worktree lease 生产入口和已列出的跨模块违规 seam 已移除。生产仍只允许一个 active Task 和一个 active Subtask attempt，没有提前启用 Phase 6 并发。

2026-07-22 验证结果：

- `npm run lint` 通过。
- `npm run build` 通过，并生成 PlanningAgentPlan v6 schema 与 Pi attempt extension。
- `docker build -f Dockerfile.test -t metaclaw-test .` 通过。
- `docker run --rm metaclaw-test` 通过：195 个测试文件通过、5 个跳过；780 个测试通过、16 个跳过。
- canonical Codex/Pi attempt images 构建通过。
- 真实 Docker sandbox 集成测试通过（1 个文件、1 个测试），验证 RO/RW mount、无 Docker socket、无直接私网连接及容器安全参数。
- `npm run smoke:anyfusion` 通过，真实完成 Planner → Kernel → disposable Codex attempt → scoped model gateway → persistent workspace/artifact → cleanup。
