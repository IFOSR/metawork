# 单一 In-place Workspace 执行模型技术实施方案

- 日期：2026-10-25
- 状态：已实施
- 依据：[Planner 主导的 Workspace 执行模式设计](2026-10-25-planner-owned-workspace-mode-design.md)、DeepSeek Harness/Pi 的现有实现和 MetaWork 当前 ResourceLease 机制。
- 目标：删除产品级 Worktree 执行模式，统一采用 In-place Workspace 执行，以租约、等待队列、文件变更队列和变更记录解决并发、恢复和可追溯问题。
- 完成日期：2026-10-25
- 交付验证：`npm run lint`、`npm run build`、`npm run build:web`、In-place Workspace 聚焦测试和 `tests/storage/migrations.test.ts` 通过。
- Closing commit：待提交。

## 1. 决策摘要

MetaWork 的新任务只保留一种 Workspace 执行方式：Executor 直接在目标 Workspace 中工作。

普通编辑、新建文件、继续编辑、运行项目命令和多轮会话都使用同一个目标 Workspace。多个任务需要写入同一 Workspace 或重叠路径时，由现有 `ResourceLeaseService` 和 `resource_waits` 排队；同一执行器会话内的同文件修改继续由文件变更队列串行化。

Workspace 复制、Git worktree、候选目录、发布回写和 Worktree acceptance 不再属于 MetaWork 的新任务生命周期。

只读查询也不创建 Worktree。只读任务可以读取 Conversation 绑定的 Workspace，临时输出进入受控 scratch 目录，不申请 Workspace 写租约，也不产生 Workspace publication。

如果用户明确要求分支、隔离候选或保留原 Workspace，系统不自动复制目录。系统应要求用户选择另一个 Workspace，或明确告知当前任务只能直接在目标 Workspace 执行。这种需求未来如确实必要，应作为独立产品能力重新设计，不在本次方案中保留隐含 Worktree 后端。

## 2. 采用这一方案的依据

DeepSeek Harness 的 base profile 默认使用 `workspace-write`，文件和 Bash 修改直接限制在当前 Session Workspace 与临时根目录。Git Worktree 通过独立的 experimental bundle 提供，默认关闭，只有用户或模型显式启用并调用 `create_worktree` 时才创建。

DeepSeek Harness 的文件系统 seam 对同一目标的读改写操作使用一个临界区，并以原子方式发布修改；Session 持久化层通过单写者、批处理队列和跨进程 lease 保证写入顺序。Pi 的 `edit` 和 `write` 工具同样直接使用当前 `cwd`，通过 `withFileMutationQueue` 串行化同文件的完整读改写窗口。

Codex 和 Claude Code 的 MetaWork 适配器也以授权的 `cwd` 和权限策略运行。它们的权限模式负责控制文件效果和审批，Worktree 不是每个任务的默认执行后端。

MetaWork 已经具备更强的跨进程 Workspace 互斥能力：`workspaceRootClaim`/`workspacePathClaim` 使用物理路径分区，`ResourceLeaseService` 负责心跳、过期、撤销和等待唤醒，publication 与 In-place Attempt 使用同一套租约。继续复制 Workspace 会绕开现有排队能力，并引入第二套执行和交付语义。

## 3. 目标架构

```text
用户输入
  -> Planner 判断目标 Workspace、读写意图和目标相对路径
  -> Kernel 校验 Conversation Workspace、路径 containment、声明输出和权限
  -> Kernel 为写入任务申请 Workspace ResourceLease
  -> Executor 在目标 Workspace 的 authorizedWorkingDirectory 中执行
  -> Attempt 记录 before/after snapshot、变更清单、receipt 和结果
  -> Kernel 根据结果完成 Task、进入恢复或要求用户决策
```

### 3.1 Workspace 的唯一写入语义

新 Task 不再持久化 `in_place`/`worktree` 二选一。Task 只记录：

