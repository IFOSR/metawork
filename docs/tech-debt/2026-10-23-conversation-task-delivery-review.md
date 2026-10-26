# 会话、任务交付与服务归属方案：源码核对及诊断评审

- 评审日期、完成日期：2026-10-23。
- 状态：评审完成；原方案需要修订，未批准为实施基线，未实施修复。
- 评审对象：[2026-10-22 故障复盘与改造方案](../plans/2026-10-22-conversation-task-delivery-and-service-ownership-review.md)。
- 源码基线：`1ab8fc45`；功能基线包含 `d19e412e`。评审开始时工作树干净，原文“尚未提交的受管服务与公开交付实现”已不是本次源码状态。
- 方法：生产调用链、当前 ADR、既有测试静态审阅；运行数据库只读连接并通过 SQLite backup 复制到内存后查询；日志分类计数；临时目录中的真实源码/Git 最小复现。
- 交付：本评审及原方案中的评审入口；关闭提交：未创建，本次未执行提交。

## 1. 总体结论

**有真实故障，但“每轮新建四样东西，因此必须全部改成会话所有”不是充分成立的根因模型。建议修订后再实施，不能直接照 P1/P2 改。**

应立即处理维护空转、日志失明和“确定拒绝被持久化成副作用不确定”的恢复缺口。长期交付位置与服务身份不应被一次 Task 生命周期绑死，这个产品方向合理；但稳定目录、历史版本、执行隔离、发布冲突、服务授权、记忆送达是不同契约，不能用统一改外键替代。

原方案中会带来新故障的关键做法是：删除冲突检查后直接覆盖；只凭目录/启动声明存在就执行；以最新服务规格无条件替换旧规格；只存历史哈希却承诺回滚；把私有执行工作区的回收策略一起改成会话生命周期。

## 2. 现场复核与证据边界

### 2.1 数据库与日志

本次复核本机 `~/.metawork`：

| 事实 | 本次结果 | 与原文关系 |
| --- | --- | --- |
| Task | done 117、cancelled 27、created 1 | 一致，总数 145 |
| receipt | completed 150、executor_failed 18、uncertified_result 16、cancelled_or_stale 11 | 一致，总数 195 |
| publication | integrated 149、cancelled 2 | 一致 |
| delivery | succeeded 51 | 一致；不能解释成所有 149 条 integrated 都有公开交付 |
| application | applied 756、uncertain 3 | 一致 |
| 非空槽位 | 1 个，`conv_dHWzo_CbPJh0`，`releasing` | 会话阻塞仍存在 |
| task_memory_cards | **0** | 否定“本轮一张、每轮新建”的现场描述 |
| managed_local_services | 2 条：stopped / failed | 与原文一致，不是每个 Task 都创建服务 |

三条 uncertain 的持久原因分别是：

1. `authorize_task_control / service_start`：代码尚未发布到用户任务目录，applyAttempts=1。
2. `authorize_task_plan`：无法确认现有项目的 Workspace，applyAttempts=3。
3. `authorize_task_control / service_start`：服务与任务归属不匹配，applyAttempts=1；当前保留的会话槽位指向此 Task。

日志复核时：本机 20,494 行，维护 null.length 错误仍为 4,057 行，consistent 15,662 行，retained slot 467 行。guangda 为 1,093,323 行，缺 `notification_outbox` 错误 1,087,943 行；数据库副本也确实没有此表，其经验卡同样是 0。

这些数字是采样事实，不是迁移程序应该硬编码的验收常量。没有重新运行真实模型、启动用户服务、修改安装数据库或清理旧目录；没有重测原文 20 秒 CPU 实验。原文 4%–15% CPU、其他定时器的归因及“至少两周”时间跨度，不能由本次源码检查升级为普遍事实。

### 2.2 已运行的最小复现

本工作树没有 `node_modules`，`better-sqlite3` 无法解析，因此没有声称运行过 Vitest 全套或上述集成测试。使用 Node 22.23.3 的 `stripTypeScriptTypes` 执行选定的真实源码，模块链接仅改为内存 URL；数据库使用 Python SQLite 只读备份查询。

