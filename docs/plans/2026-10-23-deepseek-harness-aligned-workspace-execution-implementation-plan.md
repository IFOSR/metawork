# DeepSeek Harness 对齐的工作区执行技术实施方案

- 日期：2026-10-23（2026-10-24 修订：补记实现状态与未完成边界）。
- 状态：**实施中**。代码事实基线为 schema 56；默认开关仍为 `worktree`。
  第 12 节逐项记录已交付行为与仍然成立的边界，未完成项明确标注，不得当作已完成。
- 契约依据：[DeepSeek Harness 对齐的工作区执行与变更记录优化方案](2026-10-23-deepseek-harness-aligned-workspace-execution-optimization.md)。
- 实施范围：Workspace 规范化、就地/隔离执行选择、统一 ResourceLease 写分区、变更观察、live 文件引用、固定 Artifact、服务规格授权和就地执行恢复。
- 不在本方案范围：重新设计 Planner 语义、增加第二个 Kernel、改造 DeepSeek Harness 本身、默认启用每轮 Git commit、为所有 Workspace 建立全量版本仓库。

## 1. 实施约束与最终不变量

实现必须继续遵守 `Planner proposes -> Kernel decides -> Runtime applies`。Planner 可以提出 `executionMode`、文件输出和服务意图，但不能决定是否取得 Workspace 写租约、是否恢复不确定 Attempt、是否跳过交付认证。Kernel 产生唯一有效的执行授权，Runtime 只执行授权并报告事实。

落地后必须满足以下不变量：

1. Workspace 身份与路径分离。路径以 `realpath` 规范化后保存；符号链接别名、`..` 和尾部斜杠不能创建第二个物理 Workspace。
2. 每个 Attempt 在启动前固定 `workspaceId`、规范路径、`executionMode`、工作目录和写租约身份。恢复不能依赖当前环境变量重新解释这些事实。
3. `in_place` Attempt 不创建、恢复、清理或递归修改 managed workspace；`worktree` Attempt 保持现有 WorkspaceStore 与 Git publication 生命周期。
4. 同一物理目录或有祖先/后代重叠的 Workspace，最多一个活跃 `in_place` 写者。跨 Conversation、同一 Task 的并行 Attempt 和跨进程 Server 都遵守此规则。
5. 变更记录是观察事实，不是完成认证。记录缺失或降级只能降低变更卡片的完整度，不能把必需 `fileOutputs`、handoff 或 receipt 的失败变成成功。
6. `PresentedFile` 只表示 Workspace 内当前文件引用；需要稳定字节时使用 `ArtifactVersion` 或既有 Result Object。任何旧 hash 不能授权读取后来内容。
7. 就地写入失败或取消后，已经写入的内容可以保留；Runtime 不自动清理用户目录。未知外部副作用进入 Kernel recovery/uncertainty，不能盲目重放。
8. 所有用户文件访问都经过 Workspace 所属关系、相对路径 containment、symlink 和 regular-file 检查；任何预览、下载和原生打开操作都不能只凭绝对路径。

## 2. 数据模型与迁移

### 2.1 ExecutionContext

在 `src/execution/` 新增 `execution-context.ts`，定义执行链路共享的不可变事实：

```ts
type ExecutionMode = 'worktree' | 'in_place';

interface ExecutionContext {
  workspaceId: string;
  canonicalWorkspacePath: string;
  executionMode: ExecutionMode;
  authorizedWorkingDirectory: string;
  resourceLeaseId: string | null;
  taskId: string;
  generationId: string;
  subtaskId: string;
  attemptId: string;
  configurationRevision: string;
  bindingFingerprint: string;
}
```

`ExecutionContext` 由 Kernel dispatch item 生成并写入 Attempt manifest。`resourceLeaseId` 指向现有 ResourceLease claim，不代表独立的 Workspace lease。`SubtaskExecutionContext.workspaceContext` 增加 `workspaceId`、`executionMode` 和 `canonicalRoot`；执行器只接收已经解析的 `workingDirectory`，不能自行从 `taskId` 拼目录。

### 2.2 数据库变更

