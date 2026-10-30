# Workspace 内部 Git 与会话 Worktree：详细技术方案

- 日期：2026-10-29
- 状态：核心实现已落地，最终验收中（代码尚未提交）
- 产品依据：[确定性设计](2026-10-29-workspace-internal-git-session-worktree-design.md)
- 源码基线：本次实现使用 `src/storage/migrations.ts` 的 `CURRENT_SCHEMA_VERSION = 62`
- 权责依据：[ADR-0020](../adr/0020-core-module-ownership-and-dependency-direction.md)，战略权限部分以 [ADR-0053](../adr/0053-planner-graph-coordinator-and-executor-authority.md) 的修订为准
- 完成记录：核心运行实现、schema 62、真实 Git/FIFO/冲突测试、服务身份与恢复路径已交付；`npm run lint`、Web 构建及 focused tests 已通过；原生/Docker 全场景验收与 closing commit 待完成
- 2026-10-30 实现记录：完成 Workspace 私有 Git、持久 source index、会话 Worktree、FIFO 合并恢复、后台初始化/清理回执、初始化错误反馈和前端防重复操作；修正恢复流程全量扫描及增量索引固定排除规则。

## 1. 固定决策和实施边界

本方案只有一个文件执行模型：私有 Git 仓库 → Conversation Git Worktree → Workspace FIFO 合并 → 用户目录写回。Git 是实际实现，不使用“等价快照”、文件认领和 In-place 作为替代路径。

| 项目 | 确定规则 |
| --- | --- |
| Workspace | 一个账户内稳定的 workspaceId，绑定一个真实用户目录和一个私有 bare 仓库 |
| 主干 | 私有仓库 `refs/heads/main`，由 integration Worktree 检出 |
| 会话 | conversationId 对应一个活动分支和一个真实 Worktree，包括普通问答 |
| 并行 | 跨 Conversation 并行；同 Conversation 的 Executor Attempt 串行 |
| 合并粒度 | Task 的固定结果提交；不是每次工具调用，也不是每个 Subtask 发布 |
| 合并时机 | Task 工作完成后自动入队；明确“先不写回”的请求保存未交付提交 |
| 交付范围 | Task 实际业务变更；fileOutputs 只选择可见附件，不等于全部代码变更 |
| 冲突 | 暂停本 Workspace 交付；用户解决；其他会话执行继续 |
| 服务 | serviceId + sourceCommit + projectPath，从独立 detached Worktree 启动 |
| 清理 | 会话显式结束后检查残留；服务目录独立管理 |
| 用户已有 Git | 不改变其 refs/index/config；最终文件变化作为用户普通未提交修改 |
| Kernel | 持久协调兼容层，不决定工具权限、执行模式和冲突内容 |

统一规则的代价明确接受：普通问答也付出检出目录成本；依赖目录每个会话独立安装；同会话原有多写者并行收缩；二进制办公文件冲突需要用户决策。首版不引入优化后端掩盖这些取舍。

## 2. 当前实现与改造位置

以下是源码事实，不依据旧文档推断当前行为。

| 现有入口 | 当前行为 | 本次改造 |
| --- | --- | --- |
| `src/workspace/workspace-directory-service.ts` | 规范目录、创建 Workspace/Conversation、归档；内部只有进程内 mutation 串行 | 通过应用编排接入 Git 初始化、会话目录准备、清理请求 |
| `src/storage/file-workspace-catalog-store.ts` | Workspace Catalog 是 JSON 文件，不是 SQLite workspace 表 | 保持 Catalog 身份归属；Git 运行事实写账户 DB，不伪造跨存储事务 |
| `src/planning/planner-process-supervisor.ts` | `resolveAuthorizedWorkspace(conversationId)` 决定 Planner cwd 和根边界 | 返回会话 Worktree；展示用用户目录与执行根分离 |
| `src/execution/execution-context.ts` | `worktree` 被拒绝；工作目录必须在用户根内 | 新执行上下文显式携带用户根、会话根和版本身份 |
| `src/storage/workspace-execution-binding-repo.ts` | Task/Generation binding，schema 约束 `execution_mode = 'in_place'` | 历史只读；新增会话绑定表供新链路使用，不把新目录塞进旧 mode |
| `src/execution/subtask-attempt-runner.ts` | 写 Attempt 申请 `workspaceRootClaim(用户根)`；只读分支创建 scratch | 所有普通 Attempt cwd 统一到会话 Worktree，锁会话根，不锁用户根 |
| `src/execution/attempt-terminal-service.ts` | directCompletion 同事务写 done 和 outgoing handoffs | 保留原子 handoff；将文件引用改成固定会话提交，Task 完成另受交付事实约束 |
| `src/execution/managed-git-workspace.ts` | Task/Generation 仓库，Subtask 分支；普通目录导入内部 Git | 只提取可复用 Git 底层操作，替换生命周期 owner |
| `src/execution/workspace-publication-worker.ts` | 历史候选 publication 和交付逻辑 | 新 Task 走 WorkspaceMergeWorker；旧 publication 不重新 dispatch |
| `src/task/task-state.ts`、`task-state-facts.ts`、`task-state-authority.ts` | 六态、统一 facts、唯一状态写入口 | 增加 merge/delivery required-work，保持六态和终态不可逆 |
| `src/gateway/task-view-facts.ts`、`src/task/task-view.ts` | 统一状态展示 | 增加 Workspace 交付事实和精确冲突动作 |
| `src/execution/managed-local-service.ts`、`src/task/local-service.ts` | 服务身份已带 Workspace；规格来源 manifest/discovered | 增加 sourceCommit、projectPath、serviceWorktreeId；替换根目录解析 |
| `src/storage/task-artifact-repo.ts`、`artifact-version-repo.ts` | live_file、artifact_version、历史 published copy | 新固定附件引用 Git 提交；live 路径仅在写回成功后暴露 |

新增代码沿 ADR-0020 的依赖方向：Workspace 领域定义身份和查询 port；Execution 拥有目录、Git 和写回操作；Storage 实现持久化 port；Task 拥有结果状态；Account composition 装配；Gateway/Web/TUI 只调用应用 API 和读模型。Planner 不写 DB，UI 不运行 Git。

## 3. 服务划分与接口

不引入通用隔离后端接口。以下服务固定使用 Git：

| 新模块 | 职责 |
| --- | --- |
| `src/execution/workspace-git-service.ts` | 私有仓库初始化、Git 命令适配、提交读取、内部 refs、仓库注册操作 |
| `src/execution/conversation-worktree-service.ts` | 会话创建、同步 main、执行占用、提交封存、清理 |
| `src/execution/workspace-merge-worker.ts` | FIFO、external commit、三方合并、冲突工作项、驱动写回 |
| `src/delivery/workspace-writeback-service.ts` | 变更清单、前置内容检查、逐文件写回、恢复 |
| `src/execution/service-worktree-service.ts` | 服务固定提交目录、准备状态和清理引用 |
| `src/execution/workspace-git-recovery.ts` | Git/SQLite/用户文件三者恢复对账，不重跑业务 Executor |
| `src/workspace/workspace-git-contracts.ts` | 共享值类型、查询和持久化 port |