| 实验 | 结果 |
| --- | --- |
| `EventJournalMaintenance`：`nextStream` 始终返回 null、25ms 周期 | 265ms 查询 10 次，确实不退避 |
| `captureWorkspaceState` + 真实 Git commit/worktree | 忽略且未跟踪的 `target/app` 不在 delta，也不在固定 commit 快照 |
| 将同一路径显式纳入 Git 跟踪，再修改 | 能被捕获；“任何忽略目录永远不能交付”过于绝对 |
| `DurableKernelWorkflow`：apply 抛确定性业务拒绝，内存 store 记录状态 | 外层 application 变成 uncertain |
| `inspectApplicationPostcondition`：service_start 的 authorize_task_control | 返回 not_managed |
| `ManagedGitWorkspaceService.ensure` + `WorkspaceStore`：选择 repo/project | 实际 worktree 含 project/app.txt 和 sibling.txt，不含根级 app.txt；选中子目录被提升为整个 Git 仓库 |
| 对副本执行六表 UNION 的 EXPLAIN QUERY PLAN | 六个分支均为覆盖索引 SEARCH，不能称为每 tick 六表全扫描 |

上述是分层复现与现场事实互证，不是假称完整产品端到端验收。

## 3. 逐项诊断

### A1：高频维护成立，“全表扫”和退避判据需要纠正

证据：[account-event-journal.ts](../../src/server/account-event-journal.ts) 的 `intervalMs: 25`；[event-journal-maintenance.ts](../../src/gateway/event-journal-maintenance.ts) 的 schedule/runOnce；[event-journal-segment-index-repo.ts](../../src/storage/event-journal-segment-index-repo.ts) 的 nextStream。

- 周期是“单次异步工作耗时 + 25ms”，空闲近似 40Hz，并非任何状态都恒定 40Hz。
- current stream 未做完时可继续最多四批，不是每 tick 都执行 nextStream；UNION 是按 Account/Conversation 游标走索引的枚举，不是已证明的全表扫描。
- nextStream 枚举的是已知 stream，**不是待办队列**。已收敛但有很多会话时，仍会遍历维护；只在返回 null 时睡 1 秒不足以解决这个场景。
- maintain 的 boolean 表达“该 stream 的有界维护是否完成”，不表达“本轮实际做了多少工作”。P0-1 必须补可判定的 didWork/pending 信号，或明确一轮扫描的空闲预算。

建议：活动工作保留小批处理；完整空闲轮退避；每个损坏 stream 单独退避并让其余 stream 前进；append/dirty/rebuild 入队唤醒，保留低频兜底扫描。错误限速应保留第一次堆栈、重复次数与恢复事件，而非永久静默。对下一次有工作时的唤醒延迟同时设验收目标。

### A2/A3：错误与可观测性问题成立，影响不能一概排除

[server-composition.ts](../../src/server/server-composition.ts) 当前 onError 只打印 message；维护接口也只传 error，没有 Conversation/stage，所以不是只改一行日志就能补齐定位字段。异常可能发生在 nextStream 阶段，此时还没有 Conversation ID。

维护 catch 会继续其他 stream，说明它不会直接让整个 Executor 流水线同步抛错；**不说明受损会话的历史投影、搜索、观察恢复完全不受影响**。现场成功任务也不能排除局部导航故障。null.length 的具体解引用仍未定位，应保留“待定位”，补阶段、堆栈、Account/Conversation 与重建 epoch 后再做针对性中间态注入。

guangda 的缺表已独立确认。应作为 schema/安装一致性问题调查迁移链、实际数据库和安装版本，走验证副本与正式迁移；不能由维护循环偷偷建表或把错误吞掉。它的根因优先级不应因为限流而降低。

[task-state-reconciler.ts](../../src/execution/task-state-reconciler.ts) 无动作仍返回 consistent，组合根每分钟打印；更值得修正的是 main 在 help/status 分支之前就执行 reconciler，**状态查询也会进入可写修复路径**。建议周期修复只属于 Server 生命周期，显式 maintenance 命令独立保留。成功无变化不打印；持久阻塞记录首次、变化和有节制的持续时长摘要。原文“98.5% 没有信息量”宜改成“重复噪声占绝大多数”；错误首条仍然重要。

### A4：工具链环境缺口成立，不能统称沙箱或直接只读透传

证据：[pi-cli-driver.ts](../../src/executor/pi-cli-driver.ts)、[codex-cli-driver.ts](../../src/executor/codex-cli-driver.ts)、[harness-driver.ts](../../src/executor/harness-driver.ts)、[container-compatibility-adapter.ts](../../src/executor/container-compatibility-adapter.ts)。

