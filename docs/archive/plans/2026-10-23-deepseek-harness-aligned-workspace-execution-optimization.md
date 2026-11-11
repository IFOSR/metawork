# 基于 DeepSeek Harness 的工作区执行与变更记录优化方案

- 日期：2026-10-23。
- 状态：提案，未实施。
- 依据：MetaWork 当前代码与 ADR，以及本地调研副本 `.tmp/dsh-research/deepseek-harness`。
- 目标：在保留 MetaWork 的 Kernel、Task、Attempt、Work Graph 和持久恢复边界的前提下，采用 DeepSeek Harness 已验证的工作区、多轮会话、文件变更观察和当前文件交付模型，减少整树搬运与发布耦合。

## 总体原则

DeepSeek Harness 的合理性不只在于“把执行目录改成用户目录”，而在于它把几个容易混在一起的问题拆开了：

1. Workspace 是长期存在的规范路径和会话账本，不是每轮临时物化的副本。Harness 的 `WorkspaceRegistry` 对路径做 `realpath` 规范化，并把 Workspace 身份与路径字符串分开。
2. 当前工作目录是 Session 的可持久状态。目录切换通过独立的 `working-directory/change` 事件记录，不修改历史 Session header，也不改变已有进程的工作目录。
3. `PresentedFile` 是对源路径当前内容的引用；`WorkspaceChangedFile` 是一轮范围内观察到的变化。两者分别由 `tool-present` 和 `workspace-changes` 负责，任意一者失败都不会被解释成另一者失败。
4. 文件观察是观测能力，不是完成认证。Harness 的变更记录器在顶层 turn 开始和结束时做 Git 快照，对文件工具修改的非 Git 路径做前后捕获；记录器失败只产生告警和缺失摘要。
5. 文件工具可以采用“先观察、再按版本写入”的可选守卫。版本 token 由文件系统提供方拥有，策略插件只决定是否要求 `createIfAbsent` 或 `replaceIfVersion`，不把 CAS 逻辑散落到工具和业务代码中。
6. 会话日志只追加、单写者、显式 flush；崩溃恢复追加结构化的 `interrupted` closer，不重写已经持久化的历史。

MetaWork 应采用上述原则，但不能把 Harness 的边界假设直接当成任务调度契约。Harness 的变更插件主要解决一个 Host 内一个 Session 的顶层 turn；它没有解决 MetaWork 的跨 Conversation Task 并发、Subtask 依赖可见性、Kernel 授权和公开服务的生命周期。因此，MetaWork 需要在这些边界上补充自己的事实与租约。

## 建议的目标模型

### Workspace 与 Session

`Workspace` 表示用户已经拥有的目录：`workspaceId` 是稳定身份，`canonicalPath` 是创建时 `realpath` 后的路径，路径丢失时身份仍保留。Conversation 通过 Workspace binding 访问它；Session/Conversation 的历史仍然归自己所有，Workspace 不授权读取其他 Conversation 的 transcript、evidence 或权限。

当前工作目录语义可以直接借鉴 Harness：目录以规范路径持久化，目录消失时尝试恢复原始目录，目录切换是会话事件。MetaWork 的执行根则由 Kernel 授权的 `ExecutionContext` 固定下来，不能从 Planner 文本或运行时环境变量临时推导。

每次 Attempt 的 manifest 应至少固定以下事实：

```text
workspaceId
canonicalWorkspacePath
executionMode: in_place | worktree
writeLeaseId
taskId / generationId / subtaskId / attemptId
authorizedWorkingDirectory
```

现有 managed workspace 的 checkpoint、restore、清理和容器权限调整继续服务于 `worktree`。用户目录不应伪装成 `WorkspaceHandle.filesPath`，也不能复用会递归 `rm`、`chown` 或 `chmod` 的生命周期。应增加用户 Workspace 的只读解析接口和就地执行接口，并让所有调用方显式选择模式。

### Turn、Attempt 与变更记录

不要规定“一轮 = 一次 Attempt”。一个用户 turn 可能只提问，也可能产生一个 Task 的多个 Subtask、重试和修正 Attempt。建议记录结构如下：

```text
WorkspaceChangeRecord {
  recordId: stable task/attempt/turn identity
  conversationId, workspaceId, userTurnId?
  taskId, generationId, subtaskId, attemptId
  beforeSnapshot?: private git tree identity
  afterSnapshot?: private git tree identity
  files: bounded changed-file summaries
  totalFiles, addedLines, deletedLines
  coverage: complete | partial | unavailable
  missingReasons?: git_unavailable | snapshot_failed | shell_unobserved | output_limited
}
```