关键公开接口的类型草案如下，方法名为实施目标：

```ts
interface ConversationExecutionRoot {
  accountId: string;
  workspaceId: string;
  conversationId: string;
  worktreeId: string;
  incarnation: number;
  userRoot: string;
  executionRoot: string;
  branch: string;
  baseCommit: string;
}

interface ConversationWorktreePort {
  ensure(conversationId: string): Promise<ConversationExecutionRoot>;
  prepareTurn(conversationId: string, turnId: string): Promise<ConversationExecutionRoot>;
  sealAttempt(attemptId: string): Promise<{ commit: string; changedPaths: string[] }>;
  sealTask(taskId: string): Promise<{ changeId: string; commit: string; hasChanges: boolean }>;
  requestCleanup(conversationId: string): Promise<void>;
}

interface WorkspaceMergePort {
  enqueue(changeId: string, requestId: string): Promise<{ jobId: string }>;
  resolveConflict(input: ConflictResolution): Promise<void>;
  cancel(jobId: string, expectedVersion: number, requestId: string): Promise<void>;
  recover(workspaceId: string): Promise<void>;
}

interface GitArtifactReference {
  workspaceId: string;
  commit: string;
  relativePath: string;
  sha256: string;
  byteLength: number;
}
```

请求先验证账户及 Workspace/Conversation 归属，绝对目录只由 Runtime 解析；客户端不传 worktreePath 作为执行依据。每个 mutation 带 requestId，持久化唯一键保证重复请求返回同一结果。

## 4. 文件布局、Git 规则和初始化

### 4.1 固定布局

```text
<accountData>/workspace-git/<workspaceId>/
  repository.git/
  integration/
  sessions/<conversationId>/
  services/<serviceId>/<sourceCommit>/
  operations/<operationId>/       恢复清单、暂存写回文件；不作为执行后端
```

路径段使用现有 `boundedPathSegment`，DB 保存完整业务 ID；不能把用户标题作为目录名。服务 sourceCommit 固定为完整 OID。私有仓库使用 `--object-format=sha1`，OID 为 40 位十六进制；SHA-256 用作文件内容校验，不混用两种 hash。

内部 refs：

```text
refs/heads/main
refs/heads/sessions/<conversationId>
refs/metawork/delivered
refs/metawork/operations/<operationId>
refs/metawork/results/<changeId>
refs/metawork/artifacts/<artifactVersionId>
refs/metawork/services/<serviceWorktreeId>
```

`main` 记录内部主干；`delivered` 固定最后已写回版本。写回未完成期间两者允许不同；新会话从 delivered 创建，不能读到未交付 main。会话独立继续执行不依赖 integration 没有冲突。

### 4.2 Git 命令实现

使用 `execFile/spawn(executable, args)`，不拼 shell 命令。Git 来自安装器检查的受管工具路径。统一设置内部作者身份、`core.autocrlf=false`、`commit.gpgSign=false`、`gc.auto=0`、空 hooks 目录；隔离系统及用户 Git config、属性文件和 `GIT_*` 注入。

文件入库使用 `hash-object --no-filters`、受控临时 index、`update-index --index-info -z`、`write-tree`、`commit-tree`。业务文件的 `.gitattributes` 作为内容保留，但不允许其过滤器、文本转换和自定义 merge driver 改变内部版本字节。由 Runtime 生成仓库 `info/attributes` 的逐路径最高优先级规则，清除 filter/text/ident/working-tree-encoding，自行指定内置 text/binary merge。新增路径在合并前补全规则。

文本判定固定为：受支持 UTF-8 且无 NUL 的普通文件；`.pptx/.docx/.xlsx/.ppt/.doc/.xls/.pdf` 和图片类型强制 binary，其余非文本也 binary。只有内置三方文本合并自动运行；不运行用户定义的 merge 工具。重命名交付按删除加新增落地，保留 Git 的展示关联。

会话里的 Git 提交不能作为 Runtime 可信完成凭证。每次 seal 校验 git-common-dir、当前分支和受管 refs；模型改动自己分支时记录实际文件树并生成 Runtime 提交，不能执行模型要求的 main 更新。私有 main 只由集成服务推进。

Worktree 不是 OS 沙箱。原生 Harness 的任意 shell 不可能单靠 cwd 获得绝对隔离；沿用现有 Host 权限边界，不宣称可以阻挡恶意进程跨目录写入。检测到内部 refs 非预期变化时暂停对账，不信任被篡改的 main。

### 4.3 初始化算法

1. 通过 WorkspaceDirectoryService 规范化用户路径，检查运行目录包含关系、大小写别名及已有 Workspace 重叠。
2. 文件 Catalog 写入 Workspace 身份；SQLite 插入 `workspace_git_roots(initializing)`，持久化初始化 operationId。
3. 创建 bare 仓库。通过临时 index 的空 tree 和 commit-tree 建立空 seed commit，再 `worktree add integration main`。不能假设无 HEAD 的 bare 仓库可直接常规检出。
4. 按固定文件规则扫描用户目录，以文件读取前后 stat 和内容 hash 验证稳定性。扫描有变化则重扫受影响路径；连续 3 次不稳定进入 `failed/source_changing`，可显式重试，不冻结用户编辑器。
5. 把文件原字节导入 integration，建立 baseline commit，固定 operation ref。
6. 更新 main、delivered，记录 DB commit；标记 ready。未完成前不启动新会话 Planner/Executor。
7. 空目录保留 seed commit 作为 baseline。初始化不写回用户目录。

Catalog 与 SQLite 无共同事务：Catalog 成功但 DB 未创建时，重复选择/启动恢复按 workspaceId 补齐初始化；DB 已存在但目录失效时记录错误，不创建替代用户目录。失败 Workspace 仍能被查询、重试和移除，不能显示为无内容的新成功 Workspace。

### 4.3.1 初始化反馈、幂等和客户端状态

私有 Git 初始化是一次性成本，但不能表现为无响应的同步阻塞。应用命令在写入 `workspace_git_roots(state='initializing')` 和初始化 operation 后立即返回准备中回执；回执至少包含 `workspaceId`、`operationId`、`state` 和可重试标记。前端收到回执后将创建按钮置为“创建中…”，禁用重复提交，并显示不确定进度提示“正在建立 Workspace 基线”。初始化完成前，Workspace 选择器和会话入口只能展示 `initializing`，不能让 Planner、Executor 或 Session Worktree 进入 ready。

初始化请求必须由客户端生成稳定 `requestId`，服务端以规范化 `canonical_path`、Workspace 身份和 requestId 做幂等判定：

1. 同一活动 operation 的重复请求返回原 operation 和当前状态，不再次扫描、不再次 `git init`、不创建第二个身份。
2. Server 重启或客户端重连时，先读取 operation/root 状态，再恢复“创建中…”或错误提示；不能把未完成操作当作未点击。
3. 成功时以同一持久化提交更新 `ready`，前端才恢复创建按钮和会话入口。
4. 失败时保留 `failed`、真实错误和 operation 诊断，按钮改为“重试”；重试继续原 Workspace 身份并先执行恢复对账。
5. 初始化过程中若用户再次点击，客户端阻止请求，服务端仍必须拒绝重复 operation，不能依赖 UI 作为唯一保护。