- Pi 显式使用 attempt HOME；宿主环境白名单不继承 CARGO_HOME/RUSTUP_HOME/GOPATH。依赖用户 HOME 安装的工具确有不可发现或缓存失效风险。
- Codex 显式隔离的是 CODEX_HOME，没有同样设置 HOME；不能把 Pi 行为推广到所有 Executor。
- 原文所引 Docker `HOME=/tmp` 位于 **probeProgram 的版本探测容器**。真实 Pi attempt 的 HOME 由 driver 设置到 `/runtime-home`。
- ADR-0024 定义 Native 为可信宿主进程，attempt HOME 隔离不等于文件系统沙箱。工具链是否失败取决于实际安装位置、镜像、wrapper 和环境；不能断言所有需要系统工具链的任务必失败。

环境变量和符号链接自身没有“只读”属性。CARGO_HOME 可能含 credentials/config，并需要 registry/cache 写入；Go/npm 缓存也需要独立可写位置。建议明确工具链只读内容、独立可写缓存和禁止继承的认证配置，以版本化配置绑定到 backend 并做真实工具探测。Docker 优先使用固定镜像内工具链；任意 homeMounts 不是小修，须纳入资源授权、指纹和恢复审计。

### A5：忽略产物丢失成立，但缺口主要在固定快照运输

原文“交付清单只有 delta.changed”不准确：

1. [completion-protocol.ts](../../src/execution/completion-protocol.ts) 的 collectDeclared 已遍历 `fileOutputs` 对应的现存普通文件，不要求文件出现在 Git delta。
2. [workspace-publication-worker.ts](../../src/execution/workspace-publication-worker.ts) 的 artifactSources 将 edit delta 与 originalCompletion.artifacts **合并**；report 也可有声明文件。
3. [managed-git-workspace.ts](../../src/execution/managed-git-workspace.ts) 的 commit 使用 git add -A，忽略未跟踪产物不会进入 commit。
4. deliverIntegrated 从 withCommitSnapshot 的固定 integration commit 读取文件；因此声明产物可能通过完成检查、进入清单，仍因快照缺文件而交付失败。

不声明时可能漏交付，声明时可能交付失败，是两个不同表现。只添加 `git status --ignored` 或重复新增 fileOutputs 通道不解决第 3/4 步。

建议：以已经授权的声明清单为界，把字节、真实内容哈希、文件模式绑定到候选版本。可以对有限声明文件明确纳入受管 Git，或进入内容寻址对象存储并在固定版本交付时物化。必须同时覆盖依赖 handoff、重启重试和 GC；不能临时读取会继续变化的原 attempt 目录。不得把全部 target/node_modules、缓存或凭证当工程树交付。单文件 64MiB、2000 条发布和声明目录 1000 条检查上限也要明确，不能承诺任意构建树全量交付。

### B1：服务拒绝污染外层 application，是当前最直接的阻塞故障

实际链路：

```text
authorize_task_control application
  -> SessionKernelRuntime.applyTaskControl
  -> KernelExecutionRuntime.manageLocalService
  -> readSpecification 前置拒绝，或内层 managed_service_requested/reject_request
  -> throw
  -> 外层 DurableKernelWorkflow 标记 uncertain
  -> 通用恢复返回 not_managed
  -> TaskResidueReader 看见 kernel_application
  -> 终态 Task 的 Conversation slot 仍保留
```

证据：[session-kernel-runtime.ts](../../src/session/session-kernel-runtime.ts)、[kernel-execution-runtime.ts](../../src/execution/kernel-execution-runtime.ts)、[kernel-workflow.ts](../../src/kernel/kernel-workflow.ts)、[kernel-application-recovery.ts](../../src/execution/kernel-application-recovery.ts)、[task-residue-reader.ts](../../src/execution/task-residue-reader.ts)。

内层 reject_request 正常 return null 后已经可以 markApplied；污染的是**外层授权应用**。而“代码未发布”还可能在内层 event 创建之前抛出。P0-3 只处理 workflow.submit 之后的 rejection 不完整。

P0-4 单纯从 UNMANAGED_ACTIONS 移除 authorize_task_control **也不奏效**：其后没有该 action 的后置条件分支，会进入 default 的 unresolved。该 action 同时包含取消、恢复、清理等非纯观察操作，绝不能整体放入 EFFECT_FREE_ACTIONS。