记录器应采用 Harness 的串行链：每个 Conversation/Session 一个 recorder；新 turn 的开始、文件工具前捕获、工具结果、turn stopping 和 turn end 按顺序排队，避免基线晚于写入。记录事件可以写入现有 `task_events`，但事件 payload 必须带稳定 Attempt/Turn 关联，不能只带一个可重复的轮号。

Git 通道使用私有 index 和私有 object directory，仓库 index、objects、refs 保持只读。应如实记录 Harness 已知的限制：首次快照可能扫描并保存未跟踪未忽略文件；split-index 和 Git LFS 可能仍写入 Git 私有目录；shell 修改不能归因到具体工具；嵌套仓库只记录 gitlink。记录器摘要可以有大小和文件数上限，但 `coverage` 必须表示是否完整，不能把截断摘要当作完整事实。

文件工具通道应增加 MetaWork 自己的 `fs/*` seam：文件工具在 `write/edit` 前捕获首次修改前的文件，成功后发出观察事件；观测策略可按 Session 保存不透明版本 token。若当前 Pi/Codex 执行器只能通过 shell 写文件，就不能声称具备 Harness 的文件级 CAS；这类修改只能进入“观察到但不可归因”的记录。

### 交付与 artifact

交付拆成两个独立概念：

- `PresentedFile`：用户要打开的当前 Workspace 文件，记录 Workspace 身份、规范相对路径、描述和观察时的 hash。打开时重新验证路径授权和当前文件状态。
- `ArtifactVersion`：需要精确版本的输入、跨 Task handoff、下载、发布或审计材料，保存固定内容或由现有 Result Object 提供不可变内容。

普通多轮编辑默认使用 `PresentedFile` 的 live 引用；不能用后续文件变化把旧路径内容冒充为旧版本。需要“使用上一轮精确内容”时显式引用 `ArtifactVersion`，而不是让每轮都复制整个工程。

保留 Planner 声明的 `fileOutputs` 作为必需交付选择。变更记录中的所有文件、声明的交付文件和 scratch 文件分别呈现；声明产物缺失仍然阻止文件交付成功。`dist`、构建缓存和 `.scratch` 不能只按目录名判断：显式 `fileOutputs` 必须覆盖默认 scratch 规则，未声明的 scratch 可以展示为变化但不成为 artifact。

路径授权仍必须检查 artifact 所属 Workspace、相对路径 containment、最终组件的 symlink 和 regular-file 类型。将预览白名单放到 Workspace 根目录不等于完成授权，且不能删除流式读取、预览大小和内存上限。

### Task 完成、取消与恢复

就地执行采用明确的产品契约：文件修改可以在 Attempt 成功前对用户可见；失败或取消不会自动回滚已经写入的内容，取消只阻止后续动作。变更摘要不可用时可降级，但必需声明文件缺失、handoff 无法形成、receipt/完成事实无法持久化，仍不能将 Attempt 或 Subtask 标为成功。

Attempt 在写入前、写入后和完成认证之间要分别持久化事实。恢复遇到“文件已经写入但结果未知”时，应进入现有 Kernel 的 uncertainty/recovery 路径，要求重新观察当前文件、receipt 和服务状态；不能盲目重跑可能非幂等的 shell 命令。Harness 的 `interruptedTurnClosers` 可以作为 Session 日志恢复形式参考，但不能代替 MetaWork 的 Attempt 外部副作用判断。

### 并发与隔离

MetaWork 当前 [ADR-0037](../adr/0037-multi-conversation-task-parallelism.md) 允许不同 Conversation 的 Task 并行，同一 Task 也可能有并行 Attempt。就地模式必须因此增加 Workspace 级写租约：租约以 canonical path 的重叠关系判断冲突，覆盖跨 Conversation、同一 Task 和嵌套 Workspace。租约由 Kernel/Resource 层持有，跨进程实现，不能只依赖 `workspace-${task}-${attempt}` 这类逻辑 ID。

规则建议如下：

- 同一个 Workspace 默认只能有一个 in-place 写者。
- 无法取得租约的 Task 排队；需要并行或 DAG 隔离的 Task 使用 worktree。
- 同一次 Task 的所有 Attempt 固定同一种 executionMode；恢复不能因环境变量变化而切换。
- Work Graph 的直接依赖边仍是上下文可见性边界；共享 Workspace 不自动把无关 Subtask 的文件变化变成输入。
- worktree 模式继续使用现有 Git publication/conflict repair；in-place 模式不经过“复制到公开目录”的发布链。

这部分是 MetaWork 对 Harness 的必要扩展。Harness 的 Workspace registry 负责稳定身份、路径规范化和 Session 归属，并不替代 MetaWork 的跨任务写入调度。