当前工作树的源 schema 为 51；`main` 上的六态任务提交已经占用 schema 52。本方案合入 `main` 后使用下一个可用版本（当前预定为 schema 53）；迁移编号以合并后的 `CURRENT_SCHEMA_VERSION` 为准，不能在两个分支各自使用 52。迁移失败必须保持旧 schema 可启动，不能部分写入。建议新增：

```sql
CREATE TABLE workspace_execution_bindings (
  task_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('worktree', 'in_place')),
  authorized_working_directory TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, generation_id)
);

CREATE TABLE workspace_change_records (
  record_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  generation_id TEXT,
  subtask_id TEXT,
  attempt_id TEXT,
  conversation_id TEXT,
  workspace_id TEXT NOT NULL,
  user_turn_id TEXT,
  before_tree TEXT,
  after_tree TEXT,
  files_json TEXT NOT NULL,
  total_files INTEGER NOT NULL,
  added_lines INTEGER NOT NULL,
  deleted_lines INTEGER NOT NULL,
  coverage TEXT NOT NULL CHECK (coverage IN ('complete', 'partial', 'unavailable')),
  missing_reasons_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_workspace_change_records_task
  ON workspace_change_records(task_id, created_at);

CREATE TABLE artifact_versions (
  artifact_version_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  source_task_id TEXT,
  source_attempt_id TEXT,
  relative_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  object_uri TEXT NOT NULL,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, relative_path, content_hash)
);
```

同一事务还执行以下增量字段迁移；字段名和历史 `published_path` 语义不能复用：

```sql
ALTER TABLE tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'worktree'
  CHECK (execution_mode IN ('worktree', 'in_place'));
ALTER TABLE task_artifacts ADD COLUMN reference_kind TEXT NOT NULL DEFAULT 'legacy_published_copy'
  CHECK (reference_kind IN ('live_file', 'artifact_version', 'legacy_published_copy'));
ALTER TABLE task_artifacts ADD COLUMN workspace_id TEXT;
ALTER TABLE task_artifacts ADD COLUMN artifact_version_id TEXT;
ALTER TABLE task_artifacts ADD COLUMN source_relative_path TEXT;
CREATE INDEX idx_workspace_change_records_attempt
  ON workspace_change_records(attempt_id, created_at);
```

实际 SQLite migration 必须根据现有列和触发器采用仓库惯用的重建表方式；上面只表达最终字段和约束，不要求直接逐条执行 `ALTER TABLE`。

`tasks.workspace_id` 已存在并继续作为 Workspace 身份。本方案只新增 `execution_mode`；`workspace_path` 不重复写入 `tasks`，规范路径由 Workspace Catalog 和 `workspace_execution_bindings.canonical_path` 负责，Attempt manifest 保存启动时路径快照。`NULL` 只表示历史记录未迁移，不再用 NULL 推断新任务的模式。`task_artifacts` 增加 `reference_kind`（`live_file | artifact_version | legacy_published_copy`）、`workspace_id` 和 `artifact_version_id`。旧 `published_path` 保持历史副本语义，新 live 引用写入独立的 `source_relative_path`，不覆盖旧列含义。

迁移策略如下：

- 旧 Task 全部写入 `execution_mode='worktree'`，保持现有恢复和 publication 行为。
- 旧 `task_artifacts` 写入 `legacy_published_copy`，历史目录继续只读可访问。
- 新 Task 的 Workspace binding 在 Task 创建事务中写入；模式由 Kernel admission 选择后不可变。
- schema 53 读取器同时理解旧行和新行；不允许旧代码把 live 引用当作 `published_path` 使用。若合并后的基线版本不是 53，按最终版本号重排迁移文件。
- `METAWORK_WORKSPACE_MODE` 只作为新 Task 的默认提议，不能覆盖已持久化的 Task/Generation 模式。

### 2.3 Repository 与事件接口

新增：

- `src/storage/workspace-execution-binding-repo.ts`
- `src/storage/workspace-change-record-repo.ts`
- `src/storage/artifact-version-repo.ts`

`TaskEventRepo` 保留作为通用审计事件入口；`workspace_changes_recorded` 事件的 payload 只放有界摘要、recordId、coverage 和原因，完整固定内容放 ArtifactVersion，不能把大 diff 写进 `task_events`。