建议以结构化结果区分 `rejected_without_effect`、`operation_settled` 和 `effect_uncertain`，持久化拒绝/操作结果并把父 application 与子 event/effect 稳定关联；只有确知已拒绝或已完成时收敛外层。回放同一个父 decision 不应生成新的随机子请求。错误信息缺少服务 ID/归属状态的修正合理，但必须遵守当前 Conversation 授权可见范围。

历史两条 service_start uncertain 是修复候选，不等于可以按 error_summary 字符串自动批量 applied。要核对决策、版本、子操作、进程 token 与无副作用证据；未证明的继续显示明确恢复事项。第三条 plan 错误需单独处理，不能套服务规则。

另一个原文低估的影响：[conversation-task-scheduler-repo.ts](../../src/storage/conversation-task-scheduler-repo.ts) 将 occupied/releasing/recovery_blocked 都计入 Account 容量。槽位首先堵本会话，也消耗全局并发额度；当上限为 1 或残留占满额度时，其他会话同样受影响。“换新会话不受影响”不是无条件成立。

### B2：服务生命周期耦合真实，但“终态都拒绝/每轮新建”错误

[control-kernel.ts](../../src/kernel/control-kernel.ts) 仅对非 stop 的 cancelled/archived/failed 拒绝，**done 不在其中**。同一 owner Task、相同服务规格且公开文件完整时可以再次 start/restart。服务仅在显式启动路径登记；未启动的 Task 不创建服务。

[managed-local-service.ts](../../src/execution/managed-local-service.ts) 与 [managed-local-service-repo.ts](../../src/storage/managed-local-service-repo.ts) 确实把相同 serviceId 固定到完整 specification，改变 taskId、command、args、port 等都会被拒绝；没有正常规格升级路径。问题是长期服务缺少独立生命周期和显式规格版本更新，而不是服务标识必须每轮生成。

[server-composition.ts](../../src/server/server-composition.ts) 的 resolvePublishedDirectory 会验证该 Task 所有 published public file 的哈希与 delivery，普通文档被用户改动也能导致服务“代码尚未发布”。应将历史交付证明与当前可启动版本验证分开；目录存在本身不足以证明执行授权。

### B3：跨 Task 并非只有两条通道，publicProject 也非必然失败

- publicProjectDirectory 在新 Task 创建时重新 capture baseline。用户**在这次快照之前**的修改会进入新基线；发布目标与新基线一致时，这个 preflight 不会仅因“过去改过”拒绝。真正需要冲突处理的是工作开始后用户与执行结果的分歧。
- Git Workspace 还有 [public-workspace-git.ts](../../src/delivery/public-workspace-git.ts) 的整体 clean gate：即使文件哈希通过，只要仓库仍有未提交修改也会拒绝。只删除 preflight 哈希检查无法实现 V3。
- 已有 `ContextRef.kind=artifact` 跨 Task 输入：Planner 提供同会话 artifact 索引，[subtask-execution-context.ts](../../src/execution/subtask-execution-context.ts) 验证 Account/Conversation/Workspace/哈希后复制到 attempt inputs。它不等于共享可写工程，但足以否定“交付产物完全不跨轮”“只有两条通道”。
- Conversation 历史主要来自持久 Pi session 和 Planner MCP。[memory-context-service.ts](../../src/memory/memory-context-service.ts) 的 preparePlanningInitialContext 无生产调用，不能以其中 recallAsync 证明当前运行接线。

**新增发现：选中的 Git 子目录与执行根不一致。** runDispatchItem 将 source 指向 publicProjectDirectory，但 ManagedGitWorkspaceService.detectSource/ensure 又提升到 Git toplevel。完整复现证实 repo/project 变成整个 repo 的 worktree；之后交付相对路径却仍拼到选中的 project，存在路径重复、导入旁支文件及错误发布范围风险。应明确 repositoryRoot、selectedRoot 与相对 prefix 的映射并做端到端测试。新会话目录在 Git Workspace 下也会遇到同样问题，改目录归属不会自行解决。

### B4：经验卡问题是采集/晋级/送达断链，改归属不解决

task_id UNIQUE 只规定“每 Task 至多一张”，不规定每轮自动生成，也不禁止跨 Task 查询。TaskMemoryCardRepo.listRecent 为全库查询，搜索索引也有 memory_card 来源。