### 本地服务

服务启动不应再依赖整个发布目录的 hash 一致性。服务仍需要一个 Workspace/项目范围的稳定 `serviceId`，以及 Kernel 授权的规格修订：命令、参数、工作目录、环境引用、host、port、health path 和 revision hash。允许用户修改无关源码后继续启动，不代表可以仅凭 `.metawork-service.json` 存在就启动任意新命令。

同一服务规格被后续 Task 更新时，更新必须是显式授权的 revision；旧 Task 的 stop/restart 只能操作它拥有的服务身份和当前允许的规格。服务进程事实与文件变更记录分离，服务健康失败不能被伪装成文件交付失败。

## 建议的实现顺序

### P0：先建立不改变用户文件的事实和模式边界

1. 新增 `ExecutionContext` 与 runtime manifest 的 `executionMode`、canonical Workspace path 和 lease identity；历史 Task 按旧 worktree 解释。
2. 增加 Workspace path canonicalization 和重叠写租约，先禁止两个 in-place writer 同时启动。
3. 实现只读版 `workspace-change-recorder`：私有 Git 快照、声明文件检查、`coverage` 和有界事件。P0 不改变发布语义。
4. 为 live file reference 和 fixed artifact reference 定义不同的类型/视图；不要复用 `published_path` 的含义而不记录引用类型。
5. 为 crash-after-write、cancelled-attempt 和 uncertain completion 增加事实映射，接入现有 Kernel recovery。

### P1：切换交付和连续编辑体验

1. in-place Attempt 通过用户 Workspace 接口运行，禁止 managed workspace 的 restore/cleanup/chown。
2. `PresentedFile` 改为 Workspace-relative live 引用；`fileOutputs` 仍是必需交付声明，声明缺失仍失败。
3. 变更卡片采用 Harness 的“本轮改动文件”语义；记录器失败显示 coverage 和原因，不显示虚假的“发布冲突”。
4. 服务改为 Workspace/service revision 授权和启动，移除与无关文件 hash 的耦合。
5. 将旧 `metaclaw-tasks` 副本保留为历史交付；新记录使用显式 `referenceKind`，不以 `NULL` 让读取器猜测模式。

### P2：能力增强

1. 在文件工具 seam 接入 Harness 风格的 `createIfAbsent` / `replaceIfVersion`。
2. 对声明的关键输出、handoff 和用户明确要求的历史版本保存 ArtifactVersion。
3. 提供按 Attempt 的精确 diff 和用户可选的 checkpoint/rollback；不把回滚作为默认就地执行前提。

## 必须补充的验收

- 两个 Conversation 同时绑定同一 Workspace：一个取得 in-place lease，另一个排队或进入 worktree；嵌套路径也正确冲突。
- 同一 Attempt 在文件写入后、receipt 持久化前崩溃，恢复不会重复执行非幂等命令，且结果进入 uncertainty。
- 用户在执行器读写之间修改文件；文件工具路径按版本守卫拒绝陈旧写入，shell 路径诚实标记为不可归因。
- 非 Git 工作区、ignored 文件、声明的 `dist`、scratch、删除和重命名都产生正确的 coverage 与交付结果。
- 同一文件连续三轮修改：只有一个源文件，没有 `metaclaw-tasks` 新副本；第一轮 fixed artifact 与当前 live file 的行为明确不同。
- Task 取消、Attempt 重试和服务规格更新后，文件、服务进程、receipt、handoff 和 Task 状态可分别恢复。
- 重启后历史事件仍可显示变更文件清单；不能假设临时 diff 内容仍然存在，除非它被保存为 ArtifactVersion。
- `0600` 权限、符号链接、嵌套仓库、超过摘要上限和超过预览/读取上限的文件不会导致用户目录被 Runtime 清理或权限重写。

## 预期文档与 ADR 影响

该方案需要修订 Workspace 绑定、Git publication、资源租约、服务启动和恢复相关 ADR，并同步 `CONTEXT.md` 与技术总览。现有 `ADR-0037` 不应标记为“不变”：它的并行 Task 事实仍成立，但需要新增共享 Workspace 的写租约和 in-place/worktree 选择规则。`ADR-0025` 的 Git publication 继续作为 worktree 模式的发布权威；它不再是 live Workspace 文件引用的唯一交付机制。

这一方案的核心不是复制 DeepSeek Harness 的包结构，而是采用它已经证明有效的职责分离：工作区身份、当前目录、文件变更观察、文件交付、固定 artifact、服务运行和 Task 完成各自拥有清楚的契约。这样可以删除 MetaWork 中不必要的整树搬运，同时保留 Kernel 对授权、并发、恢复和完成认证的控制权。
