# Workspace 内部版本库与会话 Worktree 并行模型

- 日期：2026-10-29
- 状态：提议，待评审；本文件不表示已经实施
- 适用范围：Workspace 写入、跨会话并行、办公文件、网站生成、服务预览和后续交付
- 相关公开实现：[dsh-git-worktree](https://github.com/wloops/dsh-git-worktree)、[dsh-worktrees](https://github.com/Luck9Star/dsh-worktrees)
- 相关当前契约：[ADR-0050](../adr/0050-planner-owned-workspace-execution-mode.md)、[ADR-0037](../adr/0037-multi-conversation-task-parallelism.md)

## 1. 决策摘要

MetaWork 为每个用户 Workspace 建立一个内部版本库。用户 Workspace 是否已经是 Git 仓库，不影响 MetaWork 的执行模型；MetaWork 的内部版本库由系统自己维护，不要求用户学习 Git，也不应把 MetaWork 的提交混入用户已有的 Git 历史。

所有可能写入 Workspace 的 Session 默认使用独立的 Task Worktree：

```text
Workspace 主干
  -> Session A Worktree
  -> Session B Worktree
  -> Session C Worktree
```

多个 Session 在各自 Worktree 中并行执行。Session 完成后进入 Workspace 级串行 Merge Queue：

```text
Worktree 完成
  -> 基于当前主干合并
  -> 无冲突：主干前进，记录新的 Revision
  -> 有冲突：保留冲突现场，等待用户处理
  -> 合并完成且没有服务依赖：清理 Worktree
```

该方案将 Worktree 从“某一种 Executor 后端”提升为 Workspace Session 的统一工作目标。普通问答和纯只读任务可以只创建延迟物化的只读 Worktree 绑定，不产生物理写目录，也不进入合并队列；一旦任务需要读取或生成 Workspace 文件，再物化对应的隔离目录。

## 2. 解决的问题

当前 In-place 模型把用户 Workspace 根目录作为写租约边界。同一 Workspace 下的两个任务即使修改完全不同的文件，也会因为祖先路径冲突进入 `resource_waits`。当前规则实际形成了：

```text
逻辑 Workspace = 物理写锁边界 = 单一写者
```

本方案改为：

```text
逻辑 Workspace = 一个集成主干
每个写入 Session = 一个独立 Worktree
主干更新 = 一个串行合并点
```

这样可以让不同 Session 同时进行文件创建、依赖安装、构建、办公文档生成和服务预览，同时保留明确的冲突边界。

## 3. 与旧 MetaWork Worktree 的区别

本方案不是恢复旧的 Worktree 执行模式，也不是重新启用旧的 Candidate Publication 流程。

| 内容 | 旧 MetaWork Worktree | 本方案 |
| --- | --- | --- |
| 管理范围 | Subtask/Generation 的内部 managed workspace | Workspace 级内部版本库和 Session Worktree |
| 产品定位 | Executor 的一种执行后端 | 所有 Workspace 写入 Session 的统一隔离方式 |
| 主干 | 内部 Generation 或 integration workspace | 用户 Workspace 对应的内部集成主干 |
| 默认关系 | 曾与 In-place 并存，之后被 ADR-0050 收缩为 In-place 主路径 | 写入任务统一从主干创建 Worktree |
| 结果交付 | Candidate Commit、Publication Worker、候选目录 | Worktree 分支进入 Workspace Merge Queue |
| 发布方式 | 可能复制或发布到 `publicTaskDirectory` | 只合并授权变更，不复制整个执行目录 |
| 非 Git Workspace | 先导入内部 Git，再继续旧生命周期 | Workspace 创建时直接建立内部版本化层 |
| 服务归属 | 容易沿用 Task、Generation 或旧发布目录 | 服务绑定 ApplicationRevision 和明确运行目录 |
| 清理条件 | 容易跟随 Task 终态清理 | 合并完成且没有服务、冲突或恢复依赖后清理 |
| 用户可见对象 | 容易出现候选工作区和发布中间态 | 用户看到 Workspace、Session、Revision 和合并状态 |

旧的 `ManagedGitWorkspaceService` 可以作为 Git Worktree 后端的实现参考，但不能直接作为本方案的产品生命周期。尤其不能把旧的 `publicTaskDirectory`、自动复制整棵目录和旧 publication 恢复逻辑重新作为新任务主路径。

## 4. Workspace 内部版本库

### 4.1 用户已有 Git Workspace

如果用户 Workspace 已经是 Git 仓库，MetaWork 默认不直接使用用户的当前分支、用户的提交历史或用户的远端配置。系统先读取当前 Workspace 的精确文件状态，建立自己的内部基线。

这样可以避免：

- MetaWork 修改用户当前分支；
- MetaWork 的内部提交污染用户提交历史；
- 用户的未提交修改被错误地当成某个旧 Task 的基线；
- 合并队列操作用户远端或执行 push。

### 4.2 非 Git Workspace

如果用户 Workspace 不是 Git 目录，MetaWork 在内部运行目录建立私有仓库或等价的内容寻址快照。用户目录不需要出现 `.git`，也不需要用户执行 `git init`。

内部仓库只需要记录：

```text
Workspace 当前文件树
文件内容和路径
基线 Revision
每次 Session 的变更 Revision
```

隔离目录的实现可以按平台能力选择：

1. 优先使用 Copy-on-Write 或 reflink；
2. 不支持时使用受控目录复制；
3. 大文件使用内容寻址对象或受控文件快照；
4. 只复制 Planner 授权的 Workspace 范围；
5. 目录超出大小或文件数量上限时，进入明确的用户确认或受控等待。

这仍然对用户表现为 Worktree：每个 Session 有自己的工作目录、基线、变更和合并结果；底层不要求用户项目本身是 Git 项目。

### 4.3 主干的定义

“主干”是 MetaWork 的逻辑集成分支。它可以由真实 Git worktree 表示，也可以由内部仓库加用户 Workspace 根目录表示。用户不需要看到或操作分支名称。

主干必须满足：

- 同一 Workspace 只有一个当前集成 Revision；
- 所有合并都针对当前主干执行；
- 合并不自动 push、fetch 或修改用户远端；
- 合并失败时不覆盖主干；
- 主干的每个 Revision 都可以被服务和后续 Session 精确引用。

## 5. Session Worktree 生命周期

```text
创建写入 Session
  -> 读取 Workspace 当前主干 Revision
  -> 创建 Session Worktree
  -> 固定 task/session/baseRevision/worktreePath
  -> Executor 在 Worktree 中执行
  -> 捕获变更并生成 candidateRevision
  -> 进入 Workspace Merge Queue
  -> 基于最新主干尝试合并
```

Session 的多轮继续编辑复用同一个 Worktree，直到该 Session 的工作被合并、放弃或转为需要长期保留的服务 Revision。新的独立 Session 从当时的最新主干创建新的 Worktree，不通过“最近一个 succeeded Task”猜测执行目录。

每个 Worktree 至少固定以下事实：

```text
workspaceId
sessionId
taskId
baseRevision
worktreePath
candidateRevision
targetPaths
status
```

恢复时只使用这些持久化事实，不重新从当前 Workspace、环境变量或最近任务推导目录。

## 6. Merge Queue

Workspace 级 Merge Queue 是唯一写入主干的入口。

### 6.1 合并规则

1. 合并任务按持久化顺序串行执行；
2. 每个任务开始合并时重新读取当前主干 Revision；
3. 合并成功后生成新的 Workspace Revision；
4. 不自动 rebase 到用户未授权的分支；
5. 不 force push；
6. 不自动选择冲突一方；
7. 冲突现场、冲突文件和基线 Revision 必须保留；
8. 用户解决冲突后才能继续、重试或取消合并。

### 6.2 冲突处理

文本文件可以使用三方合并。合并失败时保留：

```text
当前主干版本
Session 版本
共同基线
冲突文件清单
```

Word、PPT、Excel、图片和其他二进制文件默认不做字节级自动合并。两个 Session 同时修改同一二进制文件时，向用户展示两个版本，由用户选择保留、另存或取消。

### 6.3 持久化和恢复

Merge Queue 不能只存在于进程内。它必须持久化：

- queue item；
- source Worktree；
- base Revision；
- current target Revision；
- merge status；
- conflict files；
- user resolution action；
- retry/cancel history。

Server 重启后可以继续等待、重试或恢复冲突现场。不同 Server 进程不能同时合并同一 Workspace 主干。

## 7. 办公和综合场景

统一的是 Workspace 写入模型，任务内容仍然可以不同。

| 任务 | 执行方式 |
| --- | --- |
| 代码、网站、重构 | 独立 Worktree |
| 安装依赖、构建、运行测试 | 独立 Worktree |
| 调研并生成报告 | 独立 Worktree 或新文件交付 |
| 生成 PPT、Word、Excel | 独立 Worktree |
| 修改一份明确的文档 | 仍然使用独立 Worktree，保持统一模型 |
| 多份文档批量整理 | 独立 Worktree |
| 纯阅读、普通问答 | 延迟物化的只读 Worktree 绑定 |
| 只读分析 Workspace | 只读快照或受控 scratch，必要时物化 Worktree |

对用户而言，报告、PPT、代码和网站都属于同一个 Workspace，只是每个 Session 在独立目录里完成，然后统一合并到 Workspace 主干。

新文件通常可以无冲突合并。已有二进制办公文件的并发修改必须保留两个版本，不能因为 Git 存储成功就假设内容可以安全自动合并。

## 8. 服务和 Revision

服务不能只绑定 Task，也不能在 Workspace 根目录扫描最近的服务规格。

建议关系如下：

```text
Workspace
  └── Application
        └── ApplicationRevision
              ├── source Revision
              ├── working directory
              ├── service specification
              └── ServiceInstance
```

网站生成 Session 完成后：

```text
Session A Worktree
  -> candidateRevision
  -> merge 到 Workspace 主干
  -> 形成 ApplicationRevision
  -> service-operation 指向 ApplicationRevision
```

启动服务时，系统读取明确的：

```text
applicationRevisionId
workingDirectory
command
arguments
environment references
port
health check
```

服务启动操作可以是一个新的 operation Task，但它引用的是 ApplicationRevision，不是把 `service_start` 重新绑定到已经 `succeeded` 的旧 Task。

`.metawork-service.json` 可以作为受管服务的规格文件，但不是所有 Workspace 程序都必须拥有的文件。用户明确要求启动一个应用时，Planner 可以直接生成受控的 service specification；系统把它登记为 ServiceInstance 的版本化事实。

### 8.1 Worktree 清理条件

Session 完成不等于 Worktree 立即可删除。只有同时满足以下条件才能清理：

- Worktree 已经成功合并或被用户明确放弃；
- 没有未处理的合并冲突；
- 没有未决恢复事实；
- 没有 ServiceInstance 仍然使用该 Worktree；
- 没有后续 Session 或 Artifact 引用它。

如果服务仍然运行在 Session Worktree 中，系统必须保留它，或者先把服务切换到已合并的主干 Revision，再清理旧 Worktree。

## 9. 最小运行规则

本方案不再需要同时维护 `in_place`、`worktree`、`file claim`、`publication candidate` 多套 Workspace 写入路径。对新任务只保留以下规则：

```text
1. Workspace 创建时建立内部版本库
2. 所有可能写入 Workspace 的 Session 使用独立 Worktree
3. 不同 Worktree 可以并行执行
4. 主干合并必须串行
5. 冲突不自动覆盖，交给用户决策
6. 服务绑定 ApplicationRevision，不绑定旧 Task
7. 有服务依赖的 Worktree 不能提前清理
8. 纯只读任务可以保持延迟物化，不进入 Workspace 合并生命周期
```

文件 Claim 不再作为主要 Workspace 并发机制。它最多可以作为未来对单文件低成本操作的优化，但不能成为网站、PPT、批量办公和依赖安装任务的基础路径。

## 10. 迁移边界

### P0：建立 Workspace 内部版本库

- 定义 Workspace 内部 repository/integration branch；
- 支持已有 Git 和非 Git Workspace；
- 捕获创建时的精确基线；
- 明确内部目录、临时目录和用户文件的清理边界；
- 不改变现有任务执行路径。

### P1：引入 Session Worktree

- 新的写入 Session 从当前 Workspace Revision 创建 Worktree；
- 执行、重试和继续编辑固定 Worktree identity；
- 同一 Workspace 的不同 Session 可以并行；
- 旧 In-place 新任务停止接收；
- 不删除历史 Task 的旧 binding。

### P2：引入持久化 Merge Queue

- 将候选变更合并到 Workspace 主干；
- 冲突现场可恢复；
- 不自动覆盖用户文件；
- 提供继续、重试、取消和人工解决入口；
- 合并成功后生成 Workspace Revision。

### P3：服务绑定 Revision

- ServiceInstance 绑定 ApplicationRevision；
- 启动、停止、重启使用 service identity；
- 启动服务不再扫描 Workspace 选择旧 Task；
- 有运行服务的 Worktree 延迟清理；
- 补齐生成网站、启动网站、继续修改和重启新 Revision 的验收。

### P4：关闭旧路径

- 停用新任务的根 Workspace In-place 写租约；
- 停用旧的整树复制和 `publicTaskDirectory` 主路径；
- 历史 publication、旧 binding 和旧 artifact 继续只读可恢复；
- 更新 ADR-0050、ADR-0037、ADR-0025、`CONTEXT.md` 和技术总览。

## 11. 验收标准

- 非 Git Workspace 可以创建内部基线和多个 Session Worktree；
- 已有 Git Workspace 不修改用户分支和远端；
- 两个 Session 可以在同一 Workspace 并行创建和修改文件；
- 两个 Session 修改不同文件时都能顺利合并；
- 两个 Session 修改同一文本文件时不发生静默覆盖；
- 两个 Session 修改同一 PPT、Word 或 Excel 时保留两个版本并要求用户决策；
- 合并队列在 Server 重启后仍可恢复；
- 用户直接修改主干后，后续合并能检测基线变化；
- 网站服务启动操作引用 ApplicationRevision，不引用已完成旧 Task；
- 运行中的服务不会因 Session 结束而丢失工作目录；
- 服务切换到新 Revision 后，旧 Worktree 才能清理；
- 纯问答不会创建无意义的 Workspace 写入和合并记录；
- 取消、崩溃、冲突和未决服务状态不会被当成普通成功完成。

## 12. 结论

本方案采用 `dsh-git-worktree` 的核心思想，但把它提升为 MetaWork 的 Workspace 级基础设施：

```text
内部版本库
  + Session Worktree
  + 并行执行
  + 串行 Merge Queue
  + 用户处理冲突
  + Revision 绑定服务
```

它不要求用户 Workspace 是 Git 项目，也不把 MetaWork 退回到旧的 Subtask Candidate Publication 模型。对用户来说，代码、网站、调研、方案文档、PPT 和日常文件仍然属于同一个 Workspace；对系统来说，每个可写 Session 都有自己的执行现场，最终通过唯一主干合并。