源码中 reflectOnTaskCompletion 只有定义，没有生产调用；写卡在 `/learning promote`。当前 Planner searchTasks 查询 Task 元数据而非这些卡。结合两套库均为 0，不能从这个故障推出“Task 卡必须合并为一张 Conversation 卡”。

保留 taskId 作为来源、增加 Conversation/Workspace 检索维度可以成立；覆盖成会话单卡会损失任务成果、结论冲突和时间出处。应与[记忆系统方案](../plans/2026-10-22-memory-system-tdai-integration-design.md)协调，单独打通采集、准入、检索与证据送达。本评审没有因此批准该记忆后端方案。

### B5：关键词验收器存在，但不是当前生产认证路径

TestEvidenceVerifier/ArtifactVerifier 中确有正则，而且“未运行测试”也能满足测试说明；但生产调用 VerificationAndDeliveryService 的是通知投递，**没有 prepare/prepareAsync 的生产调用**。当前认证在 Completion Protocol、SubtaskAttemptRunner、固定版本 publication/delivery 和 Kernel；其 acceptance 类型是 `key/description/requiredEvidence`，与旧 verifier 的 `id/severity/appliesToSubtaskIds` 不同。

因此“同一任务换措辞被这两个 verifier 判成不同类型”未被当前生产调用链支持。删除死路径是清理技术债；新增可执行验收是独立能力建设，不能写成替换两个正则就完成的修复。当前有契约/文件/身份认证，也不应将其称为已经具备独立业务质量验证。

## 4. 目标模型的合理部分与必须修改的部分

| 提议 | 评审结论 | 必须补齐的边界 |
| --- | --- | --- |
| 会话默认长期使用一个交付根 | 合理的产品选项 | 不等于 Executor 在公开目录直接写；按 Account/Workspace/Conversation 绑定稳定身份、路径可用性和来源版本 |
| 一个会话无例外等于一个目录/项目 | 当前证据不足以支持强制 | Workspace 已可含多会话；需回答已有项目根、多个会话协作、目录迁移与空会话重绑。不能把每个会话都直接绑定同一 Workspace root 又声称相互隔离 |
| 每轮一 Task | 适合新的工作请求，不适合作为通用基数 | 服务控制、状态查询、澄清、同 Task 恢复不会都创建新 Task；Turn/Task/版本不要强制 1:1 |
| 作品用子路径区分，不按报告/代码分目录 | 支持 | 内容格式不应决定持久目录，但 scratch、服务运行数据、认证配置不自动成为交付内容 |
| 用户修改记一个版本，不阻断 | 有条件支持 | 开始工作前采集当前版本；结束时比较 base/current/candidate。非冲突合并，冲突保留两侧；“先备份再覆盖”仍会丢掉用户当前意图 |
| 删除发布/启动哈希锁 | 不支持直接删除 | 历史证明、并发比较、当前内容授权是三种用途；保留内容身份校验，以显式新版本替代“一经改动永远不认” |
| 每轮结束记版本、指针回滚 | 方向合理，现方案不完整 | 持久字节/对象引用、父版本、删除 tombstone、权限模式、发布/验收状态、CAS 切换与中断恢复。回滚须物化文件并记录新的恢复操作，不能只改指针 |
| 服务改为会话归属 | 可作为阶段性模型 | 独立 service identity + specRevision + launchRevision，Task 留来源；显式启动/升级授权，Account/Workspace/Conversation 校验，owner Task 取消不能禁止关闭服务 |
| 以最新声明为准 | 不支持无条件采用 | 规格更新先明确 stop/restart/reconfigure 决策，校验旧进程所有权和待运行版本，保存操作事实；恢复不能重复启动 |
| 唯一互斥资源是端口 | 错误 | 服务 ID、公开路径、Git refs/index、工作区发布、共享运行数据也有并发约束；端口还涉及 host/address family，probe-close-spawn 存在竞态 |
| 会话归档时才清 workspace_records | 不支持直接迁移 | 该表是私有 Task/Generation/Subtask worktree，非公开目录。保持短期执行数据回收，持久版本/服务引用对象单独保留；归档不等于删除用户文件 |
| deliveryKind 仅展示 | 可讨论，但不是小改 | 它当前参与 noChangeReason 认证、图片约束和 edit delta 发布；替代契约必须显式规定哪些文件变更需要交付，避免交付所有研究临时文件 |
| 新建 projects 表 | 暂不以修故障为由引入 | 先定义是否需要跨会话共同资产；若 Workspace+交付绑定已足够，不增加第二套项目身份。若需要则正式 ADR 明确权限/共享/并发 |