- `workspaceId`；
- 规范化 Workspace 路径及其 binding fingerprint；
- Planner 声明的 Workspace-relative `targetPaths`；
- Workspace intent 的操作类别和原文件策略；
- 结果与变更记录。

这里的“执行方式”只指 Workspace 访问方式。现有 Kernel 请求中的 `fresh`、`follow-up`、`resume-blocked` 等生命周期 execution mode 继续保留，它们不属于 Workspace 模式，不能在清理时误删。

Generation binding 的 `authorizedWorkingDirectory` 始终是目标 Workspace 根目录，或者目标 Workspace 内经授权解析的子目录。Executor 不得自行切换到另一个目录。

### 3.2 只读任务不是第二种 Workspace 模式

`workspaceIntent.operation = read_only` 只表达“本次没有用户 Workspace 写入”。它不创建 Worktree，也不生成 Worktree binding。

只读任务的运行事实如下：

- 允许读取 Conversation 绑定的 Workspace；
- 使用账户受控的临时 scratch 目录承接工具临时文件；
- 不持有长期 Workspace `write` 或 `read` lease；
- 不创建 Workspace publication；
- 任何试图写入目标 Workspace 的调用由执行权限层拒绝；
- 如果用户随后要求修改文件，重新规划为普通 In-place 写入任务。

如果需要对多个文件建立一致的读取视图，Runtime 可以先快速捕获受限 snapshot，再释放读取资源；不能用一个长时间的 read lease 把普通写入任务整体阻塞。

如果一个报告任务声明了 `fileOutputs`，它已经是写入任务，应按普通 In-place 任务处理，不能通过 `read_only` 绕过 Workspace 写入授权。

### 3.3 并发语义

同一 Workspace 或父子重叠目录之间的写入使用物理路径 claim：

1. Attempt 在产生任何外部副作用前申请 Workspace write lease。
2. 若 claim 冲突，写入 `resource_waits`，Attempt 不启动 Executor。
3. Kernel 将 Subtask 标记为等待资源，并保留原始授权 binding。
4. 释放、撤销释放或过期回收后调用 `resolveSatisfiedWaits()`。
5. 等待项重新进入可调度队列，重新校验 binding fingerprint 后执行。
6. publication 不再是第二个写入阶段，因此不会与 In-place 产生双写。

不同 Workspace 或不重叠路径可以继续并行。文件级队列负责同一进程内多个工具对同一文件的读改写；ResourceLease 负责跨 Attempt、跨 Server 进程的目录级互斥。

## 4. 需要删除或收缩的契约

### 4.1 Planner 契约

从 `WorkspaceIntent` 和 Planner schema 中删除：

- `proposedMode`；
- `isolationPolicy` 中用于选择 Worktree 的语义；
- `worktree` 相关模式理由和可用性判断。

保留：

- `targetWorkspaceId`（仅作语义提示，真实 Workspace 仍由 Conversation binding 提供）；
- `targetPaths`；
- `operation`；
- `originalFilePolicy`；
- `confidence`；
- `reason`。

Planner 规则调整为：

- `modify_existing`、`continue_existing_edit`、`create_in_target`、`run_in_target` 都表示普通 In-place 目标；
- `read_only` 表示不进入 Workspace 写入生命周期；
- `ambiguous` 必须进入追问；
- 覆盖、删除、目标 Workspace 或写入范围不明确时追问；
- 不再让 Planner 选择 Worktree；
- 不再通过自然语言理由中的关键词推断隔离模式。

### 4.2 Kernel 契约

删除 `WorkspaceExecutionDecision` 中的：

- `executionMode`；
- `source`；
- `deliveryPolicy`；
- `worktreeAvailable`；
- `fallbackMode`。

将当前 `resolveWorkspaceExecutionDecision()` 改为 Workspace admission resolver，只负责：

- 是否需要 Workspace 写入；
- Conversation 是否有受信 Workspace binding；
- 目标路径是否合法且处于授权范围；
- `fileOutputs` 是否被 `targetPaths` 覆盖；
- 是否需要追问；
- 生成用于 Runtime 的 Workspace binding 和 access policy。