Session Worktree 创建、会话删除和清理使用同一套模式：先持久化 `preparing` 或 `cleanup_pending`，快速返回回执，再由后台完成检出或清理；按钮状态由 Gateway 读模型更新。快速回执只表示请求已接纳，不表示 Git 操作已经完成。

### 4.4 文件规则及边界

使用产品设计第 2.3 节的唯一排除清单：`.git` 永远不导入；任意层级 node_modules、.venv、venv、__pycache__、.cache，以及会话根 `.metawork-tmp/` 默认排除；Workspace `.gitignore` 管理其他未追踪文件。已追踪文件继续追踪。精确指定的输入和 fileOutputs 覆盖普通 ignore，但不能覆盖 `.git` 禁令。

明确输入来自原 Workspace 且尚未入库时，在 prepareTurn 前由同一 Workspace 队列执行路径导入，提交到私有主干并推进 delivered（内容本来就在用户目录）；再同步会话。导入不能把整个被忽略目录当作“精确文件”。声明目录输出需展开为有界的具体文件集合。

产品基线缺少数字的容量范围在此固定首版值：单次纳入普通文件不超过 100,000 个、单文件不超过 1 GiB、纳入总字节不超过 20 GiB；Git 操作默认 120 秒，初始导入和大写回 30 分钟。超限/超时报告具体路径及已保留工作，不改为别的后端、不把截断范围标成完整。部署容量配置仅能调整这些数值，不提供模式切换。

符号链接入库只存 link target；读取附件仍要求最终常规文件及 containment，不能通过链接下载外部文件。父目录是链接的目标不能写回。忽略目录中存在用户文件时，目录删除/类型替换不能递归清空它们，必须报冲突。ACL、扩展属性、空目录不属于 Git 文件交付承诺。

同账户目录同一 realpath 复用 workspaceId；父子重叠选择直接提示已有 Workspace，要求使用已有 Workspace 下的相对项目路径，不建立第二个主干。跨账户也不能同时对同物理目录登记活动交付者：Server 级目录注册锁做规范路径重叠检查，持久记录归属，保持账户内容隔离。

## 5. 数据模型与迁移

所有运行表进入现有账户 SQLite；不把 Git 仓库存到 DB，不迁移 Workspace Catalog 的领域归属。下列为目标字段和约束，迁移必须同步新库 DDL 与 61→62 升级代码。

### 5.1 核心表

| 表 | 主键/唯一约束 | 必需字段 |
| --- | --- | --- |
| `workspace_git_roots` | PK workspace_id；UNIQUE canonical_path | account_id、repository_path、integration_path、state、main_commit、delivered_commit、next_sequence、active_job_id、row_version、last_error、created_at、updated_at |
| `conversation_git_worktrees` | PK worktree_id；UNIQUE conversation_id（仅活动行）；UNIQUE workspace_id+branch（仅活动行） | workspace_id、conversation_id、incarnation、branch、root_path、base_commit、head_commit、state、owner_task_id、owner_token、cleanup_requested_at、created_at、updated_at |
| `conversation_execution_bindings` | PK task_id+generation_id | workspace_id、conversation_id、worktree_id、incarnation、user_root、execution_root、task_base_commit、binding_fingerprint、created_at |
| `task_workspace_changes` | PK change_id；UNIQUE task_id+generation_id+result_commit | workspace_id、conversation_id、worktree_id、base_commit、result_commit、state、delivery_policy、created_at、updated_at |
| `workspace_merge_jobs` | PK job_id；UNIQUE workspace_id+sequence；UNIQUE change_id；UNIQUE request_id | task_id、workspace_id、conversation_id、source_commit、expected_main、external_commit、merged_commit、state、conflict_version、cancel_requested、operation_id、row_version、error、各阶段时间 |
| `workspace_merge_files` | PK job_id+ordinal；UNIQUE job_id+relative_path | operation、before_kind、before_blob、before_mode、after_kind、after_blob、after_mode、before_sha256、after_sha256、state、backup_blob、last_error |
| `workspace_git_operations` | PK operation_id；UNIQUE idempotency_key | workspace_id、conversation_id（nullable）、kind、owner_token、owner_process、state、expected_ref、target_commit、payload_json、started_at、updated_at、finished_at |
| `service_git_worktrees` | PK service_worktree_id；UNIQUE workspace_id+service_id+source_commit | source_task_id、source_commit、project_path、root_path、state、process_token、runtime_dirty、created_at、updated_at |

Workspace Catalog 没有 SQLite 表，因此 workspace_id 不建立指向虚构 catalog 表的外键。新表之间使用实际外键；Task 关联现有 tasks。Conversation Catalog 同样通过应用层归属校验。所有查询从当前账户实例出发，不能只凭裸 workspaceId 跨账户查库。

所有 OID nullable 字段：仅在对应准备阶段允许 NULL；ready/root、sealed/change、delivered/job 必须有相应提交。状态用 CHECK 约束，row_version 用乐观更新；JSON 只放有界诊断及动作载荷，逐文件进度不能塞成巨大 JSON。

必要索引：

```sql
CREATE INDEX workspace_merge_queue
  ON workspace_merge_jobs(workspace_id, sequence);
CREATE UNIQUE INDEX one_live_conversation_worktree
  ON conversation_git_worktrees(conversation_id)
  WHERE state <> 'cleaned';
CREATE INDEX conversation_changes
  ON task_workspace_changes(conversation_id, created_at);
CREATE INDEX workspace_git_unfinished_operations
  ON workspace_git_operations(state, updated_at);
CREATE INDEX pending_writeback_files
  ON workspace_merge_files(job_id, state, ordinal);
```

`next_sequence` 在 BEGIN IMMEDIATE 中分配并插入 job；重复 requestId/changeId 返回已有项，不重新分配。worker 取最小非终态 sequence；冲突项不能被后面的项越过。

### 5.2 精确状态集合

| 对象 | 状态 |
| --- | --- |
| Workspace Git root | initializing、ready、recovering、failed |
| Conversation Worktree | creating、idle、executing、awaiting_delivery、conflicted、retained、cleaning、cleaned、failed |
| Task change | sealing、sealed、held、queued、delivered、abandoned |
| Merge job | queued、preparing、merging、conflicted、writing、recovering、delivered、cancelled |
| Merge file | pending、prepared、applied、conflicted |
| Git operation | prepared、applying、applied、needs_recovery |
| Service Worktree | preparing、ready、running、stopped、retained、cleaning、cleaned、failed |

这些是运行对象状态，不新增 Task 的第七种状态。错误暂停保留 job 原阶段和 error，进入 recovering；用户语义冲突进入 conflicted。超时是诊断，不自动转换为“业务已失败，重新执行全部”。

### 5.3 现有表扩展