推荐保持四层：**Workspace/Conversation 组织 → 稳定交付目标与版本 → 独立 Task 和私有执行 worktree → 版本化 Service 实例**。记忆仍是独立领域，以来源事实和授权引用参与工作。

## 5. 可执行验收方案的评审

统一的判据数据结构比按业务类型硬编码更好，但“所有工作必须可执行验证”不成立：报告正确性、审美、研究覆盖不能由章节数和引用数证明。可执行检查只证明其声明的机械条件；manual 是人工接受事实，不能自动判 pass。

P2 必须接入当前 Work Graph/Completion/Kernel 契约，至少定义：

1. checkId、契约版本、Task/Generation/Revision、目标文件/commit、运行证据、结果状态及 manual 决策主体。
2. command 的 executable/args/cwd/envRef、权限档案、超时、输出上限、取消、幂等与重启恢复；不能在 Gateway/Kernel 内直接运行任意 shell。
3. http 的目标授权、网络/重定向边界、响应限制与服务实例关联，不能拿另一个进程的 200 当本服务成功。
4. files/content 的版本和安全路径、内容解析上限；已有满足需求的文件不应一律要求 modifiedThisRound=true。
5. 验收对象是 candidate、公开交付还是运行实例，以及失败后候选保留、当前版本是否推进、如何重试。构建检查可能改文件，必须避免验证后版本被再次改变。
6. Runtime 执行并记录事实，Kernel 决定完成、重试、阻塞和人工接受。人工决策走现有受理/身份/幂等路径，不创建另一个任务状态机。

取消/验收失败应保留稳定资产身份，这点支持；但不能规定失败内容必定覆盖已运行的稳定版本。外部动作也无法靠文件回滚撤销，必须独立记录其结果。

## 6. 分期调整建议

| 阶段 | 建议范围 | 放行条件 |
| --- | --- | --- |
| P0 可靠性 | 维护 idle/error 退避与上下文日志；Server 生命周期限定 reconciler；确定拒绝结构化落账、外层 application 收敛；guangda schema 一致性调查 | 纯拒绝不留 uncertain，真实不确定仍留待恢复；不靠直接 SQL 清槽位；无工作退避且新工作及时唤醒 |
| P1 交付闭环 | 声明产物在固定版本中的字节运输；Git 子目录映射；工具链/缓存环境修复；区分用户前置编辑与执行中冲突 | 非 Git/Git、声明 ignored 文件、重启交付、路径前缀、用户并发修改均验证 |
| P2 稳定资产与服务版本 | 决定交付根规则；实现内容版本与引用/GC；服务身份脱离单轮生命周期，显式升级与启动版本；设计再做迁移 | 同会话三轮修改、跨会话同路径冲突、取消后服务操作、回滚与重启一致 |
| P3 可执行验收 | 当前契约上的 check 与 durable run；清理未接线 verifier | 机器判据证据可重放，manual/未知结果不冒充成功，验收副作用不越权 |
| 独立记忆工作 | 采集/晋级/检索/送达与来源事实 | 与已有记忆方案统一，不能仅改表 scope |

原 P0 的 1–2 天与 P1/P2 各 1 周不能在当前缺少恢复、版本字节存储和迁移设计时当承诺。特别是“P0 不改表”不应成为省略父子操作持久关联的理由；可复用现有 ledger/effect 字段，但必须先证明身份关系与回放。

ADR 同步清单至少包括 0021、0022、0023、0024、0025、0032、0035、0037；当前并发依据是 **ADR-0037**，不是原文 D4 所列旧单任务依据。目录权限/历史证据和客户端投影变化还需核查 0038、0043。所有新职责继续遵守 ADR-0020。任务状态同时受[任务状态落地方案](../plans/2026-10-22-task-state-implementation-plan.md)影响，操作结算与验收契约必须统一。

## 7. 迁移方案：当前不足以安全执行

原 §6 不能直接用作迁移脚本规格：