不新增 `workspace_write_leases` 表或第二套 lease service。Workspace 写入冲突复用现有 `ResourceLeaseService`、`resource_leases` 和 `resource_waits`；新增的只是 Workspace mount/root partition 的生成规则，以及 publication 与 Attempt 对同一物理路径的 claim 约定。

## 3. Workspace 与写租约

### 3.1 规范路径

在 `src/workspace/` 增加 `workspace-path.ts`：

```ts
canonicalizeWorkspacePath(path): Promise<{ canonicalPath: string; device?: string }>;
isPathOverlap(left, right): boolean;
assertWorkspaceRelativePath(root, relativePath): Promise<ResolvedWorkspaceFile>;
```

`canonicalizeWorkspacePath` 必须对现有目录使用 `realpath`；Workspace 创建时目录不存在直接拒绝。文件解析采用 `realpath` 父目录和 `lstat` 最终组件组合，既能判断 symlink，又能避免把链接目标误当作 Workspace 内普通路径。Workspace mount 必须复用 `src/resource/partition.ts` 的 NFC、分段和大小写规则：macOS 等大小写不敏感文件系统在 mount 注册时折叠大小写，Linux 等大小写敏感文件系统保留大小写。Workspace path service、Resource partition、publication 和预览授权必须使用同一 canonical form。

Workspace Catalog 只负责用户目录、标题、Conversation binding 和规范路径，不负责 managed worktree。`WorkspaceRepositoryPort` 新增 `findByWorkspaceId`，现有按 Task/Generation/Subtask 的 managed identity 继续保留给 worktree。

### 3.2 写租约算法

不新增 `workspace-write-lease-service.ts`。Kernel 和 Runtime 通过现有 `ResourceLeaseService.claim()` 取得 Workspace 写 claim，使用同一套 `resourceClaimsConflict`、heartbeat、expiry、revocation 和 `resource_waits`。需要补充的是 Workspace mount/root partition：它必须能表示一个 canonical Workspace 根，并与同 mount 下的文件/子目录 claim 发生祖先/后代冲突；若现有 `path` partition 不能表达 root claim，应扩展 partition 类型或 mount 注册语义，而不是用特殊字符串绕过规范化。

Attempt 的 in-place claims 至少包括：

```text
workspace-root: write
attempt-owned inputs/handoffs: write
required external resources: existing claims
```

publication 的 claims 必须指向最终写入的用户 Workspace，而非仅指向 integration worktree。对已知的 `fileOutputs`/changed paths 锁定具体目标；无法提前枚举时锁定 Workspace root。in-place Attempt 与 worktree publication 因此进入同一 ResourceLease 冲突和等待链。

claim 在 dispatch 前取得，并在 Executor 启动前再次验证。冲突返回的 `resource_waits` 必须由调度/发布恢复路径消费：Attempt 进入等待而不是简单失败，publication 继续使用现有 `markPending`，释放后重新尝试。heartbeat、跨进程 SQLite 事务、撤销和 uncertain fencing 全部复用现有 ResourceLease 事实。

## 4. 执行链路改造

### 4.1 dispatch 与恢复

修改：

- `src/kernel/control-kernel.ts`：在 dispatch decision 中携带 execution binding 和 lease decision。
- `src/execution/kernel-execution-runtime.ts`：从持久 binding 解析路径，删除按 Attempt identity 猜测用户目录的逻辑。
- `src/execution/subtask-attempt-runner.ts`：引入 `ExecutionContext`，按模式分流。
- `src/execution/subtask-execution-context.ts`：向 Executor 提供明确的 workspace mode/root/lease facts。
- `src/execution/execution-runtime.ts` 与各 backend adapter：原样传递授权 working directory，不改变 Planner 语义。

`worktree` 分支保持现有流程：`ManagedGitWorkspaceService.ensure`、私有 inputs/handoffs、checkpoint、candidate commit、publication worker 和冲突修复均不变。

`in_place` 分支流程为：

```text
Kernel dispatch decision
  -> load immutable WorkspaceExecutionBinding
  -> acquire/renew Workspace ResourceLease claim
  -> verify canonical path and authorized subdirectory
  -> create attempt runtime facts (without WorkspaceStore checkpoint)
  -> materialize only attempt-owned inputs/ and handoffs/ outside the user Workspace
  -> run Executor in authorized working directory
  -> stop and flush change recorder
  -> validate declared fileOutputs and handoffs
  -> persist receipt + change record + completion facts transactionally
  -> release ResourceLease through Kernel decision
```