解析结果可以是：

```ts
type WorkspaceAdmission =
  | { kind: 'read'; workspaceId: string | null; targetPaths: string[] }
  | { kind: 'write'; workspaceId: string; targetPaths: string[] }
  | { kind: 'clarification'; question: string; reason: string }
  | { kind: 'rejected'; reason: string };
```

`kind` 是 Kernel 内部访问事实，不是用户可选择的第三种产品执行模式，也不创建新的 Task execution mode。

### 4.3 配置契约

删除高级设置中的 `workspaceExecution.fallbackMode` 及其 schema、projection、保存和激活逻辑。新任务不再从设置读取 In-place/Worktree 默认值，因为系统只有一个 Workspace 写入方式。

保留现有 Sandbox、Executor capability、ResourceLease、Workspace containment 和运行时权限设置。它们负责“能否访问”和“能否写入”，不负责选择执行目录。

## 5. 源码实施阶段

### 阶段一：先改共享词汇和 Planner 输出

修改：

- `src/core/workspace-execution.ts`；
- `src/planning/planning-agent-plan-schema.ts`；
- `src/planning/planning-agent-plan-validator.ts`；
- `src/planning/planning-types.ts`；
- `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/planner-system-prompt.ts`；
- Planner 相关 proposal fixture 和 schema 测试。

交付内容：

1. 删除 `proposedMode`、Worktree delivery vocabulary 和 Worktree fallback vocabulary。
2. 保留结构化读写意图和目标路径。
3. 明确普通编辑默认是目标 Workspace In-place。
4. `read_only` 不再要求 Worktree。
5. Planner 不再被要求为普通研究任务生成 Worktree 理由。
6. 不明确的写入意图继续追问。

### 阶段二：重写 Kernel admission

修改：

- `src/kernel/workspace-execution-decision.ts`（重命名为 Workspace admission resolver，或删除后合并入 Kernel admission 模块）；
- `src/kernel/control-kernel.ts`；
- `src/kernel/control-kernel` 相关 snapshot、decision 和 event 类型；
- `src/session/session-kernel-runtime.ts`。

关键行为：

1. `workspaceWrites = false` 时返回 `kind: read`，不产生 Workspace write decision。
2. `workspaceWrites = true` 时要求 Workspace binding 和至少一个安全的目标路径。
3. 普通写入不再检查 Worktree availability 或 fallback mode。
4. Planner 语义不明确时请求 clarification，不创建 Task、Attempt 或 lease。
5. Task admission 只持久化 Workspace identity、target paths 和 intent facts。
6. publication 不再作为 Workspace 写入授权阶段。

天气、网页研究和普通分析的回归路径必须验证为：Executor 可以读取所需上下文，但不会创建 Worktree、候选状态或 publication。

### 阶段三：统一 Runtime binding 和 Attempt runner

修改：

- `src/execution/execution-context.ts`；
- `src/execution/kernel-execution-runtime.ts`；
- `src/execution/subtask-attempt-runner.ts`；
- `src/storage/workspace-execution-binding-repo.ts`；
- `src/storage/task-repo.ts`、`src/task/task-engine.ts` 及其类型。

交付内容：

1. 新 binding 始终指向 Conversation 受信 Workspace。
2. 写入 Attempt 在启动 Executor 前申请 `workspaceRootClaim` 或目标路径 claim。
3. 只读 Attempt 使用 Workspace read boundary 和 scratch root，但不持有长期 Workspace lease；需要一致视图时先捕获 snapshot。
4. 删除 `task.executionMode ?? 'worktree'` 这类旧默认值。
5. 删除 merge repair 强制 Worktree 的特殊分支；需要冲突修复时使用临时 Git index、patch 或 snapshot 目录，不将其变成用户 Workspace 的第二执行模式。
6. `authorizedWorkingDirectory` 只能是目标 Workspace 或其受控 scratch 根，且由 Runtime 生成并验证。
7. 多轮继续编辑复用同一个 Workspace binding，不重新选择执行后端。