- `executor_attempt_runtime` 增加 `worktree_id`、`worktree_incarnation`、`before_commit`、`after_commit`，由现有 `ExecutorAttemptRuntimeRepo` 读写。
- `managed_local_services` 增加 nullable `source_commit`、`project_path`、`service_worktree_id`。旧行维持历史语义，新启动必须全部填充。
- `artifact_versions` 增加 `git_commit`、`git_relative_path`；新版本使用现有 objectUri 字段的内部 `git-object:<workspaceId>:<commit>:<encodedPath>` locator。旧对象继续由既有 reader 读取，新对象只从 Git blob 流式读取。
- Task 新生命周期通过 `task_workspace_changes` 和 facts 推导，不把新增 JSON mode 塞回旧 `tasks.execution_mode`。新路径不读取旧 mode；若旧列 NOT NULL，迁移改为允许 NULL，并要求新行 NULL，旧值只读。
- `workspace_execution_bindings` 保留历史，新的 admission 只写 `conversation_execution_bindings`；所有生产查找以绑定版本判定，禁止“新绑定缺失就按旧根执行”。

artifact_versions 现有按内容去重：命中同路径同内容旧对象时复用其原 reader，不覆盖旧 objectUri。新 Git 版本创建对应 pin ref，先 pin 再落 DB；崩溃产生多余 ref可清理，不能先落引用再让 commit 被 GC。

### 5.4 三种跨介质事务

1. **Catalog ↔ SQLite：**依靠 workspaceId/conversationId 幂等初始化补齐，不宣称原子事务。
2. **Git ↔ SQLite：**先写 operation intent；生成并 pin Git 提交；CAS 更新 ref；最后写 DB applied。重启根据 operation/ref/commit 对账。
3. **用户文件 ↔ SQLite：**先持久化写回清单和 before blob；逐文件写入；最后标 applied。内容已为 after 且日志未落盘时补写完成事实，不重复执行任务。

Git mutation 必须在 operation 内，不允许只写进程日志。prepared 记录已经包含足以判定“没做/做完/需人工”的路径、预期 ref 和 hash。

## 6. 会话执行链路

### 6.1 创建、规划和版本绑定

WorkspaceDirectoryService 创建会话后，由 Account 应用编排调用 `ConversationWorktreePort.ensure()`；目录就绪前不调用 Planner。失败仍保留可重试会话身份，不重复创建 conversationId。

ensure 从 delivered ref 创建会话分支，记录 incarnation=1。清理后重建使用新的 worktree_id、递增 incarnation；老 Attempt 的指纹不能在同名目录上生效。

prepareTurn 执行：

1. 确认当前会话没有活跃 Attempt、Planner 文件观察、同步和交付残留。
2. 同步用户目录的外部编辑；有活动合并冲突时不抢占队列，使用最后 delivered 版本继续新会话执行。
3. 将 delivered 合入会话；会话干净且是祖先则 fast-forward，有 held 工作则正常三方合并。
4. 同步冲突记录为 `kind=conversation_sync` 的 Git operation；不借用另一个 Task 的合并 job。动作 API 携带该 operationId 及 conflictVersion。
5. 绑定该轮 Planner 观察的 worktreeId/incarnation/headCommit，整个 Planner→proposal admission 窗口不更新目录。Proposal 提交后重新检查，变化时返回明确 stale-context 并重读，不用旧规划直接写新文件。

`PlannerProcessSupervisor.resolveAuthorizedWorkspace()` 返回 executionRoot。UI Workspace 卡片仍显示 userRoot。禁止把 userRoot 作为 Planner 首选 cwd fallback。

### 6.2 执行上下文

新上下文固定如下，不保留可选 mode：

```ts
interface ConversationAttemptContext {
  bindingVersion: 'conversation-git-v1';
  accountId: string;
  workspaceId: string;
  conversationId: string;
  worktreeId: string;
  incarnation: number;
  userRoot: string;
  executionRoot: string;
  taskId: string;
  generationId: string;
  subtaskId: string;
  attemptId: string;
  taskBaseCommit: string;
  configurationRevision: string;
  bindingFingerprint: string;
}
```

fingerprint 对以上稳定绑定字段作 SHA-256；不把会变化的 branch HEAD 放进去。每次 Attempt 另外记录 beforeCommit。路径校验依据内部 Worktree registry 和 git-common-dir，不再要求 executionRoot 在 userRoot 之内。

原生后端将执行根作为 cwd。现有 `in-place-attempt-execution-backend.ts` 抽出并重命名为 `native-attempt-execution-backend.ts`，只做进程生命周期；新 backend kind 为 `native`，历史 `in_place/worktree` kind 仅用于旧记录读取。Docker 后端挂载同一个会话 Worktree 到 `/workspace`，Git 元数据绝对路径不可直接在容器解析，封存 Git 操作始终在 Host 执行；容器不挂载整个账户仓库。进程载体 native/container 与唯一 Workspace 模型无关。

`.metawork-tmp/<attemptId>` 位于会话内，承接临时输出。历史输入和 handoff 仍由现有输入 materializer 提供；不引入只读任务第二目录模型，不因 workspaceIntent 限制 Harness 的工具注册。

### 6.3 同会话串行与资源锁

首版所有 Executor Attempt 都按会话串行，包含自称 read_only 的 Attempt。这样不需要猜 shell 是否会写文件，也不破坏 Planner/Harness 工具边界。Work Graph frontier 保留，但每个会话每次仅持有一个 Attempt reservation；不同会话仍受账户容量上限控制。

- 长锁：Attempt 持有 executionRoot 的 ResourceLease，及 conversation owner token。
- 短锁：Git worktree add/remove 和共享 ref 操作取得仓库 metadata lock。
- 集成锁：只有 worker 修改 integration/main 和写回 userRoot 时持有。
- 锁顺序：会话占用 → 仓库 metadata；集成占用 → 仓库 metadata。worker 写回结束后释放集成占用，再唤醒会话同步，不同时持有集成锁等待会话长锁。

复用 ResourceLease 的物理路径冲突和持久化机制，新增应用操作 owner 类型，允许 operationId 而非伪造 Attempt。跨进程互斥必须包含本机进程身份；心跳过期不等于旧写者死亡。接管前先证实旧 owner 及子 Git 进程退出；无法证实则进入恢复等待，不启用第二写者。每次 ref/文件 mutation 前验证 token。

Conflict job 保留 durable active_job_id，但释放实际进程锁；因此既阻止后续写回，又不长期占住数据库事务。UI 决策重新取得集成锁后执行。

### 6.4 Subtask 完成和 handoff

这是与旧 Subtask publication 的关键差别：

1. Attempt 结束后停止其残余写进程，捕获业务文件树并生成固定提交。
2. `AttemptTerminalService.land()` 同事务写 receipt、afterCommit 引用、Subtask done、outgoing handoffs。
3. 下游使用明确边引用读取固定版本；共享目录的存在不能代替 handoff。
4. 下游串行执行，使用同会话目录，不等待用户 Workspace 发布。
5. Task 的全部 Subtask 完成后，才生成一项 Task change 并入队。

不能让每个 Subtask 等 Task merge 才 done，否则下游永远无法运行，形成循环等待。Task state 必须额外等待 workspace_delivery requirement，不能看到所有 Subtask done 就提前 succeeded。