当前实现把 `inputs/` 和 `handoffs/` 建在 `workspace.rootPath` 下。in-place 分支必须先新增 Attempt-owned materialization root，例如 `<attemptsRoot>/<attemptId>/workspace-inputs` 和 `<attemptsRoot>/<attemptId>/workspace-handoffs`；这些目录目前不存在，不能在方案中称为“现有路径”。native Executor 直接使用 host path，container Executor 继续分别挂载为 `/inputs` 与 `/handoffs`。用户工程根目录不自动创建这两个目录，除非它们本来就是用户明确声明的输出，这样内部资料不会污染 WorkspaceChangeRecord。

### 4.2 Attempt 状态与未知结果

在 Attempt Runtime facts 增加：`writeStartedAt`、`writeFinishedAt`、`receiptPersistedAt`、`externalEffectStatus` 和 `changeRecordId`。执行器返回或进程退出后，Runtime 先观察文件和服务，再提交终态。

以下情况进入 `uncertain`：

- 进程在任何文件写入之后、receipt 持久化之前退出；
- lease 心跳丢失但 owner 进程状态未知；
- 文件变更记录器在写入后失败，且无法判断必需输出是否存在；
- 服务启动请求已发送但进程归属尚未持久化。

Recovery Worker 只执行观察、进程归属确认、lease fencing 和补写事实。它不自动重放整个 Executor。用户显式 Resume 后，Kernel 根据当前文件 hash、声明输出、服务状态和 sourceAttempt 决定是否可继续；不可判断时保留 `uncertain` 并要求用户决策。

## 5. DeepSeek Harness 风格变更记录器

### 5.1 模块

P1 新增：

- `src/execution/workspace-change-recorder.ts`：Attempt/turn 级串行协调器。
- `src/execution/workspace-change-git.ts`：私有 index/object snapshot、tree diff 和 ignore 查询。
- `src/execution/workspace-change-types.ts`：`WorkspaceChangeRecord`、coverage、文件摘要和缺失原因。

Recorder 由 Conversation/Planner Session 拥有一个实例，但每个 Attempt 显式打开和关闭一个 record scope。P1 的 scope 只保证 Git snapshot、声明产物检查和有界事件；Attempt stopping、turn end 和 receipt 认证前按同一串行队列 flush。Pi 子进程的文件工具捕获另列为 P2，未接入前必须把非 Git/shell 路径标记为 coverage `partial` 或 `shell_unobserved`。

### 5.2 Git snapshot

`workspace-change-git.ts` 复用 Harness 的命令边界：

- `GIT_INDEX_FILE` 指向 recorder 临时目录；
- `GIT_OBJECT_DIRECTORY` 指向 recorder 私有 objects；
- `GIT_ALTERNATE_OBJECT_DIRECTORIES` 只读引用仓库 objects；
- `git add --all --ignore-errors`、`write-tree`、`diff-tree -r -M --numstat` 均有超时和输出上限；
- 用户 index、refs 和工作树不作为写目标；
- `.git`、recorder 临时目录、嵌套仓库的内部内容按 Harness 规则处理。

Git snapshot 的失败分类：未找到 Git 为 `partial`（可继续声明通道）；命令失败或基线无法建立为 `unavailable`；输出/文件数超限为 `partial`。不能把 snapshot 失败伪装成空变更。

### 5.3 文件工具 seam（P2）

当前 Pi/Codex 的 write/edit 在子进程内执行，不会自动经过 MetaWork 文件系统层。P2 通过现有 `METACLAW_PI_ATTEMPT_EXTENSION` 扩展入口接入捕获，或在未来统一文件工具落地后接入同等 seam。在该接缝真正接通前，不得把 Git before/after snapshot 宣称为文件级 CAS。

文件工具目标采用与 Harness 对齐的 capability seam：

```ts
event('fs/observed', target, observation, actor)
waterfall('fs/write-intent', target, actor) -> createIfAbsent | replaceIfVersion
waterfall('fs/edit-intent', target, actor) -> expected version
```

