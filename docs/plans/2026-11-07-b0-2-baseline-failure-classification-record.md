# MetaWork B0.2 基线失败逐项判定与修复记录

- 记录日期：2026-11-07（2026-11-07 第二轮：处理复盘报告 B-01/B-02/B-03）
- 状态：B0.2 基线红测已全部关闭（44/44），根套件全绿；Phase 0 仍未关闭（目标能力未交付）
- 上位方案：[产品与架构收敛技术实施方案](2026-11-07-metawork-product-convergence-technical-implementation-plan.md) §3
- 模板：[全批次工程模板](2026-11-07-metawork-product-convergence-technical-implementation-plan.md#11-全批次工程模板)

本记录只承接 B0.2（基线红测逐项定性、缺陷修复与 harness 迁移）。它不授权 Phase 1
ADR 接受、Phase 2/3 的 Router/权限/Kernel 删除，也不把"测试过时"当作整体归因。

## 1. 批次信息

| 项 | 内容 |
| --- | --- |
| Scope / owner | 技术实施方案 §3；基线 44 个失败用例与 14 个失败文件；Workspace intent、Conversation Git、publication/merge、service、用量无关；不改 Router/权限/Kernel 删除 |
| Before | HEAD `83c3f800` + B0.1 未提交改动；`npm test` = **44 failed / 4562 passed / 40 skipped（14 文件）**，复现命令 `npx vitest run`，与本记录起点一致 |
| Contracts | ADR-0050（Conversation Git 唯一新任务模型、2026-11-02/11-03 修订）、ADR-0049（六态 Task 结论）、ADR-0032 amendment（`fileOutputs` 与目录前缀）、ADR-0054（Turn 正文真源）；未接受的新契约一律不落实现 |
| Data | 无 schema 变更。`workspace_records` 身份、`executor_attempt_receipts.configuration_revision`、`attempt_sandboxes.workspace_id`、`conversation_execution_bindings`、`workspace_merge_jobs`、`artifact_versions` 的写入路径被复核；重启重建规则未变 |
| Sequence | 先修生产缺陷（可单独回滚），再迁移 E2E harness 到 Conversation Git 拓扑，最后处理仍依赖退役 publication 的用例 |
| Tests | 每个关闭项至少一条文件级复跑证据；最终全量 `npx vitest run`；`npx tsc --noEmit` |
| Exit | B0.2 退出条件已满足：44 项全部有定论、全部有回归证据、根套件无未分类红测、lint/build 通过。Phase 0 仍不关闭：复盘报告 §5/§6 的目标能力（Pi/Router/Kernel/Token/客户端）不属于本批次 |
| Close | 见 §3、§4、§6 与 §7 |

## 2. 当前结果

| 指标 | 基线 | 第一轮结束 | 本轮结束 |
| --- | --- | --- | --- |
| 失败用例 | 44 | 14 | **0** |
| 失败文件 | 14 | 3 | **0** |
| 通过用例 | 4562 | 4592 | **4614** |
| 跳过 | 40 | 40 | 40 |
| 新增失败 | — | 0 | 0 |
| 类型检查 / 构建 | 通过 | 通过 | 通过 |

复现命令：

```text
npx vitest run
npx tsc --noEmit
```

剩余失败：无。第一轮遗留的 14 项（`task-result-service-acceptance` 5、
`task-state-recovery-journeys` 5、`publication-delivery-recovery` 4）已在第二轮逐项关闭，
见 §5 与 §6。

## 2.1 第二轮：复盘报告确认缺陷的修复（B-01 / B-02 / B-03）

[产品收敛复盘报告](2026-11-07-metawork-product-convergence-retrospective-report.md) 在第一轮
之后确认了三个运行缺陷。三个都已修复并新增回归，其中 B-01/B-02 属于第一轮"绿测覆盖风险"
的纠正。

### B-01（P1）只读授权被执行层升级为写执行

- 根因：准入只看 `deliveryKind/fileOutputs` 得出 `writes=false`，执行层只认显式
  `workspaceEffect='read_only'`；省略该字段的单节点报告因此拿到可写 Worktree 并被合并。
- 修复：`src/work-graph/workspace-effect.ts` 成为唯一 owner 规则
  `resolveWorkspaceWriteEffect()`：显式 `write`、非 report、有 `fileOutputs`、有 artifact
  出边即写；其余一律只读。`ControlKernel`（两处准入）、`SubtaskAttemptRunner`
  （Attempt 访问方式）与写租约使用同一答案；省略/`unknown` 不再等于写授权。
- 行为变化：只读意图 + 无文件输出的节点使用 attempt-owned scratch，业务树只读挂载
  `/source`；意外写业务树会被 `verifyRead` 判为会话污染，不封存、不合并、不产出 artifact。
- 回归：`tests/e2e/read-only-workspace-boundary.test.ts`（3 项：规则解析、只读执行无交付、
  污染隔离）、`tests/work-graph/workspace-effect.test.ts`（重写为唯一规则）、
  `declared-file-delivery` "unsolicited action reports" 从"断言文件已泄漏"改为断言
  "无交付、无 merge、会话隔离"（复盘 B-04 的 characterization 已转为验收断言）。
- 删除：`work-graph-runtime-service` 的"未声明 effect 将独占串行"诊断不再成立，已移除。

### B-02（P1）接受结果把 Git 封存误认为用户修改

- 根因：接受时用 `captureWorkspaceState()` 重新采集**当前** dirty 状态与封存前 delta 做
  `JSON.stringify` 全等比较；`sealAttempt` 已提交并清空 dirty 集，基线漂移导致合法结果
  永远被判"文件已变化"。
- 修复：`SubtaskAttemptRunner.assertSealedDelta()` 以 Attempt 的耐久封存提交对
  （`executor_attempt_runtime.before_commit/after_commit`，新增
  `ExecutorAttemptRuntimeRepo.attemptCommits()`）为身份基准：变更集与内容哈希必须与记录
  delta 一致；若工作区在封存后又被改动，给出独立原因
  `结果工作区在封存后已被修改，请重新确认接受`，不再误报。
- 补全：接受路径此前从不登记下载 artifact；现在用 `prepareGitArtifacts()` 从**封存提交**
  固化版本并在同一事务登记，handoff 路径同样归一为 Workspace-relative。
- 回归：`task-result-service-acceptance` "accepts an uncertified result"、
  `task-state-recovery-journeys` 的两条接受/重启恢复（SIGKILL、staging 前中断）与
  "waits for a slot …" 均通过；断言改为 `task_state_changes` + `workspace_merge_jobs` 事实。

### B-03（P2）目录 intent 语法不一致

- 根因：第一轮让 `workspaceIntent.targetPaths` 接受尾斜杠，但 Kernel `safeTargetPaths` 仍用
  严格 `isWorkspaceRelativePath`，且测试夹具提前删除尾斜杠，掩盖了真实输入。
- 修复：生产规范化唯一入口 `normalizeWorkspaceTargetPaths()` 接受 `site/` 并归一为
  `site`；Kernel 目标路径改走该入口，`fileOutputs` 继续用 `isValidFileOutput`；夹具不再
  预处理被测输入。
- 回归：`tests/kernel/workspace-execution-admission.test.ts` 新增 "directory target
  contract"：schema 解析后的计划直接进入准入（无 helper 改写），断言 resolved 且目标为
  `site`；另断言 `a//b` 仍被拒绝。

## 3. 生产缺陷修复（fix）

以下按"实际行为、保护的不变量、Owner、变更文件、通过证据"记录。均为可独立回滚
的生产修复，不改变 B0.2 边界外的策略。

### F1 物理路径与逻辑根不一致导致交付物被拒（declared-file-delivery）

- 实际行为：Executor 上报 `/private/var/...`（realpath）而 Conversation binding 记录
  `/var/...`（符号链接），`relative()` 产出 `../../..`，封存抛 `invalid_git_path`，
  Attempt 变成 `unknown requires explicit recovery`。
- 不变量：合法、位于执行根内的声明交付物必须能被封存；越界路径仍必须被拒绝。
- 修复：`src/execution/subtask-attempt-runner.ts` 新增 `executionRelativePath()`，两侧
  先 `realpath` 再取相对路径；越界时仍走既有 `assertGitPath` 拒绝。
- 证据：`tests/e2e/declared-file-delivery.test.ts` 11/11 通过。

### F2 Handoff 工件身份与版本身份不一致（declared artifact handoff）

- 实际行为：下发给下游节点的 artifact item 保存了绝对路径，下游
  `subtask-execution-context` 用 `artifact.relativePath === ref.path` 校验失败，
  Attempt 失败（`handoff_artifact_identity_mismatch`）。
- 不变量：一次 handoff 只钉住一个不可变版本身份；下游只能在被授权范围内读取。
- 修复：`src/execution/subtask-attempt-runner.ts` 在落地前把
  `completedEnvelope.handoffs` 归一为 Workspace-relative `declaredHandoffs`，并用同一
  拼写构建 `artifactVersions` 映射。
- 证据：`tests/e2e/declared-file-delivery.test.ts` "declared artifact handoff" 通过。

### F3 重试/续跑 Attempt 重新发明 Workspace 身份（kernel-retry-control-loop）

- 实际行为：continuation Attempt 绑定 `conversation_<attemptId>` 的新 scratch 身份，
  而 `workspace_records` 以 (task, generation, subtask) 为身份，`upsert` 不更新 `id`；
  `attempt_sandboxes.workspace_id` 外键失败，被适配层归一为
  `execution_backend_configuration_failure`，真实的执行失败被掩盖。
- 不变量：同一 (Task, generation, Subtask) 只有一个耐久 Workspace 身份；sandbox 记录
  必须引用真实存在的 Workspace 行；一次 Retry Wake 只产生一次 continuation Attempt。
- 修复：`src/execution/subtask-attempt-runner.ts` 绑定后复用既有耐久 Workspace id。
- 证据：`tests/session/kernel-retry-control-loop.test.ts` 通过（`create` 调用 2 次、
  continuation receipt 1 条）。

### F4 目录型 `fileOutputs`（`site/`）在计划/准入各处被拒

- 实际行为：`isValidFileOutput` 支持以 `/` 结尾的专用目录，但 Planner plan schema、
  plan validator 的路径检查与 Kernel `resolveWorkspaceAdmission` 的
  `uncoveredDeclaredOutputs` 各自用"无空段"规则拒绝 `site/`，计划被判"未通过执行校验"。
- 不变量：目录输出的声明、覆盖检查、完成校验使用同一套 Workspace-relative 语法。
- 修复：`src/planning/planning-agent-plan-schema.ts`、`src/planning/planning-agent-plan-validator.ts`、
  `src/kernel/workspace-execution-decision.ts` 统一改用 `isValidFileOutput` 与尾部 `/`
  归一化比较。
- 证据：`tests/e2e/declared-file-delivery.test.ts` "dedicated directory" 通过。

### F5 持久化 pre-admission 重规划缺少决策 owner

- 实际行为：历史 `authorize_task_plan` 决策不含 `owner`，重放时
  `decision.action.owner.workspaceId` 抛 TypeError，应用落为 `uncertain`。
- 不变量：持久决策的重放必须绑定原 Task 的 Conversation/Workspace，且不得凭空创建。
- 修复：`src/session/session-kernel-runtime.ts` 在缺少 owner 时从目标 Task 派生
  `{conversationId, workspaceId, plannerSessionId}`，缺失时显式失败。
- 证据：`tests/account/account-startup-recovery-service.test.ts` 该用例通过。

### F6 无客户端恢复重规划缺少 Workspace 准入事实（span-recovery）

- 实际行为：`createRecoveryReplanner` 未提供 Workspace 端口，plan_proposed 事件没有
  `workspaceAdmission`，Kernel 回以 "no Workspace is bound to this Conversation"，
  恢复重规划永不生效（`70d90e63` 引入的回归）。
- 不变量：恢复重规划继续的是已准入 Task，其 Workspace 来自该 Task 的耐久绑定，
  不受任何客户端当前选择影响。
- 修复：`src/session/recovery-replanner.ts` 增加 `resolveTaskWorkspace` 端口并以只读
  Workspace 端口注入 ConversationSession；`src/server/server-composition.ts` 用
  Workspace catalog 解析 Task 绑定。
- 证据：`tests/e2e/span-recovery.test.ts` 4/4 通过。

### F7 自动 generation replan 同样缺少 Workspace 准入事实（planning-kernel-path）

- 实际行为：`GenerationReplanWorker` 构造的 `plan_proposed` 没有 `workspaceAdmission`，
  自动重规划被 Kernel 判为需要重新选择工作区。
- 修复：`src/account/generation-replan-worker.ts` 增加 `resolveTaskWorkspace` 端口并把
  事实写入事件；`src/session/metaclaw-session.ts` 与
  `src/account/account-startup-recovery-service.ts` 使用 Conversation Git root 的
  `userRoot` 解析。
- 证据：`tests/session/planning-kernel-path.test.ts` "routes exhausted task failure
  through one Kernel-authorized replan revision" 通过。

### F8 交付完成后用户看不到完成汇总

- 实际行为：Conversation Git 的完成发生在 Workspace FIFO merge 之后，
  `finishDeliveredWorkspaceTask` 以 `finishExecution: async () => {}` 调用
  `completeTask`，完成汇总（"Task #… completed N Subtask(s)"、`Artifacts:`）被丢弃，
  用户最后看到的是 merge 之前打印的"尚未完成"。
- 不变量：Task 终结时用户必须看到唯一、与实际结论一致的完成汇总；outbox 幂等键防止
  重复投递。
- 修复：`src/execution/kernel-execution-runtime.ts` 在交付完成时通过既有 callbacks
  追加完成汇总并刷新状态。
- 证据：`tests/session/scripted-session.test.ts`（8/8）、
  `tests/session/planning-agent-session-routing.test.ts`（3/3）通过；`task-result-service-acceptance`
  的显式 retry 用例同时转为通过。

### F9 固定版本 Artifact 的 Git 仓库根按 `objectRoot` 推导少一级

- 实际行为：`readGitArtifact`/`readGitArtifactAsync` 由
  `<workspaceStore>/objects/sha256/artifacts` 上溯三级得到
  `<workspaceStore>/workspace-git/...`，而仓库实际位于
  `dirname(workspaceStore)/workspace-git/...`，读取 pinned 交付物时
  `fatal: not a git repository`。
- 不变量：Artifact 版本身份（commit/pin/digest/size）校验不变；只修正定位。
- 修复：`src/delivery/git-artifact-reader.ts` 新增 `workspaceRepository()`，按实际存在
  的仓库根解析，保留全部身份校验。
- 证据：`tests/e2e/declared-file-delivery.test.ts` handoff 用例；下载/解析相关单测未改。

## 4. Harness 迁移与契约改写（contract rewrite）

依据 ADR-0050（2026-10-30 / 11-02 / 11-03 修订）、ADR-0049、ADR-0032 amendment。
改写只替换与已接受契约冲突的假设，不删除所保护的不变量。

| 文件 | 用例数 | 处置 | 依据与保护的契约 |
| --- | --- | --- | --- |
| `tests/e2e/planner-owned-workspace-mode.test.ts` | 6 | 全量重写为 Conversation Git 模型（Executor 在 Conversation Worktree 执行；只有 seal + FIFO merge 后才对用户目录可见；artifact 是 `artifact_version` 而非 live copy；`workspace_publications` 恒为 0） | ADR-0050 2026-10-30/11-03：`in_place` 已删除 |
| `tests/e2e/declared-file-delivery.test.ts` | 8 | 交付根改为绑定的用户 Workspace、补 `ArtifactVersionRepo`/`objectRoot`、以 `workspace_merge_jobs` 断言交付、pi-agent 下游使用 JSON 事件 | ADR-0050；ADR-0032 amendment |
| `tests/e2e/span-recovery.test.ts` | 2 | 夹具补 Task 的 `workspaceId` 与 `resolveTaskWorkspace`（与生产组合一致） | F6 |
| `tests/e2e/independent-branch-failure.test.ts` | 1 | 两个文本报告节点声明 `workspaceEffect: read_only`（否则准入拒绝并行读者） | ADR-0050 11-02 修订 |
| `tests/session/blocked-task-user-journey.test.ts` | 2 | `blocked`→`needs_action`、`done`→`succeeded`；断言 unknown 外部结果 fail-closed（`/task resume`、`/task unblock` 均不得启动第二次执行） | ADR-0049；CONTEXT "uncertain external effects" |
| `tests/session/planning-kernel-path.test.ts` | 3 | 交付轨迹 `publication_integrated`→`delivery_completed`；并行读者声明 `workspaceEffect` 与只读 intent；零变更读者不产生 merge job | ADR-0050 |
| `tests/web/conversation-view.test.ts` | 1 | 逐字源码断言改为不变量正则（workspace/session 变化时重置 trajectory 选择） | 行为未变，仅断言脆弱 |
| `tests/e2e/task-result-service-acceptance.test.ts` | 1 | 交付根改为绑定 Workspace 并补 artifact 版本仓库 | ADR-0050 |
| `tests/e2e/task-state-recovery-journeys.test.ts` | 0 | 同一 harness 迁移（未转为关闭） | ADR-0050 |
| `tests/support/planning-agent-plans.ts` | — | `workspaceEffect` 选项、intent target 去尾部 `/`、写意图推导 | ADR-0050/0032 |

## 5. 逐项判定表（44 项）

`fix` = 生产缺陷修复；`contract` = 依据已接受 ADR 改写行为断言；`open` = 结论未关闭。
所有 `fix`/`contract` 项均以文件级复跑为证据（§2 全量结果含在内）。

| # | 文件 / 用例 | 判定 | 结论 |
| --- | --- | --- | --- |
| 1 | account-startup-recovery / pending replan | fix F5 | 关闭 |
| 2 | declared-file-delivery / inline answer | contract + 交付根迁移 | 关闭 |
| 3 | declared-file-delivery / browser action receipt | contract | 关闭 |
| 4 | declared-file-delivery / Git edit without report delivery | contract | 关闭 |
| 5 | declared-file-delivery / requested report with scratch files | fix F1 | 关闭 |
| 6 | declared-file-delivery / requested Office and HTML files | fix F1 + 交付根迁移 | 关闭 |
| 7 | declared-file-delivery / declared artifact handoff | fix F2/F9 + harness | 关闭 |
| 8 | declared-file-delivery / existing file delivery without rewrite | 交付根迁移 | 关闭 |
| 9 | declared-file-delivery / dedicated directory | fix F4 | 关闭 |
| 10 | independent-branch-failure / independent branch after config failure | contract（workspaceEffect） | 关闭 |
| 11-16 | planner-owned-workspace-mode（6 项） | contract（Conversation Git 重写） | 关闭 |
| 17 | span-recovery / request_replan | fix F6 | 关闭 |
| 18 | span-recovery / request_merge_replan | fix F6 | 关闭 |
| 19 | task-result-service-acceptance / keeps receipts on explicit retry | fix F8 | 关闭 |
| 20 | task-result-service-acceptance / real backend API smoke | open | 见 §6 O1 |
| 21 | task-result-service-acceptance / accepts uncertified result | open | 见 §6 O2 |
| 22 | task-result-service-acceptance / modifies selected project | open | 见 §6 O2 |
| 23 | task-result-service-acceptance / service health=true | open | 见 §6 O3 |
| 24 | task-result-service-acceptance / service health=false | open | 见 §6 O3 |
| 25 | task-state-recovery / SIGKILL after acceptance commit | open | 见 §6 O2 |
| 26 | task-state-recovery / acceptance before result staging | open | 见 §6 O2 |
| 27 | task-state-recovery / restarts handed-over service | open | 见 §6 O3 |
| 28 | task-state-recovery / port_in_use attribution | open | 见 §6 O3 |
| 29 | task-state-recovery / slot wait + cancel before staging | open | 见 §6 O4 |
| 30 | blocked-task-user-journey / resumes incomplete response | contract（六态 + fail-closed） | 关闭（策略问题见 O5） |
| 31 | blocked-task-user-journey / /task unblock workspace-only | contract（fail-closed） | 关闭（策略问题见 O5） |
| 32 | kernel-retry-control-loop / retry wake | fix F3 | 关闭 |
| 33 | planning-kernel-path / authorizes durable task + audits | contract（delivery_completed） | 关闭 |
| 34 | planning-kernel-path / independent frontier concurrency | contract（workspaceEffect + 只读 intent） | 关闭 |
| 35 | planning-kernel-path / exhausted failure replan | fix F7 | 关闭 |
| 36-37 | planning-agent-session-routing（2 项） | fix F8 | 关闭 |
| 38-39 | scripted-session（2 项） | fix F8 | 关闭 |
| 40 | web conversation-view / historical Turn | 断言脆弱 | 关闭 |
| 41-44 | publication-delivery-recovery（4 项） | fix/contract（writeback 故障注入） | 关闭（见 §6 O6） |

（表中 11-16、36-37、38-39、41-44 为同文件同处置的合并行，合计 44 项。第二轮追加的
B-01/B-02/B-03 与 §6 的 4 条生产修复不属于原 44 项，见 §2.1 与 §6。）

## 6. 第一轮未关闭项的最终处置（全部关闭）

第一轮记录的 14 项红测与 6 条 open 项在本轮全部关闭，处置与证据如下。

| 原 open 项 | 实际根因 | 处置 | 证据 |
| --- | --- | --- | --- |
| O1 并发图里的独立报告节点 `completion_malformed` | 该节点的 responder 语义与"未认证结果等待用户决策"契约冲突；Kernel 在接受决策前不释放 frontier | 测试改为验收当前契约：未认证兄弟结果先挂起独立分支，用户显式 `/task accept-result` 后分支运行一次；服务由交付启动并健康 | `task-result-service-acceptance` "holds the independent API smoke until the uncertified UI draft is accepted" |
| O2 未认证结果的接受/恢复 | 复盘 B-02（封存基线漂移）+ 接受路径不登记 artifact | 生产修复（§2.1 B-02）；恢复测试改为 Conversation Git 契约（无 `publication_accepted_*` 行，`accept_result` 操作与 merge 各恰好一次） | `task-result-service-acceptance`、`task-state-recovery-journeys` |
| O3 服务发布/端口归因按退役 publication | harness 的 `resolvePublishedDirectory` 只看 `public_files`；manager 缺 `resolveWorkspaceId`；服务记录无 Workspace 时无法用命令重新定位 | 生产补 `localServiceTaskId` 的 Workspace 解析回退；harness 用 `WorkspaceGitRepo.sourceForTask`（真实交付事实）解析目录并注入 `resolveWorkspaceId` | `restarts a handed-over service…`、`port_in_use`、两个 health 用例 |
| O4 取消/等待阶段按 publication 计数 | 断言对象退役 | 改为 `task_state_changes` 的 `accept_result:%` 与 `workspace_merge_jobs` 终态；保留"取消不新增写回/不重跑"断言 | `waits for a slot and respects cancellation before staging` |
| O5 未声明文件是否可合并（产品/架构冲突） | 准入与租约规则不一致 | §2.1 B-01 统一为单一 owner 规则：只读意图的节点按只读执行，业务树写入被隔离，不产生交付。技术方案 §3.3 与 ADR-0050 的措辞冲突仍需在 ADR-0050 修订时收敛（文档待办，不是代码缺陷） | `read-only-workspace-boundary`、`declared-file-delivery` |
| O6 publication 复制故障恢复需等价改写 | 故障注入点退役 | 改为在 `WorkspaceWritebackService.apply` / `WorkspaceGitRepo.operationState` 注入真实故障，断言"不重跑 Executor、封存成果保留、恢复只交付一次、取消不新增写回" | `publication-delivery-recovery`（4 项） |

本轮新增的生产修复（除 §2.1 三项外）：

- 重试复用交付成果：`retryRemainingWork` 以交付的 Conversation Git 变更（或已应用的
  no-change 轮次）作为"可安全复用成果"，重试不再因缺少 publication 行被拒；
  `verifyConversationDeliveredSource()` 在启动服务前校验封存提交与文件哈希。
- 服务重新定位：`localServiceTaskId` 在记录无 Workspace 时按 Task 绑定解析，避免已交付
  服务在同会话内变成"不存在"。
- 交付完成汇总：交付成功后的完成输出与最终结论一致（第一轮 F8 的延续）。
- 维护项（复盘 §4.2）：移除遗留的 `console.error('ATTEMPT_ERROR', …)` 调试日志与
  `workspaceGitRepo` 重复赋值；固定版本 Artifact 的仓库定位改为 writer/reader 共用的
  单一布局契约 `workspaceGitRepositoryPath()` / `internalRootFromArtifactObjectRoot()`，
  不再用 `existsSync` 猜目录（新增 `tests/delivery/git-artifact-reader-layout.test.ts`）。

### 文档一致性（复盘 §7.3）

- 已移除/改写失效引用：`docs/README.md`、收敛实施计划、ADR-0055 与 ADR 索引不再链接
  工作区中不存在的 audit report、contract design、reset implementation、B0.1 record；
  它们改为指向真实存在的实施方案、技术方案、复盘报告与证据 JSON，并明确"评审表未签字"。
- 已修正技术方案自身的三处不一致：P3 批次编号（P3-B Router / P3-C 权限 / P3-D 拆除）、
  用量缺失口径（`provider_unavailable` + NULL，不伪造 0/估算）、完成门禁顺序
  （receipt → dependency-ready → user-delivered）；P-4 标注为已由产品决策关闭。
- 仍未处理（**既有、与本次收敛无关**）：`docs/README.md` 与若干归档文档中的历史链接
  失效（ADR-0041/0049、pi-planner-tui、node-22、active-permission 等指向已移动文件），
  属于 Phase 6 文档清理，不在 B0.2 范围。

### 仍需登记到删除清单的兼容路径

- `session-kernel-runtime.applyTaskPlan` 的 legacy owner 派生分支（第一轮 F5）：只服务
  持久化 pre-admission 决策重放，Phase 3/6 删除清单必须包含它。
- `publication_accepted_*`、`workspace_publications` 读取路径：Phase 3/6 删除，
  B0.2 只停止新写入。
- 技术方案 §3.3 与 ADR-0050 关于"未声明文件"的措辞冲突：需要一次 ADR-0050 修订，
  当前实现以单一 effect 规则为准。

## 7. 目标能力交付状态（Phase 0 仍未关闭）

B0.2 只证明"现有系统没有基线红测"，不证明产品收敛。复盘报告 §5/§6 的目标矩阵仍未交付：
Kernel 决策链、vendored Pi、Codex 执行路径、模型金额账单、TUI 入口、Docker 执行后端、
旧库迁移链、Server 固定 loopback 都还在生产路径；Router 直派、Manager 权限判断、
Manager 最终汇总、Token 额度与用量页面、客户端能力对齐、fresh schema 均未实现。
因此：

- Phase 0 的"基线无未分类红测"条件已满足，但 Phase 0 整体仍开放（审计/契约评审未签字、
  目标能力未交付）。
- Phase 3 删除工作、Phase 6 的 Docker/Windows/迁移清理、fresh schema 落地均不得开始。
- 复盘报告与证据 JSON 保留为当前事实基线；本记录不覆盖、不改写它们。

## 8. 回滚点与后续

- 生产修复按文件可独立回滚：`subtask-attempt-runner.ts`、`kernel-execution-runtime.ts`、
  `planning-agent-plan-{schema,validator}.ts`、`workspace-execution-decision.ts`、
  `session-kernel-runtime.ts`、`recovery-replanner.ts`、`generation-replan-worker.ts`、
  `server-composition.ts`、`git-artifact-reader.ts`。
- 第二轮的全部修复同样按文件回滚：`workspace-effect.ts`、`control-kernel.ts`、
  `subtask-attempt-runner.ts`、`executor-attempt-runtime-repo.ts`、
  `kernel-execution-runtime.ts`、`workspace-path.ts`、`workspace-execution-decision.ts`、
  `workspace-git-service.ts`、`git-artifact-reader.ts` 及各测试文件。
- 关闭 14 项红测不依赖 Phase 2/3 的 Pi、Router、权限或 Kernel 删除批次。
- Phase 0 整体仍未关闭（见 §7），因此：Phase 3 删除工作、Docker/Windows 资产清理、
  fresh schema 落地均不得开始。