共享会话目录意味着后续 Subtask 可以物理看见前序 sibling 的文件；本方案不再宣称旧“独立 Subtask checkout、只含依赖祖先文件”的文件隔离保证。保留显式 handoff 作为语义和数据来源契约；实施需同步修订 ADR-0021/0025 的相关表述。

### 6.5 整个 Task 封存

每个成功 Attempt 都有 Runtime commit；失败 Attempt 的文件改动保留为未交付工作，不自动混入下一个 Task。重试在同一目录修复；用户放弃时先 pin 失败现场，再重置会话到上次稳定提交，不操作 userRoot。未知进程副作用必须先收敛才能重置。

Task change 的 base 是本轮开始时 main 同步后的会话提交，source 是最终固定提交。原有 held 版本须显式作为本轮前序，显示累计未发布变化；不把它偷偷当成无关临时文件删除。

Task 的发布集合是 base→source 的全部纳入变更，fileOutputs 仅控制可下载产物。新网站的源码不能只发布一个截图附件，PPT 的依赖图片不能因没列为独立附件就丢失。

用户要求仅预览时 change=held，Task 的完成目标为“生成预览”，可成功并释放会话槽位；未来“发布”产生新 Task 指向该 change，不重开旧成功 Task。发布范围和累计未发布变化在确认内容中明确列出。

## 7. Workspace 合并算法

### 7.1 版本符号

- D：处理工作项前最后已交付提交。
- S：本项固定会话 source commit。
- E：将用户目录相对 D 的外部修改提交后的主干；没有外部变化时 E=D。
- M：将 S 合入 E 的结果提交。

合并必须保留真实 Git 祖先关系，不以“整棵会话文件树覆盖主干”代替 merge。交付清单计算 **E→M**，不能计算 S→M，也不能把 D→E 的用户修改当作本任务覆盖内容。

### 7.2 Worker 顺序

```text
claim FIFO head + durable owner
  → reconcile previous operation
  → compare user tree against D
  → create/pin E, advance main and delivered to E
  → prepare operation(expectedMain=E, source=S)
  → git merge --no-ff --no-commit S inside integration
  → [conflict] persist stages + job.conflicted, release process lock
  → [clean] write merge tree, create/pin M, CAS main E→M
  → persist E→M writeback manifest
  → apply files with before checks
  → verify written paths
  → advance delivered E→M
  → DB job.delivered + change.delivered + Task facts/outbox
  → release integration owner
  → synchronize idle conversation, wake next FIFO item
```

external commit 记录的是已在用户目录里的状态，必须在推进 delivered 前验证扫描没有过期。扫描并非整个目录原子快照，连续变动时停留 preparing 并提示，不编造“已捕获稳定全树”。同一物理路径不允许两个工作项并行写回。

如果 S 已是 E 的祖先，则不执行 merge，交付差异为空，仍以同一 job 幂等完成。文本合并无冲突只说明 Git 合并成功，不证明合成项目能运行；原执行测试结果始终标注为 sourceCommit，不能标成 mergedCommit 测试通过。用户要求的合并后构建/服务健康属于单独验证事实。

每次推进 main 使用 `update-ref new old` 比较旧值。与 operation 不匹配的 refs 变化必须进入 recovering；不得自动 reset 掩盖外部干扰。

### 7.3 逐文件写回

清单持久化后按以下顺序执行：先验证所有受影响路径及父目录，再按深度降序删除目标文件，处理类型变化，按深度升序创建目录及文件；最后只清理本次产生的空目录。删除不得递归波及未纳入文件。

每个文件的事务步骤：

1. 从 Git blob 读取 after 内容到目标父目录下的 `.metawork-write-<jobId>-<ordinal>.tmp`，同卷暂存确保 rename 可用；该临时命名空间在文件观察中排除并仅由本 job 清理。
2. 校验目标当前 kind/hash/mode 等于清单 before，创建项要求目标不存在；把实际 before 内容存成私有 Git blob 并 pin 恢复 tree。
3. 落 `prepared` 事实并 flush 临时文件；重新验证父目录未被替换成链接、目标版本未变化。
4. 替换已有文件采用原子 rename；新增文件采用 exclusive-create/no-clobber 安装，EEXIST 视为冲突；删除检查后执行 unlink，不用递归 rm。
5. 复读目标，校验 after hash/mode；成功落 `applied`。
6. 所有项完成后验证最终 affected-path tree，更新 delivered 和 DB 交付事实。

原子重命名只保障一个文件不会被看到半截内容，不保障“检查到替换”没有外部竞争，也不保障多个文件同时可见。保留 before/after/actual 版本作为恢复材料；检测到用户二次修改立即停止，不使用 last-writer-wins 重试覆盖。

写回遇到 Office 文件占用、只读权限、磁盘满、目标被删除，保留文件清单和已应用项；Task 显示交付故障，重试只恢复写回。复制文件不继承内部 Worktree 的 owner/chown；保留原文件普通权限，新文件使用用户环境正常权限，不调用旧 WorkspaceStore 对用户目录递归 chmod/chown。

### 7.4 冲突 API、初始化反馈与并发点击

复用 Gateway 命令分发和身份校验，新增以下应用命令（目标 schema）：

```ts
type ConflictResolution = {
  requestId: string;
  workspaceId: string;
  operationId: string;
  jobId: string | null; // 会话同步冲突无 merge job
  expectedConflictVersion: number;
  actions: Array<{
    path: string;
    action: 'keep_main' | 'take_session' | 'save_as' | 'resolved_file';
    newPath?: string;       // 仅 save_as，Workspace-relative
    resultReference?: string; // 仅 resolved_file，已验证的上传/产物引用
  }>;
};
```

查询：`get_workspace_merge_queue`、`get_workspace_merge_conflict`。动作：`resolve_workspace_merge_conflict`、`retry_workspace_merge`、`cancel_workspace_merge`。会话同步冲突由同一 resolve facade 根据 operation kind 路由，客户端不能把 jobId 换成另一个任务。

Workspace 初始化和 Session 生命周期查询复用同一 Gateway 读模型，至少暴露 `state`、`operationId`、`requestId`、`createdAt`、`updatedAt` 和有界错误信息。初始化不新增一套临时 UI 状态；Web、TUI 和其他客户端都依据该事实显示“创建中/准备中/清理中/失败/就绪”。

用户选择只修改内部冲突现场。全部路径解决、stage 1/2/3 清空后生成 M，再走统一写回流程。手工文件必须通过有界内容引用读取，客户端不能传内部绝对路径。旧 conflictVersion 返回 stale，不“尽量套用”；同 requestId 重放返回原结果，多客户端只有一次决策生效。

对写回途中出现的 late conflict，先保留部分交付现场。用户决策生成以当前外部内容为依据的新恢复提交和修订清单；已 applied 且仍等于 after 的项跳过，被用户再改过的项重新成为显式冲突。不能复用最初 before 条件强写。

### 7.5 取消