- 最新 integrated 不等于最新 succeeded delivery，也可能只是一个 Subtask 的增量。按最新 Task 目录或同名文件时间排序无法重建完整当前树，尤其不能表达删除与用户本地修改。
- 哈希与清单不能还原字节。只保留旧目录引用时，目录一旦清理/修改历史就不可回滚；私有 Git 数据又可能按原 retention 清理。V7 与“只记哈希、允许清源目录”不兼容。
- 必须按 Account/Workspace/Conversation 确认归属及路径，不能根据标题相似或端口相同自动合并项目。缺失、符号链接、不同路径大小写、覆盖和嵌套目录应列为迁移异常。
- 服务迁移要处理尚存进程的原 cwd、process token、spec/taskId、环境引用和效果记录；数据库改到新根不会移动运行进程。端口占用探测后仍须处理 spawn/bind 竞态。
- 历史 artifact ID、内容哈希、下载/ContextRef 链路和历史 Task 查询要继续指向正确版本。不能让旧 artifact 默默指向共享目录的新内容。
- 不宜默认向用户源目录写 MIGRATED.txt：它会改变 Git dirty 状态并影响用户工程。优先系统迁移映射/客户端提示，源数据保持原样，清理由用户明确选择。
- 经验卡目前没有现场数据；若别的安装存在卡，应保留各卡及 taskId 出处，新增索引/关系，不按更新时间破坏性合并结论。

推荐迁移流程：只读盘点与冲突报告 → 确认稳定资产绑定 → 物化可校验的初始版本及历史字节 → 停写/服务切换窗口 → 幂等迁移 checkpoint → 验证全部历史引用与当前内容 → 保留旧布局及撤销映射。不可恢复的历史应明确标记“内容不可用”，不能声称可回滚。

## 8. 验收补充与现有覆盖缺口

已审阅维护、受管服务、公开交付和 application recovery 的既有测试。它们覆盖基本错误隔离、服务重启/所有权、幂等发布、外部删除冲突等；不能据此证明新的跨轮/迁移模型成立。

建议将 V1–V7 扩充为以下可重复检查：

1. 空库与大量已收敛会话均退避；有 dirty/rebuild 时及时唤醒；损坏会话不饿死健康会话；持续错误有计数且日志有界。
2. help/status 不执行周期 reconciliation；实际 Server 重启仍执行所需恢复。
3. 拒绝发生在 manifest 读取、归属校验、Kernel 拒绝、effect 执行等各阶段，分类准确；存储异常/进程状态未知不能误判无副作用。
4. 父授权、子决策、spawn 和 effect 落账之间逐点中断；重启不重复 start/restart，历史明确拒绝能通过证明收敛。
5. 槽位释放及下一 Task 只启动一次；并发上限 1/2 下验证残留对其他会话容量的影响。
6. 用户开始前编辑、执行中编辑、执行中删除/重建、两个会话同文件写入均保留用户内容；Git 的 clean gate/HEAD/index 变化有明确策略。
7. Git 根、Git 子目录、非 Git 项目都保持选定根的路径映射；新目录第一次交付所需基线文件不会遗漏。
8. 忽略但声明的已有/新建文件可进入固定版本、下游输入和恢复交付；未声明缓存仍不交付；大文件与符号链接明确失败。
9. 同 serviceId 显式升级规格，旧进程关闭、启动新版本、失败恢复可核验；普通文档编辑不误报整个代码未发布。
10. owner Task done/cancelled/archived 的服务操作符合新策略；跨会话越权仍拒绝；未授权的新 manifest 不自动启动。
11. 工具链验证覆盖 Native Pi/Codex、Docker，以及 Rust/Go/npm 独立缓存；身份配置不会跟缓存混入。
12. 回滚真实还原字节、删除项和 executable mode，保留当前用户未提交改动的处理路径；外部副作用不承诺文件回滚可撤销。
13. 验收与精确版本/服务实例绑定，取消/超时/重启不重复副作用；manual 需真实受理事实；已有文件无需强制重写。
14. 迁移可中断重跑/撤销；历史 Task/receipt/publication/artifact 引用数与迁移前快照一致；内容缺失明确标记。
15. 私有 worktree 清理不删除公开资产；历史对象只在没有版本、artifact、service 引用时 GC；会话归档不自动删用户文件。

V1 宜改为“无重复无效日志、后台 CPU 在固定环境与相同数据规模下显著降低”，不要求有合法后台事件时日志零增长。V2 要区分确定性拒绝与真正未知副作用。V3 应要求无冲突前置编辑成功、冲突时不丢内容。V7 的回滚必须检查字节与引用，不能只核对表行数。