### 阶段四：删除 Worktree backend 和 publication 分支

删除或完全移出新任务主路径（先确认没有其他后端契约依赖；保留仍用于容器/沙箱执行的通用 backend）：

- `src/execution/worktree-attempt-execution-backend.ts`；
- `src/execution/worktree-execution-cleanup.ts`；
- Worktree 专用 workspace store 目录生命周期；
- Worktree publication candidate、acceptance 和 delivery policy；
- `src/execution/workspace-publication-worker.ts` 中针对 Worktree 的目标 Workspace 回写逻辑；
- `publicTaskDirectory` 作为 Worktree 结果目录的所有运行时语义；
- Web/TUI 中 Worktree mode、候选发布和“复制结果”按钮。

保留并复用：

- `src/execution/workspace-change-git.ts`；
- `src/execution/workspace-change-tracker.ts`；
- Attempt receipt、Result Object 和 file output certification；
- before/after tree、变更清单、ignored path coverage；
- 用户文件 containment 和预览大小限制。

变更记录是 In-place 的诊断和恢复事实，不再承担 Worktree 到用户 Workspace 的发布职责。

### 阶段五：配置、Web 和持久化收敛

修改：

- `src/configuration/types.ts`；
- `src/configuration/schema.ts`；
- `src/configuration/projections.ts`；
- `src/configuration/workspace-execution-policy.ts`；
- `web/src/components/SettingsPanel.tsx`；
- `web/src/settings-model.ts`；
- `web/src/components/TaskResultActions.tsx`；
- 相关配置、Gateway 和 projection 测试。

删除高级设置中的 In-place/Worktree 选择项。任务结果界面改为展示：

- 修改的 Workspace；
- 修改文件和变更摘要；
- 任务是否等待资源；
- 是否存在不确定外部副作用；
- 用户需要采取的恢复动作。

不再显示“已发布到任务目录”“Worktree 候选”“等待接受 Worktree”等产品文案。

### 阶段六：数据库和历史代码清理

新架构不兼容旧的 Worktree 任务。按照用户确定的边界，不为旧 Worktree 任务增加运行时兼容分支。

迁移策略：

1. 新 schema 删除 Worktree-only binding、candidate 和 publication 字段；
2. 新 Task 表只保留 Workspace identity、target paths、intent 和变更记录所需字段；
3. 旧任务记录可以标记为历史不可恢复，禁止重新 dispatch；
4. 启动恢复遇到旧 Worktree 绑定时输出明确迁移错误，不能静默切换路径；
5. 不改变现有 schema 迁移编号的主干归属，新增迁移按当前分支合并后的版本顺序分配；
6. Docker SQLite/POSIX 测试中验证新数据库从当前基线升级后只生成单一 In-place binding。

如果删除字段会扩大本轮数据库风险，可以先保留 nullable 历史列，但新代码不得读取或写入这些列；随后单独做物理清理迁移。保留列不等于保留兼容执行能力。

## 6. 失败、取消和恢复

In-place 的核心限制是文件可能已经被修改。现有 uncertainty 语义继续保留：

- Executor 中途退出且存在未持久化写入时，Attempt 进入 uncertain；
- Kernel 释放 lease，但不自动重放未知副作用；
- 用户显式选择继续、检查后完成或放弃；
- 变更记录和 before/after snapshot 用于诊断和恢复判断；
- 取消不等于回滚，除非用户明确执行可验证的反向变更。

Sandbox 丢失、进程崩溃、结果持久化失败和 delivery 失败都不创建 Worktree 重试。重试只在 Kernel 确认没有未知外部副作用，或用户明确授权后继续。

## 7. 测试和验收矩阵

### Planner/Kernel