- queued/preparing/merging/conflicted，且任何用户文件尚未写入：取消工作项，保留 S 和会话；清理 integration 的未交付 merge 状态，main 在预期 ref 匹配下回到 E，delivered 不变。
- 已进入 writing：记录 cancel_requested，停止普通推进，不立即标 cancelled 后丢弃进度。用户选择“完成剩余写回”或“保留当前部分交付并取消”。后者验证现状并创建实际文件树 R，main/delivered 对齐 R，明确记录部分交付清单；不自动回滚已写用户文件。
- Server 崩溃不能被当作用户取消，按第 8 节恢复。

取消合并不等于删除会话成果。后续继续编辑必须先处置未交付工作，不能在另一个 Task 的提交中静默夹带。

## 8. 崩溃恢复、锁与幂等

启动恢复在账户接受新的写请求前执行；Workspace 级故障只停该 Workspace 的集成，不阻止无关 Workspace。

| 故障点 | 恢复依据 | 确定动作 |
| --- | --- | --- |
| Catalog 已写、Git 尚未创建 | workspaceId + root initializing | 幂等补建私有仓库；用户目录不动 |
| worktree add 完成、DB 未标 ready | Git worktree list + 受管路径 + operation | 校验归属后补落 DB，不再创建第二目录 |
| Executor 失联 | Attempt 进程身份、lease、receipt | 先确认进程及子进程停止，保留文件；不仅凭过期 heartbeat 启动重试 |
| seal commit 完成、receipt 未写 | operation ref + attemptId + 已保存结果 | 可证实结果完整则补落 receipt/handoff；缺证据保留待恢复，不编造 done |
| E 已创建、DB 未提交 | external operation ref + 用户树版本 | 校验后补齐 main/delivered；用户继续变化则重新观察 |
| merge 冲突后重启 | operation、MERGE_HEAD、index stages、E/S | 恢复同一 conflictVersion，保留现场 |
| M 已生成、main 尚未更新 | pinned M + expected E | CAS 推进，不再次生成不同父关系提交 |
| main=M、manifest 尚未保存 | M 的父提交 E 和 pinned job | 重建 E→M 清单；用户目录仍须 before 检查 |
| 一个文件写入后、applied 未保存 | before/after blob + 实际内容 | actual=after 补记；actual=before 重试；第三种内容报冲突 |
| 全部写入、delivered 未前进 | 清单和 affected-path 校验 | 推进 delivered 后补 Task 事实，不重跑 Executor |
| delivered 已推进、UI 没收到 | DB/outbox 事件身份 | 补落状态并幂等投递 |
| 清理途中重启 | cleanup operation + Worktree registry | 确认无进程、引用后续清；不猜路径递归删除 |

所有 refs 变更、DB 操作、文件效果按 operationId 关联，不能用最近 Task 解释孤儿操作。未知 Git 进程仍活跃时不回收 repository 锁；保存 PID、启动时间、进程 token，避免 PID 复用误判。只支持当前产品的本机 Server 和本地文件系统，不宣称同一 Git 仓库可跨主机 NFS 多 Server 写入。

不在等待模型、等待用户决策期间持有 SQLite write transaction。Git 操作和文件 I/O 在事务外，短事务提交 intent/结果；BEGIN IMMEDIATE 只用于 claim、序号和状态 CAS。

## 9. 状态、交付与历史产物

### 9.1 Task 六态保持不变

新增 Task required-work kind `workspace_delivery`，在 admission 时创建；无变化时记录 `not_required`，held 请求的目标仅为生成时记录已满足。普通修改任务必须等 merge job delivered 才满足。这样避免 Subtask 全 done 到 job 入队之间出现提前 succeeded 窗口。

| 运行事实 | Task 状态/phase | 展示 |
| --- | --- | --- |
| 尚未启动 Attempt | queued | 等待执行 |
| 正在执行 | running/executing | 执行中 |
| 已封存、等待 FIFO | running/publishing | 工作完成，等待合并 |
| 合并中 | running/publishing | 正在合并 |
| 文件写回中 | running/delivering | 正在写回，已完成 x/y |
| 需要用户解决冲突 | needs_action | 合并冲突及版本选择 |
| 交付 I/O 失败待处理 | needs_action，reason=delivery_failed | 已生成成果，写回失败；重试写回 |
| 全部 required-work 满足 | succeeded | 已完成 |
| 取消并收敛残留 | cancelled | 已取消，注明保留/部分交付 |

现有 needs_action 只能回 queued，再转 running；冲突解决按该合法路径继续，不添加 needs_action→succeeded 捷径。新增 reason `workspace_merge_conflict` 和 pending action 身份；不把冲突伪装成权限申请。

需要开始服务的生成任务，workspace_delivery 和 service requirement 分别完成；交付成功但服务失败时明确显示两项事实。历史源 Task succeeded 永不改回 running。

TaskViewFacts 增加 bounded merge summary，包括 jobId、state、sequence、aheadCount、conflictVersion、completedFiles、totalFiles、error；详细文件列表分页查询。聊天、轨迹、通知和任务列表都读取同一 stateVersion，不以最终文字到达作为成功依据。

保留 executorStartedAt/executorFinishedAt、queuedAt/mergeStartedAt/deliveredAt。执行时长来源于真实 Attempt，等待合并不算 Executor 执行时间；缺时间显示未知，不显示伪造 0 秒。

### 9.2 Artifact 和链接

- Task 私有成果：`artifact_version` 指向固定 Git commit/path，可在等待写回时预览，显示“未写回”。
- 写回成功：登记用户 Workspace live 文件链接，使用原定相对路径。
- 历史消息下载：始终读取固定提交的 blob；不因用户改过同名文件改变旧附件内容。
- Git artifact reader 校验账户、workspace、pin ref、路径、对象类型和 SHA-256；走流式 range 和现有大小上限，不创建全仓库临时检出。
- 新代码不写 `metaclaw-tasks/<task>`；保留历史 `legacy_published_copy` reader。
- 会话删除不删除 Git artifact refs；用户删除历史产物后才解除其 pin。

现有 `VerificationAndDeliveryService`、`UserArtifactPublicationService` 新路径改为“登记引用及投递”，不能在 merge worker 已写回后再复制一遍文件。可见附件和完整工程变更分别展示。

## 10. 固定版本服务链路

### 10.1 服务绑定

沿用 `(accountId, workspaceId, serviceId)`，区分三类身份：

```text
sourceTaskId       产物来自哪一轮，只记录来源
operationTaskId    谁发起当前启动/停止/重启
sourceCommit      实际运行哪份源码
```

`LocalServiceSpecification` 的 specificationRevision 继续表示命令、参数、环境引用、健康检查等规格 hash；它不能兼任 sourceCommit。`LocalServiceRecord` 增加 serviceWorktreeId/sourceCommit/projectPath，后续 stop 按 service identity 和进程 token 找实际进程。

Planner 选择明确目标项目和版本，Runtime 从结果引用解析提交。只有存在多个合理目标时追问；不得扫描 Workspace 根部旧 manifest 作为“刚才的网站”。无 manifest 时继续使用 `local-service-discovery.ts`，从指定提交的项目目录发现命令，并允许 Executor 补齐运行参数。

### 10.2 启动与重启顺序