观察状态以 Session 为 owner、以不透明 target key 为 map key。Local backend 的 version token 至少由 dev/ino、size、mtimeNs 组成；消费方不能解析 token。写入和 edit 必须在同一 per-target lock 下完成“检查版本—修改—原子替换”。

Pi/Codex 通过 shell 修改的文件不经过该 seam，必须在记录中标记 `shell_unobserved` 或 `unattributed`。文件工具扩展只负责它实际拦截到的目标，不声称覆盖所有子进程文件系统操作。

### 5.4 持久事件与查询

记录完成后插入 `workspace_change_records`，再写一条 `task_events(event_type='workspace_changes_recorded')`。插入使用稳定 `recordId` 幂等，不依赖 `UNIQUE` 中的 NULL 值；`attempt_id` 和 `user_turn_id` 使用普通索引查询。Server 重启后可显示文件路径、数量和 coverage。`before_tree`、`after_tree` 和临时捕获只用于当前 Host/Session 生命周期内的诊断与 diff，会话结束后可能失效，不能作为回滚依据；只有明确生成 ArtifactVersion 时才持久保留内容。

## 6. 文件交付与 Artifact

### 6.1 live PresentedFile

新增 `src/delivery/workspace-file-reference.ts`，定义：

```ts
interface WorkspaceFileReference {
  referenceKind: 'live_file';
  workspaceId: string;
  relativePath: string;
  observedHash: string;
  byteLength: number;
  previewKind: PreviewKind;
  sourceAttemptId: string;
}
```

`user-artifact-publication-service.ts` 不再复制 in-place 文件，也不把 live 路径写入旧 `published_path`。它只验证并登记 reference；`artifact-preview-service.ts` 通过 `workspaceId + relativePath` 重新解析当前文件，检查所属 Account/Conversation/Task 授权和 Workspace containment。hash 不匹配时显示“当前文件已变化”，不能以旧 artifact hash 授权当前内容。该改造必须保留现有流式读取、预览大小上限、内存上限、preview kind、regular-file 和 symlink 检查。

### 6.2 fixed ArtifactVersion

关键 handoff、跨 Task 精确输入、用户请求下载历史版本时，使用 `ArtifactVersionRepo` 将内容放入现有 result object/CAS 根目录，记录 hash、size、media type 和来源 Attempt。固定版本创建必须在 Attempt 完成认证前完成，否则声明文件不能作为完成 handoff。

`ContextRef` eligibility 增加 `referenceKind` 分支：`live_file` 只能表示当前 Workspace 文件，`artifact` 必须通过不可变 hash/Result Object 校验。旧 `task_artifacts` 行继续走 legacy path，不允许隐式转换。

### 6.3 fileOutputs 认证

保留 `completion-protocol.ts` 的 `fileOutputs` 约定：声明的文件或目录必须在 Workspace 内存在、是 regular file、未通过 symlink 逃逸，并可按规则哈希。显式声明优先于 scratch 目录启发式规则；未声明的 `.scratch`、日志和临时文件可以进入变更摘要，但不能成为 Artifact。摘要完整性和交付成功分别计算。

## 7. 服务生命周期改造

修改 `src/execution/managed-local-service.ts`、`src/server/server-composition.ts` 和服务 Repository：

1. 服务身份改为 `(accountId, workspaceId, serviceId)`，不以每 Task 的公开目录作为根身份。
2. `.metawork-service.json` 解析后生成规格 fingerprint；Kernel 授权绑定保存 command、args、directory、environmentReferences、host、port、healthPath 和 revision。
3. 启动时只要求 Workspace 和规格 revision 仍然存在，并检查当前规格等于授权 revision；无关源码变化不触发整体发布冲突。
4. 新规格必须通过显式 update decision；旧 Task 只能控制自己授权的 service revision 和拥有的进程实例。
5. 服务健康、端口冲突、进程归属和文件交付分别持久化；服务失败不改写 `workspace_changes_recorded` 或 Artifact 状态。

启动规格文件存在本身不是授权。`resolvePublishedDirectory` 应拆成 `resolveAuthorizedWorkspaceDirectory` 与 `validateAuthorizedServiceRevision` 两个 seam，并保留绝对路径、symlink、端口和进程 owner 检查。

