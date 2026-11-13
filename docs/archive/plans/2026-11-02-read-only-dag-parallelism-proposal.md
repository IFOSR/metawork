# DAG 只读子任务并行优化提案

- 日期：2026-11-02
- 状态：设计提案，未实施；不代表现有执行契约已变更
- 范围：共享 Conversation Worktree 的只读子任务并行、资源等待投影

后续评估：用户提出所有 Subtask 使用独立 Worktree 的统一并行方案，见
[两级 Worktree 可行性评估](2026-11-02-subtask-worktree-feasibility-assessment.md)。
用户随后要求暂缓大改动，当前收窄建议见
[只读文本研究任务并行方案](2026-11-02-read-only-research-parallelism-plan.md)。
当前已收敛为节点级共享读锁方案（见上方链接），不建立临时 Worktree；本文的
整图只读资格和 Host 强制保护前提保留为早期备选，未实施，不代表当前范围。

## 事实与问题

2026-11-02 的产品规划评估任务声明 `workspaceIntent.operation=read_only`，
四个子任务均为 `deliveryKind=report`、`fileOutputs=[]`。前三个节点无前置依赖。
08:40:55（Asia/Shanghai）协调器在同一批次下发前三个节点；海外调研节点取得
Conversation Worktree 根路径 write lease，另外两个节点出现
`partition_conflict_observed`，落为 `not_started`，并等待同一个租约。

源码还有第二层独占：`claimConversation()` 使用单一 `owner_token`。只修改
ResourceLease 的 write/read 参数仍不能实现并行。

2026-10-29 的会话 Worktree 技术方案 §6.3 明确规定所有同会话 Attempt 串行，
包含 read_only。因此此次现象符合该阶段设计，但限制了 ADR-0053 所述 DAG
并行产品目标。UI 按拓扑层显示“可并行”，按依赖 frontier 显示“可调度”，
没有说明资源等待，造成预期不一致。

## 推荐方案

### 1. 在同一 Workspace 模型中开放受保护的只读并行

首期资格取现有已授权事实的保守交集：Task 声明 read_only、Subtask 为 report、
无文件交付要求，并且 Host 已证实能够实施对应文件保护。服务启动、服务修复、
目标程序执行和写入任务继续走独占路径。混合读写图的节点级 effect 契约不在首期
引入；后续另行设计，不能用标题或自然语言关键词推断。

保持 Conversation Worktree 作为执行目录和 Workspace 身份。每个 Attempt 使用
独立临时目录；Host 允许写自身临时目录及必要运行时目录，保护业务文件、Git 元数据、
用户 Workspace 与其他 Attempt 的临时目录。容器和原生后端分别提供可验证的强制
执行能力。现有原生 prompt/accessMode 提示不构成该能力，不能直接据此放开并行。
不删除 Harness 的 shell/edit/write 工具；文件效果由 Host 执行边界约束。

共享读租约保证读取期间业务树稳定；多个读者可并行，任何共享业务树写入、同步、
封存或清理须取得独占资格。若现有原生后端不能实现上述保护，须先补齐并验证 Host
能力，期间继续明确展示串行原因。不能将“执行后检测到写入”当作并行隔离保障。

### 2. 分离 Task 会话占用与 Attempt 资源占用

Conversation 的顶层 Task slot 仍由一个 Task 持有。Worktree 生命周期占用改为
Task/操作级，并以持久化 Attempt 租约记录多个只读读者，替换每个 Attempt 争抢
单一 owner_token 的执行语义。Planner、同步、交付和清理等现有占用调用方须一起
审计迁移；不能只跳过 claimConversation。

每个读者独立心跳和释放；一个 Attempt 完成不能释放其他读者或提前清空 Task
slot。取消/重启恢复先确认进程与子进程结束，再释放相应占用；租约过期本身不能
作为启动新写者的证据。独占操作需避免被持续新读者饿死。

### 3. 只读完成不修改共享 Git 树

只读 Attempt 独立落 receipt、结果与 outgoing handoff，复用固定输入提交引用，
不执行会扫描或提交其他 Attempt 临时文件的 sealAttempt 路径。临时目录从业务树
delta、Git 封存、附件与最终交付中排除。只读 Task 不产生 Workspace 变更交付。
原有“done 与 outgoing handoff 同事务完成”不变量继续适用；恢复/补落路径遵循
相同规则，不能在 finally 中重新触发共享封存。

### 4. 调度与界面投影使用真实等待事实

由 Runtime 汇集容量、资源等待、后端能力与占用事实，协调器在既有 dispatch
链路中选取可执行节点；启动时保留原子 claim 以处理竞态。等待复用现有持久化
resource_waits 与唤醒机制，避免明知独占冲突仍反复创建未启动 Attempt。

UI 将“阶段 1 可并行 3 项”改为“依赖层级 1 · 3 个独立子任务”，另行显示运行、
等待并发名额、等待工作目录、等待前置结果的数量与节点原因。运行时原因来自
服务端统一投影，UI 不另行推断调度政策。

并发数受账户空闲额度和单 Task 空闲额度共同约束。代码默认账户上限为 4、
单 Task 上限为 2；本次任务绑定的配置 revision 也确认为账户 4、单 Task 2。
实际配置以生效 revision 为准。上限为 2 时预期是两个运行、
一个等待名额；要求三个同时运行需单 Task 上限及账户剩余额度均至少为 3。

## 模块归属与实施顺序

1. 先修正文案和持久化等待事实投影，使当前串行限制可见。
2. 修订 ADR-0050 的会话执行约束及相关并发契约，更新 CONTEXT 与技术总览。
   保持 ADR-0020/0053 的边界：Planner 提案，协调器管理持久化执行事实，
   Runtime/Host 执行保护，Harness 拥有工具和内部循环。
3. Resource Model 定义读写冲突与租约规则；Workspace/Execution 定义生命周期
   占用与完成接口；Storage 实现事务、迁移与恢复；所有消费者迁移到同一接口，
   不保留第二套会话锁或第二条调度路径。
4. 实现并验收原生 Host 文件保护、读者占用、只读完成、调度与恢复，完成后开放
   相应后端的并行能力。持久化变更同步更新 Repository 与 Docker 测试。

## 验收标准

- 同类三分支 DAG 在额度为 3 时三个 Executor 生命周期真实重叠；额度为 2 时
  两个运行，结束一个即启动第三个。
- 只读 Attempt 的 shell/子进程无法修改共享业务文件、Git 元数据、用户源目录、
  兄弟临时目录；自身临时文件可用。原生与容器分别验证。
- 读读兼容，读写/写写互斥；Planner、同步、封存、交付、清理不穿透活动读者。
- 首个读者退出不释放其他读者；取消、进程崩溃、Server 重启不重复执行、不误释放。
- 文本结果、receipt 与 outgoing handoff 完整，综合节点只在三个上游真正完成后启动。
- 无临时文件误封存、误交付；UI 原因与持久化事实一致。
- 完成 owning-seam 测试、数据库/Docker 回归、lint 和真实原生研究任务冒烟；
  实施完成后补记完成日期、交付行为、验证结果和 closing commit。

写入子任务的全面并行需要独立写入隔离、依赖输入组合与合并归属设计，作为后续
架构议题；本提案不承诺仅通过放宽共享写锁实现。