1. 固定服务操作的 sourceCommit 并建立 service pin ref。
2. `git worktree add --detach` 到固定服务目录；同 serviceId 同 commit 的重复请求复用该行，不启动第二进程。
3. Executor 的服务准备阶段使用 serviceWorktreeId 作为专用执行目标，安装依赖和生成构建输出；它与普通会话文件编辑是同一个 Git 机制，不是回退 In-place。准备阶段有自己的服务锁，不持有会话和集成锁。
4. 准备后校验纳入源码未被改变。需要修源码时反馈给会话 Executor，产生新提交再准备；依赖和构建文件不反向合并到业务源码。
5. 按已登记参数启动，沿用现有进程组/token/日志管理。无 healthPath 时只能显示 running，不能宣称 healthy。
6. 重启到新提交先完成新目录准备，再停止旧进程组，确认退出后启动新版本；同端口不重叠启动。失败保留新旧目录和诊断，不自动把用户数据拷贝到另一版本。
7. 运行服务独立于生成 Task 的会话目录，归档会话不会停止服务。

服务相关字段需进入 RunContract 和诊断，service preparation 的 cwd 不能又落回 `canonicalWorkspacePath`。`ManagedLocalServices.resolvePublishedDirectory(taskId)` 替换为按服务绑定解析固定目录；旧回调只服务历史读取，不作为新启动 fallback。

### 10.3 运行数据与清理

服务 Worktree 的源码基线固定，运行缓存和数据库会改变目录。启动前记录准备后的文件树；停止后确认整个进程组退出，比较运行前后内容。

- 运行后无新增/修改数据、无外部引用：允许清理。
- 运行后有变化：state=retained，保留目录；用户明确删除运行数据才清理。
- 同提交再次启动 retained 目录：复用原目录及数据，不重新 checkout 覆盖。
- 新提交重启需要沿用数据库时：Planner 明确确认数据目标，Executor 执行数据迁移任务；没有授权时不复制和删除旧数据。

服务启动请求本身不自动启动旧源 Task；固定提交服务目录不作为会话 merge 的来源。独立端口、系统全局依赖和外部数据库不被 Worktree 隔离，继续由既有资源/进程边界协调，不把“目录隔离”描述成完整运行环境隔离。

## 11. 清理与 Git 保留

会话 archive/delete/end 先写 cleanup_requested_at，不能直接调用旧 Task retention 的递归 rm。目录有活跃 Attempt、Planner 观察、待交付 job、held/失败工作、冲突、未知进程时保留并显示原因。

清理操作：锁会话 → 确认无写者 → pin 仍被结果引用的提交 → `git worktree remove` → 验证 registry → 删除已无引用的 session branch → DB cleaned。只有用户明确丢弃工作后才带 force；不能把清理重试解释成新的删除授权。

系统历史成果 refs 和 service refs 保留。首版禁用自动对象过期，不对历史成果做按天数 GC；只运行无删除对象效果的检查和注册修复。用户显式删除成果后，在无活跃 Git 操作的维护窗口执行可达性检查，再 GC。这样避免会话清理后历史下载损坏。

Workspace 删除取消内部准备、收敛服务和交付、解除 Catalog 关联；不删除用户真实目录。私有仓库仍有历史成果和运行数据时保留并展示占用，删除这些数据使用现有显式删除流程。

## 12. 实施步骤和源码任务清单

各阶段在同一目标架构下推进，前四阶段不开放新生产会话；第五阶段统一切换。不能只上线“Worktree 执行”而没有交付和恢复。

| 阶段 | 新增/修改 | 交付门槛 |
| --- | --- | --- |
| P0 契约与持久化 | 新 contracts、8 张运行表、现有列扩展、migration、repo、文件规则 | 新库与旧库升级一致；幂等初始化、路径重叠、Git 元数据隔离测试通过 |
| P1 会话执行 | ConversationWorktreeService、Planner cwd、native 后端解耦、新 generation binding、Attempt seal/handoff | 同 Workspace 双会话实际并行；同会话串行；普通问答、链式 Subtask 和重试通过 |
| P2 合并写回 | WorkspaceMergeWorker、writeback、Gateway 冲突动作、Task required-work、artifact reader | 文本/二进制冲突、部分交付、取消、进程级 crash recovery 通过 |
| P3 服务与清理 | ServiceWorktreeService、RunContract、service repo、归档清理 | 网站三轮闭环、服务进程恢复、会话清理不影响服务通过 |
| P4 统一切换 | 配置启动、账户恢复、旧路径退役、安装工具检查、所有 UI 投影 | 原生与 Docker 验收、安装升级、真实办公场景通过后开放 |

现有修改入口必须覆盖：

- Account composition：`account-workspace-services.ts`、`account-execution-services.ts`、`account-planner-services.ts`、`runtime-registry.ts`。
- 会话：`workspace-directory-service.ts`、`conversation-session.ts`、`conversation-runtime-port.ts`；新增初始化/清理状态读取，保持不可变 Workspace 绑定。
- 调度：`conversation-task-scheduler-repo.ts`、现有 dispatch supervisor/runnable frontier；每会话最多一个 Attempt，合并等待为该会话残留。
- 执行：`execution-context.ts`、`kernel-execution-runtime.ts`、`subtask-attempt-runner.ts`、`attempt-terminal-service.ts`、`subtask-execution-context.ts`、`subtask-handoff-materializer.ts`。
- 状态：`task-completion-requirements.ts`、`task-state.ts`、`task-state-facts.ts`、`task-state-authority.ts`、`task-state-facts-reader.ts`、TaskView 两层。
- 交付：`verification-and-delivery-service.ts`、`user-artifact-publication-service.ts`、`task-artifact-repo.ts`、`artifact-version-repo.ts`、现有附件预览及下载入口。
- 服务：`managed-local-service.ts`、`local-service-discovery.ts`、`run-contract.ts`、`local-service.ts`、`managed-local-service-repo.ts`。
- 客户端：Web 及 vendored MetaWork TUI 只适配 Gateway 新 facts/动作，Feishu 同样读取 TaskView；不在 UI 实现合并策略。

删除/停止使用清单：

1. 新任务按用户根申请全程写租约。
2. 新任务 read_only 特殊 scratch 执行目录分支。
3. 新任务从旧 workspace_execution_bindings 查询 mode 的分支。
4. 以 Task/Generation 建仓、Subtask 建 Worktree 的生产入口。
5. 新任务 WorkspacePublicationWorker 及 `publicTaskDirectory` 整树交付。
6. 依据 Task succeeded 清理目录的生产入口。
7. 服务根据最近 Task/用户根推导 cwd 的新请求路径。

保留历史记录 reader，不为历史停放 Worktree 新增恢复执行能力。因实现阶段暂时保留的旧分支必须在 P4 从新任务调用图中移除，模块边界测试验证不可达。

## 13. 升级、启用和回退边界

### 13.1 迁移执行

SQLite 迁移只建表、改列、加索引，不在 DB migration 内执行 Git 和扫描用户文件。旧记录不伪造 Git commit，nullable 新字段保持 NULL。