## 8. 兼容、开关与回滚

发布开关只控制新 Task admission：

```text
METAWORK_WORKSPACE_EXECUTION_DEFAULT=worktree|in_place
METAWORK_WORKSPACE_IN_PLACE_ENABLED=true|false
```

旧 Task 的 mode 由 `workspace_execution_bindings` 读取，关闭开关不会中断或重新解释运行中的 in-place Task。若发现问题，关闭新 admission 后，等待现有 in-place Attempt 进入 terminal/uncertain，再允许新 Task 全部使用 worktree；不能用环境变量把 live 文件复制回旧目录作为自动回滚。

历史 worktree publication、`metaclaw-tasks` 和旧 preview 路由继续可读。新 live reference 路由单独注册并要求 `referenceKind`，确保旧客户端不会把源路径当成可下载副本。

## 9. 分期与提交边界

### P0：事实、模式和统一资源租约（预计 3–5 天）

- 合并 main 后的 schema 53 与 repository；
- `ExecutionContext`、Workspace canonicalization、Workspace Resource partition；
- Kernel dispatch/recovery 绑定；
- publication 与 in-place 对最终用户 Workspace 使用同一 ResourceLease claim；
- worktree 回归保持绿灯；
- in-place 只做受控实验开关，暂不替换 publication。

### P1：变更记录和 live 引用（预计 4–7 天）

- Harness 风格 Git snapshot recorder、声明通道与 task event；
- `PresentedFile` live reference、预览授权和 coverage UI；
- in-place 执行器分流、无 managed Workspace 清理；
- Attempt-owned inputs/handoffs，不落用户 Workspace；
- fileOutputs 认证与 scratch 分类；
- 崩溃、取消、未知 receipt 的 recovery 验收。

### P2：服务和固定版本（预计 3–5 天）

- Workspace/service revision；
- ArtifactVersion、跨 Task fixed input/handoff；
- Pi attempt extension 文件捕获、文件工具 version guard；
- 用户可选的精确 diff 和 checkpoint/rollback。

每一阶段使用独立 Conventional Commit。P0 不得在同一提交中删除 worktree publication；P1 只有在 worktree 对照回归、共享 ResourceLease 和 in-place focused tests 通过后才默认开放；P2 不阻塞基础就地编辑能力。

## 10. 测试和验收矩阵

新增测试目录：

- `tests/workspace/workspace-path.test.ts`
- `tests/resource/workspace-resource-claim.test.ts`
- `tests/execution/workspace-change-recorder.test.ts`
- `tests/execution/in-place-attempt-recovery.test.ts`
- `tests/delivery/workspace-file-reference.test.ts`
- `tests/execution/service-revision.test.ts`
- `tests/execution/workspace-publication-in-place-conflict.test.ts`

必须覆盖：

| 场景 | 预期 |
| --- | --- |
| 同一路径与祖先/后代路径并发 | 只有一个 in-place lease；另一个排队或 worktree |
| 两个 Server 进程共用同一 SQLite 抢同一 Workspace | 只有一个 ResourceLease claim 成功，另一个产生 durable wait/conflict |
| in-place Attempt 与 worktree publication 同时写同一 Workspace | 两者使用同一目标 Workspace partition，不发生双写 |
| in-place 输入与 handoff 路径 | `inputs`/`handoffs` 只在 Attempt-owned root 出现，不落用户 Workspace |
| symlink、`..`、嵌套 Git 仓库 | canonical identity 和 containment 一致，内部仓库只按规则观察 |
| Git、非 Git、ignored、声明 dist、scratch | 变更摘要分别给出 coverage；显式声明优先；scratch 不进 Artifact |
| 文件工具 stale version | 返回稳定 stale error，不覆盖用户修改 |
| shell 在执行期间改文件 | 记录为 shell_unobserved/unattributed，不假装 CAS |
| 写文件后 receipt 前崩溃 | Attempt uncertain，恢复只观察和 fencing，不自动重跑 |
| 取消后重试 | 已写内容保留，重试使用 sourceAttempt 和当前事实，不能重复非幂等副作用 |
| live 文件被后续轮修改 | live 引用显示当前状态；fixed ArtifactVersion 保持旧 hash |
| 服务规格被后续 Task 更新 | 旧 serviceId/owner 不能启动未经授权的新规格 |
| 0600 文件、60MiB 以上文件、预览超限 | 不改变权限；摘要/预览有界降级，不清理用户文件 |
| Server 重启 | 事件保留 recordId、文件清单和 coverage；临时 diff 只在有 ArtifactVersion 时恢复 |
| 旧 Task 与旧客户端 | 继续使用 worktree、legacy published copy 和原有 preview |

