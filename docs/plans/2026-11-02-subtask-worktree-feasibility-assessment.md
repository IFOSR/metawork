# Conversation / Subtask 两级 Worktree 可行性评估

- 日期：2026-11-02
- 状态：可行性评估；建议方向，未批准实施、未修改运行契约
- 用户提出：每个 Subtask 独立 Worktree 并行执行，完成后串行合并到 Conversation，
  再复用已有 Conversation → Workspace 的交付流程。
- 关联：[只读 DAG 并行提案](2026-11-02-read-only-dag-parallelism-proposal.md)

后续范围调整：用户要求暂缓通用方案，先评估只读优化，当前建议见
[只读文本研究任务并行方案](2026-11-02-read-only-research-parallelism-plan.md)。
本文作为后续架构参考保留，未实施。

## 结论

技术上可行，适合恢复 DAG 的通用并行能力，覆盖文本研究和文件写入。推荐作为
长期方向继续设计。它在现有单一私有 Git 模型内增加 Subtask 隔离层，无需再按
只读/写入区分目录实现，但会增加一层持久化集成与恢复语义，属于架构变更。

“两级”指分支结果的归属与合并关系。Git linked worktree 本身没有父子层级；
全部目录应是同一 Workspace 私有仓库的平级 worktree，具有独立分支、HEAD、
index 和文件目录，共享对象库。Subtask 目录放在账户内部独立目录，不能物理
嵌套在 Conversation 工作目录中，避免扫描、打包和清理误收子目录。

## 当前实现依据

- `src/execution/conversation-worktree-service.ts`：当前 sealAttempt 扫描共享
  会话目录并推进会话分支；sealTask 固定最终提交。需要把 Attempt 封存归属迁移
  到 Subtask，而不是只替换启动 cwd。
- `src/storage/workspace-git-repo.ts`：单一会话 owner_token 目前覆盖整个
  Attempt。需要改为 Task 生命周期占用、Subtask 执行租约和会话集成锁分别负责。
- `src/execution/workspace-merge-worker.ts`：已有串行队列、固定候选、operation
  refs、冲突与恢复，但还耦合用户目录外部编辑捕获和逐文件写回，不能直接用作
  内部 Subtask 合并 worker。
- `src/execution/managed-git-workspace.ts` 与对应测试：保留旧的每 Subtask
  Worktree、直接依赖 Git ancestry 组合、候选合并机制，可以参考算法和测试。
  旧实现采用每 Task generation 仓库和旧发布/修复契约，不能直接重新启用。
- ADR-0025 曾定义子任务并行和发布边界；2026-10-29 会话 Worktree 方案明确
  收缩为同会话串行。新方案须明确修订现行约束，不将历史实现当作现行兼容路径。

以上为源码和契约评估，尚未实现两级模型，也没有新模型的性能或恢复测试结果。

## 推荐运行模型

```text
Workspace 私有仓库（同一个对象库）
  Subtask A 分支 / Worktree ──┐
  Subtask B 分支 / Worktree ──┼─ 会话内部串行集成 → Conversation 分支 / Worktree
  Subtask C 分支 / Worktree ──┘                         │
        并行执行                             Task 验收并固定最终提交
                                                      │
                                        Workspace 现有串行交付队列
                                                      │
                                             私有 main → 用户目录
```

不同会话各有内部集成队列，可独立推进；整个 Workspace 的外层交付继续串行。
Executor 只执行自己的 Subtask Worktree；会话目录由 Runtime 集成、规划观察和
任务最终验收使用。Git 公共元数据操作保持短锁，不能持有全仓长锁运行模型或测试。

### 分支基线与 DAG 输入

每个 Task generation 固定经验证的会话基线提交。无依赖节点从该基线创建分支；
有依赖节点从同一基线组合已声明直接依赖的固定输出提交，保留完整 Git ancestry。
组合顺序应稳定、可审计；若依赖输入彼此冲突，先形成输入组合冲突事实，不能把
冲突标记当作正常输入启动 Executor。

不推荐节点开始时直接取当时 Conversation HEAD：例如 A、B 独立，D 只依赖 A，
如果 B 恰好先合并，D 就会意外读到 B，形成时序决定的隐式依赖。固定基线和依赖
提交使排队、重试和并发额度变化不会改变节点输入。记录 `baseCommit`、依赖提交
集合、实际 `inputCommit`、`outputCommit` 与 `integrationCommit`。

节点的输出提交与会话汇总提交是不同事实。下游通过明确的边获得结果和固定文件
版本，不把会话汇总提交直接当作某个上游的输出。如果跨分支冲突修复改变了已完成
上游的业务含义，必须显式形成修订及依赖失效/重规划，不能悄悄改写已交接结果。

### Worktree 生命周期

建议 Worktree 归属 `(taskId, generationId, subtaskId)`。首次启动时幂等建立，
普通 retry/continuation 在确认前一个进程终止且恢复事实允许后复用；重规划后的
新 generation 建立新身份。并不是每次 attempt 都从会话 HEAD 新建空白 Worktree。
同一个 Subtask 仍最多一个活动写者。

执行目录可在完成和留存期后清理，但被 handoff、附件、结果和恢复引用的提交必须
由 durable refs 固定保留。清理不得只依据进程退出或模型回答完成。

### 完成与内部合并

有变更节点建议采用以下边界：