- 普通修改已有文件解析为 `write`，直接 In-place；
- 普通新建文件解析为 `write`，直接 In-place；
- 继续编辑同一 Workspace 解析为 `write`；
- 天气查询、网页研究、普通报告解析为 `read`，不创建 Worktree；
- `read_only` 携带 `fileOutputs` 时被拒绝或重新分类为写入任务；
- 覆盖/删除/目标 Workspace 不明确时只追问；
- 不再接受 `proposedMode=worktree` 或 Worktree 理由关键词；
- 无 Workspace binding 的写入任务被拒绝或追问。

### ResourceLease 和 Runtime

- 同一 Workspace 的两个 Server 进程同时申请写入时只有一个启动 Executor；
- 后到任务进入 `resource_waits`，前一任务释放后自动唤醒；
- 父目录与子目录 claim 互相冲突；
- 不同 Workspace 可以并行；
- 只读任务不产生 Workspace write lease；
- lease 心跳、过期、撤销释放都会唤醒等待者；
- Attempt 启动前任何 Workspace 写入都被阻止；
- Runner 不会把工作目录切换到复制目录。

### 变更记录和恢复

- In-place 修改前后可以捕获 Git tree 和变更清单；
- `.gitignore` 文件覆盖仍显示为 partial coverage；
- before/after snapshot 不改变用户 Git index、refs 或 objects；
- Executor 崩溃后的未持久化写入进入 uncertainty；
- 重试不会盲目重复非幂等命令；
- 不会生成任务目录或全量复制结果。

### Web/Desktop

- 高级设置不再出现 Worktree 选择项；
- 天气和网页研究结果不显示 Worktree/发布候选；
- 普通代码编辑后用户在原 Workspace 中看到实际修改；
- 并发等待状态清晰显示为“等待 Workspace 资源”，不显示“隔离执行”；
- 变更记录能定位目标 Workspace 和文件路径；
- 不暴露内部 scratch 路径。

### 必须执行的验证

```text
npx tsc --noEmit
npx vitest run tests/kernel tests/planning tests/execution tests/resource tests/delivery tests/web
docker build -f Dockerfile.test -t metawork-test .
docker run --rm metawork-test
npm run build
npm run smoke:metawork
npm run smoke:metawork -- --scenario artifact
```

SQLite、POSIX 路径、跨进程 lease 和真实 Executor 中途退出测试必须在 Docker 或支持的平台环境中执行。

## 8. 完成标准

本方案只有在以下事实同时成立时才算完成：

1. 新任务不存在 `executionMode = worktree`；
2. Planner 不再输出 Worktree 模式或 Worktree 理由；
3. 只读任务不创建 Worktree、publication 或 Workspace write lease；
4. 普通写入直接修改目标 Workspace；
5. 同一 Workspace 的并发写入通过 ResourceLease 排队；
6. In-place Attempt 和任何结果写入不会发生双写；
7. 变更记录、uncertainty、恢复和 containment 仍然有效；
8. Web、Desktop、TUI、Gateway 使用同一套 Workspace 语义；
9. 旧 Worktree 任务不会被静默重放或切换到错误目录；
10. 文档、ADR、CONTEXT、technical overview 和测试都反映单一 In-place 架构。

## 9. 需要同步更新的文档

实施开始前或阶段一完成时同步更新：

- `docs/adr/0050-planner-owned-workspace-execution-mode.md`：改为单一 In-place Workspace 决策；
- `docs/plans/2026-10-25-planner-owned-workspace-mode-design.md`：标记为被本方案取代，并删除 Worktree 作为默认产品路径的描述；
- `CONTEXT.md`：记录单一 Workspace 写入模型、ResourceLease 排队和只读任务语义；
- `docs/current/technical-overview.md` 与中文技术总览：删除新任务 Worktree publication 和模式选择说明；
- `docs/current/phase-5-runtime-security.md`：把 Worktree executor 描述改为历史实现或删除；
- `docs/README.md`：增加本方案并标注实施状态。

文档中不得继续使用“无写入任务进入 Worktree”“安全默认 Worktree”“Worktree 自动发布”等表述。