验证顺序为 `npm run lint`、Workspace/ResourceLease/recorder focused tests、Docker SQLite migration tests、worktree smoke、in-place smoke，最后才运行完整 `npm test`。schema 53 迁移、SQLite、跨进程 lease 和 POSIX path 验证必须在 Docker 中运行，遵守仓库要求。

## 11. 文档与 ADR 更新

实施每个阶段完成后同步：

- `docs/adr/0037-multi-conversation-task-parallelism.md`：补充 Workspace 重叠写租约和 in-place/worktree admission。
- `docs/adr/0024-resource-partition-sandbox-and-runtime-elevation.md`：区分 managed worktree、用户 Workspace 和 native trusted backend。
- `docs/adr/0025-single-task-concurrency-and-git-publication.md`：明确 Git publication 只拥有 worktree 模式，live reference 不经过复制发布。
- `docs/adr/0023-durable-kernel-workflow-recovery-and-availability.md`：加入 write-after-crash uncertainty 和 lease fencing。
- `docs/adr/0035-workspace-scoped-conversation-organization.md`：加入 canonical Workspace path 与 Session binding 关系。
- `CONTEXT.md`、`docs/current/technical-overview.md` 和 `docs/README.md`：更新最终 schema 版本、执行模式、live/fixed reference 和服务 revision 词汇。

关闭本实施方案前，必须在本文补充完成日期、实际交付行为、focused/Docker/ smoke 验证结果和关闭提交；在此之前不得将它标记为已完成或把环境开关默认改为 `in_place`。

## 12. 实施状态（2026-10-24 修订）

本节只描述**代码现状**，不构成 Phase 完成声明。默认开关仍为 `worktree`；
`in_place` 需要 `METAWORK_WORKSPACE_EXECUTION_DEFAULT=in_place` 与
`METAWORK_WORKSPACE_IN_PLACE_ENABLED=true` 同时成立才会被新 Task admission 采用。

### 12.1 数据模型与迁移

- 当前源 schema 为 **56**。
- 版本号归属：52 属于 `main`（六态 Task 投影，会重建 `tasks` 并写六态 CHECK），
  53–56 属于本分支。分支的 51 升级路径是 51 → 52（分支桥）→ 53 → 54 → 55 → 56，
  桥接会在 `schema_branch_bridges` 记录 `51_to_52_branch_bridge`。
- 外部观察到的 52 必须携带 main 的六态基线（`task_state_changes`、
  `tasks.state_version`、`tasks.completed_at`），否则升级**fail closed** 并给出
  可执行错误信息；不存在的基线不会被静默桥接。
- 本分支的运行时仍使用旧状态词汇，因此**不移植** main 的六态重分类（本分支会写
  `status='created'`，被 main 的 CHECK 拒绝）。该步骤在合并 `main` 时由 main 的
  迁移承担，本分支只做增量对象。
- 55 增加 `retry_wakes.wake_kind`、`executor_attempt_runtime` 的写后事实列、
  `kernel_dispatch_items.execution_binding_fingerprint`、服务 `workspace_id` /
  `specification_revision`；56 把 `managed_local_services` 主键重建为
  `(account_id, workspace_id, service_id)`。

### 12.2 已交付