1. Executor 结束且残余写进程收束，Runtime 校验结果并封存 Subtask 候选提交。
2. 保存 Attempt receipt，Subtask 进入 awaiting_integration。
3. 候选以幂等身份进入该 Conversation 的持久化内部合并队列。
4. 串行完成三方 merge、必要验收，固定 integration commit。
5. 同一数据库事务落集成完成事实、Subtask done 与全部 outgoing handoff，
   再唤醒下游；Git 与数据库之间使用 operation journal/ref 对账，不能假设原子。

无业务变化的节点记录经验证的固定输出和文本 handoff 后可以直接完成，不制造
空 merge；节点目录模型仍一致。外层 Workspace 写回以整个 Task 的固定结果为
单位，内部子任务完成不等于已向用户目录交付。

建议内部首期按候选已就绪并持久化的顺序串行合并，sequence 一经分配不可变。
不用拓扑整层屏障等待慢兄弟，也不预先让未完成节点占住队首。该规则保证重放
顺序稳定，不保证不同运行的完成顺序一致；若要求跨运行相同合并顺序，需要另行
采用固定授权顺序并接受队首等待。当前 ADR-0025 的旧确定性排序约束须同步修订。

### 冲突与验收

串行 merge 消除多个 writer 同时改目标目录的竞态，但不消除同一行、删除/编辑、
二进制和逻辑语义冲突。首期建议冲突暂停本会话的内部合并，其他已启动分支可
继续执行并保存候选；依赖冲突节点的下游等待，其他会话不受影响。

保存 base/ours/theirs、目标 head 和候选版本。修复由 Executor 在独立修复目录
内进行，完成后重新验证目标版本、合并和测试；不在会话目录中运行长期修复模型。
用户决策只用于无法自动收束或必须由用户选择的情况。不能静默 take-ours/theirs。

合并无文本冲突不证明业务正确。保留各节点验收，并在 Task 汇总提交上做适用的
构建/测试/产物检查。验收基于固定提交，可在隔离的验证 Worktree 执行，避免测试
产物污染会话集成树。二进制文件不能自动语义合并；高冲突的任务仍应由 Planner
明确依赖或调整分工。

### 恢复与取消

队列记录绑定 Task/generation/Subtask/attempt、输入和候选 OID、预期目标 head、
集成 OID、operation ID 与取消 fence。Git merge 完成但数据库未提交时根据 operation
ref 收敛；重复事件不重复合并。旧 generation 和取消后的迟到结果不得继续集成。

已合入会话的内部成果需要保留来源，在取消/重规划时显式决定保留或回退。新 Task
不能自动继承未交付的取消残留；不能在有其他节点运行时用随意 reset 删除现场。
Task 最终交付前确认所有必需节点已结算、内部队列已收束且最终验收通过。

## 成本与边界

| 方面 | 评估 |
| --- | --- |
| 写入并行 | 不同目录可独立编辑和测试，适合修改不同模块/文件的节点 |
| 合并延迟 | 新增内部串行阶段；通常可与其他节点执行重叠，收益需实测 |
| 磁盘与准备 | 对象库共享，检出文件仍占空间；node_modules/venv 等非跟踪依赖不自动继承，需每目录准备或可靠只读缓存 |
| 大文件 | 二进制版本和多目录检出增加 I/O/空间；不能宣称 Git Worktree 零复制 |
| 执行能力 | 相同模型/Provider 额度仍约束并发；本次任务单 Task 配置上限为 2 |
| 外部副作用 | Worktree 不隔离端口、数据库、浏览器配置、远端账户与部署；继续由现有资源/Host 规则管理 |
| 文件边界 | Worktree 不是安全沙箱，原生进程仍可能按绝对路径访问兄弟目录或共享 Git 元数据；需保持授权根、Host 边界与受管 refs 保护 |
| 复杂度 | 多一层候选/合并/冲突/恢复/清理，主要成本在状态一致性而非 git worktree add |

## 实施影响与建议门槛

推荐先完成详细设计，再实施此方向；前一份只读共享目录并行提案保留为备选，
不同时引入两套新的执行路径。若选择本方向，普通 Subtask 统一使用隔离 Worktree。

主要 owner 不变：Planning 提供 DAG；Work Graph 定义依赖与输入；Coordinator
维护生命周期和持久化调度；Execution/Workspace 执行 Git、租约和合并；Storage
持久化；Host 保护执行边界；客户端仅展示执行/等待合并/冲突/交付事实。

复用 Git 操作、幂等 journal、固定结果版本和队列机制，但内部合并不得调用外层
用户目录 capture/writeback。共享通用底层机制，分别保留会话内部集成与 Workspace
用户交付的生命周期语义。既有旧发布分支应迁移/退役，不能添加第三套隐式执行模式。

涉及 ADR-0050/0037/0021/0025、CONTEXT、技术总览，以及 workspace binding、
attempt runner、会话占用、终态/handoff、内部队列、恢复、附件路径和 UI 投影。
数据库变更与 Repository/Docker 测试必须一起完成。

首批验收应覆盖：三节点并行写不同文件、同文件冲突、只依赖 A 的 D 不读到 B、
菱形 DAG ancestry、无变化研究节点、合并后的组合测试失败、合并中断恢复、取消与
重规划迟到结果、临时文件不交付，以及多会话与内部并行同时发生。性能测量包含
检出/依赖准备、Executor 用时、合并/验证耗时、磁盘峰值与队列等待。

本次仅提交评估；运行代码、配置和正在执行的任务均未调整。