安装升级前进入 drain：停止新语义请求，等待 Attempt/写回/服务操作收敛。运行中的长期服务可保留，但其旧目录必须继续保留，不能把旧进程伪装成新 service Worktree；第一次用户重启服务时迁移到新固定提交目录。有未知运行副作用时暂停切换并提供具体残留原因。

新版本启动后，已有 Workspace 首次选用时初始化私有仓库；已有 Conversation 首次继续时创建真实 Worktree，完成后再启动 Planner。此前历史消息保持可读。全新 Workspace 在创建流程完成初始化，不延迟到第一次文件写入。

### 13.2 切换开关与降级

产品不提供 mode 设置。内部版本号 `conversation-git-v1` 是持久化 binding 协议，不是用户可选后端。旧 mode 环境变量不改变新会话行为；旧 worktree 开关继续报退役提示。

切换前可回退程序且无需迁移用户文件。切换后生成的新任务和 Git 运行事实不能被旧二进制解释，旧版本必须按 schema 版本拒绝启动，不能把新目录按 In-place 执行。灾难恢复采用升级前数据库备份与保留的用户文件状态，在完成运行副作用对账后处理；不自动把用户已交付成果回滚到安装前内容。

### 13.3 同步文档

实施时更新 ADR-0050（统一会话 Git）、ADR-0037（会话并行及交付槽位）、ADR-0021/0025（Subtask handoff 与 Task 发布分离、共享文件视图）、服务 ADR-0051、ADR-0032（固定 Git 附件）、CONTEXT、技术总览、运行安全文档。ADR-0053 的 Planner/Coordinator/Executor 权责保持不变。

AGENTS.md 仅在导航入口变动时更新，不塞入运行时字段细节。本次撰写不提前修改已接受 ADR 的“已实施”陈述。

## 14. 测试和验收矩阵

不以纯 mock 的 git-success 代替真实文件验证。新增集成测试使用临时目录、真实 Git、真实 SQLite、子进程和故障注入点，不接触开发者 Workspace。

| 测试 | 必须验证的结果 | 归属 |
| --- | --- | --- |
| 空目录/普通办公目录/已有 Git | 同一初始化链；用户 index/refs/config 和未提交业务文件 hash 不被初始化修改 | WorkspaceGitService |
| 选中 Git 子目录 | 不提升父根，不导入 sibling；交付路径不重复 prefix | Workspace |
| 两个会话交错写入 | Attempt 执行时间真正重叠；同一 Workspace 无根锁等待；FIFO 交付不覆盖 | 会话/调度集成 |
| 一个会话多个 Subtask | 全程最多一个 Attempt；done 与 outgoing handoff 同事务；下游无需等 Task merge | Execution/Work Graph |
| Planner→Executor 窗口 | 同一 executionRoot/版本；发生同步变化不能提交陈旧计划 | Planning |
| 普通问答 | 会话有 Worktree；没有 Task 时不伪造 Task；无文件变化无 merge job | 会话 E2E |
| ignored 明确输入/输出 | 精确路径可读取/交付；.git 始终排除；缓存不进主干 | 文件规则 |
| 文件名与类型 | 空格、中文、换行、大小写冲突、链接、目录/文件互换、exec bit | Git/writeback |
| 文本不同位置/同一位置修改 | 自动三方合并与冲突分支分别正确；冲突不进入 userRoot | Merge |
| 同名新增/删除对修改 | 用户明确决策，没有静默覆盖和误删忽略内容 | Merge |
| PPT/Word/Excel 双改 | 保留双方完整字节，用户选择后才写回 | 办公 E2E |
| 外部用户编辑 | 入队前、merge 后、单文件写回前后的变化被检测；保留已知版本 | Writeback |
| 写回权限/磁盘满/文件占用 | Task 不成功；进度保留；重试不重复调用 Executor | Delivery |
| 多客户端冲突决策 | requestId 幂等、conflictVersion CAS、旧动作不可作用新冲突 | Gateway |
| 硬杀进程 | 覆盖第 8 节每个恢复点；main/delivered/DB 最终一致 | 进程级 recovery |
| TTL 过期但 owner 存活 | 不产生第二 Git/文件写者；重启后能辨认 PID 复用 | Resource/recovery |
| 两个 Server 争同队列 | 一个 owner；另一方只读/等待；无重复 sequence 和交付 | 多进程集成 |
| 部分交付取消 | 完成剩余或保留部分决策准确，已写用户内容不被盲目回滚 | Cancellation |
| 生成网站→启动→修改→重启 | 运行提交正确；终态源 Task 不阻止新操作；不同服务端口独立 | Service E2E |
| 服务会话清理 | 原会话目录删除不影响服务；运行数据 retained 不丢失 | Retention |
| 历史附件 | 会话清理和 live 文件改变后，下载仍为原 commit 内容 | Artifact |
| 初始化反馈与重复点击 | 首次建立私有 Git 立即显示创建中；重复点击只得到同一 operation；重启/重连后状态可恢复；失败可重试且不产生空基线 | Workspace/Gateway/Web |
| Session 准备与清理反馈 | Worktree 创建和删除先返回 pending，再异步完成；按钮不会重复创建或删除 | Workspace/Gateway/Web |
| 升级与旧 schema | 新库/升级库一致；旧执行全部停放；61→62 fixtures 不丢历史产物 | Migration |
| 状态一致 | 聊天/轨迹/任务列表同 stateVersion；等待合并不显示 succeeded/0 秒 | Gateway/Web/TUI |

验证顺序：

1. `npm run lint` 与新模块、Task 状态、目录、执行、服务 focused tests。
2. `npm run build`、`npm run build:web`，vendored Planner 改动使用其 `npm run build:offline`。
3. SQLite migration、POSIX 路径、并发 claim、进程恢复测试在 Docker 执行；Docker backend 专测 Worktree 挂载和 Host seal。
4. 原生 macOS 的真实文件/进程/Git 验收，以及目标支持平台的安装与受管 Git 可用性验证。
5. 原生 `npm run smoke:metawork -- --scenario artifact`；新增双会话并行、二进制冲突和三轮网站 smoke 场景。
6. Web/Desktop 真实用户流程：建非 Git Workspace、同时生成 PPT 和调研报告、两会话改同一文件、处理冲突、下载历史文件、会话归档、服务持续运行。

每阶段记录实际命令、通过数、失败原因、平台和 commit。没有运行的检查明确标未运行，不用设计推导替代测试证据。

## 15. 本文交付记录

- 2026-10-29：完成源码接点核对、唯一技术路径、数据模型、状态/恢复、合并写回、服务与迁移方案编写。
- 仅新增技术文档并更新设计导航；未修改执行代码、数据库和当前运行配置。
- 本次文档验证：相对链接存在性、Markdown 代码围栏、`git diff --check`。
- 运行实现完成日期：2026-10-30。
- 已通过：`npm run lint`、`npm run build:web`、Workspace Git、Workspace 合并、Workspace Directory、Gateway focused tests，以及 `git diff --check`。
- 全量 `npm test -- --run` 已执行；当前仓库仍有 63 项失败，集中在旧 In-place/Kernel 行为断言、迁移基线和缺失发布环境文件，未将其伪报为本轮通过。
- 原生/Docker 安装验收与 closing commit：未完成。