| 项 | 落点 | 现状 |
| --- | --- | --- |
| 规范路径与 containment | `src/workspace/workspace-path.ts` | realpath、段级祖先/后代、拒绝 symlink 与逃逸 |
| Workspace 写分区 | `src/resource/workspace-claim.ts` | 按**文件系统卷**建 mount，claim 是卷相对路径；ancestor/descendant 必然冲突，与 Workspace ID 无关 |
| Attempt 写租约 | `subtask-attempt-runner.ts` | claim 前先 canonicalize；冲突返回 `partition_conflict` |
| publication 交付租约 | `workspace-publication-worker.ts` | in-place claim Workspace root，worktree claim 发布目录；交付根只解析一次并下传；lease 冲突 `markPending`；交付期间 15s heartbeat；无 lease 不写（fail closed） |
| 等待自动恢复 | `resource-lease-repo.ts`、`kernel-execution-runtime.ts`、`control-kernel.ts` | 释放（含 `releaseRevokedAttempt`）即解析 wait；`resourceConflictSubtaskIds` 来自 durable waits；`wait_for_partition` 武装 `wake_kind='partition'` 的 durable wake，由 Kernel 重新 dispatch |
| 不可变执行绑定 | `execution-context.ts`、dispatch item | Generation admission 写入 binding；dispatch item 带 `execution_binding_fingerprint`；runner 用 `executionContextFromBinding`，binding 缺失或指纹不符即拒绝执行；worktree 的 `authorizedWorkingDirectory` 是 generation 工作目录根，执行目录必须落在其中 |
| Attempt 隔离的运行时目录 | `workspace-store.ts` | in-place 的 inputs/handoffs/results 位于 `.../in-place/attempt-<id>/`，重试不共享 |
| 变更记录 | `workspace-change-git.ts`、`workspace-change-recorder.ts` | 私有 `GIT_INDEX_FILE`/`GIT_OBJECT_DIRECTORY` + 只读 alternates、`write-tree`、`diff-tree -M --numstat`、超时/输出/文件数上限；声明产物覆盖 scratch；删除与重命名保留；`beforeTree/afterTree` 为真实 Git tree id；`.gitignore` 命中记 `gitignore_unobserved`，不复称 complete |
| live 引用与固定版本 | `user-artifact-publication-service.ts`、`artifact-content-resolver.ts` | 删除项与未声明变更不登记；重复登记幂等；固定版本写 CAS 用临时文件 + rename 并在 EEXIST 时校验/修复；声明 handoff 丢失则失败而不是静默跳过 |
| 预览/下载授权 | `artifact-preview-service.ts` | live 引用按 `workspaceId` 解析唯一根（多根歧义拒绝，不回退绝对路径）；固定版本校验 account/workspace 归属；读取前 `lstat` 限制大小；下载返回与读取一致的路径 |
| 崩溃恢复 | `subtask-attempt-runner.ts`、`account-startup-recovery-service.ts`、`control-kernel.ts` | 写后无 receipt 判 `uncertain`（heartbeat 丢失、执行成功但后续步骤失败都覆盖）；`sandbox_lost` 无 checkpoint 不再自动重建 Attempt |
| 服务授权 | `local-service.ts`、`managed-local-service.ts`、`control-kernel.ts` | 身份 (account, workspace, service)；Kernel 事件/决策携带 `workspaceId` 与 `specificationRevision`；revision 不一致需显式 `update` 操作 |
| Pi 文件工具捕获 | `pi-agent.ts`、`local-cli-executor-adapter.ts`、`container-compatibility-adapter.ts` | native 与 container 都返回 `diagnostics.workspaceCaptures`，容器内 `/workspace/...` 会翻回宿主路径 |
| 开关 | `execution-context.ts` | `METAWORK_WORKSPACE_EXECUTION_DEFAULT` 只提议模式，`METAWORK_WORKSPACE_IN_PLACE_ENABLED` 是独立放行门 |

### 12.3 仍是诚实边界

- 51 → 52 的分支桥**不执行** main 的六态重分类；合并 `main` 时必须用 main 的迁移替换
  该步骤，否则 51 数据库会缺少六态事实。
- 没有“真实 Executor 被中途杀掉”的端到端崩溃注入测试，当前覆盖方式是事实层不变量
  （runtime facts + dispatch `uncertain` + 无 receipt）。
- 非 Git 工作区的 shell 写入仍不可归因（`shell_unobserved`），与 DSH 声明的限制一致。
- `task_artifacts.published_path` 对 live 引用仍保存绝对路径（历史列语义未重建），
  但所有新消费方都按 `workspaceId + sourceRelativePath` 重新解析，不再把它当授权依据。
- 固定版本的 CAS 目录与 `task_artifacts` 行的一致性依赖提交顺序；中断后的孤儿对象
  不会被自动回收。
