# 同一会话历史信息跨任务复用修复方案

- 状态：用户已批准；源码修复及本地验证完成；2026-10-13 已按用户要求更新本机 Desktop/Server，真实三轮验收已完成：历史引用通过，文件执行失败，发现独立的无工具执行却认证完成问题。
- 日期：2026-10-13。
- 优先级：执行可靠性整改 P0，先独立修复本次 `interaction_not_authorized`。
- 源码完成日期：2026-10-13；收尾提交：尚未创建，改动保留在工作区。
- 已完成代码、回归测试、构建及事故数据库隔离副本验证；后续按用户明确授权，通过正式 updater 将生产数据库备份并升级到 schema 48。未恢复或执行远程桌面任务。

## 本机更新与验收进展（2026-10-13）

用户后续明确要求“直接更新一下，做个测试”。已完成：

- 本机 Desktop、Runtime、Planner 同步更新到 `0.1.14-internal-evidence-fix-20261013`，后台已就绪。
- 使用当前信任的内部签名密钥生成开发版本；Runtime/Planner 正式归档、Desktop 依赖与载荷签名校验、macOS 应用签名校验均通过。产物留在 `.tmp/evidence-fix-20261013/`，没有对外发布。
- 通过 `SourceNativeUpdater` 备份并迁移 schema 47→48；升级 ID 为 `update-0.1.14-internal-evidence-fix-20261013-243c031e-bd87-4440-8e6c-05bfa7c933a1`。旧应用保留于 `~/.metawork/upgrades/evidence-fix-20261013-previous/MetaWork.app`。
- 原远程桌面任务仍为 blocked；更新前后 execution receipt 的 SHA-256 一致，未发生新的执行。
- 在独立工作区 `~/metawork-verification/evidence-fix-20261013` 新建测试对话，通过真实 Gateway 提交任务。
- 首轮请求在进入 Planner/Executor 前被 `official_authorization_required` 拒绝。用户完成重新登录及权益刷新后，同一测试对话的三轮请求均正常进入 Planner/Executor，未绕过登录门禁。
- 安装版本验证通过：Desktop 载荷签名、Server ready、生产数据库 `integrity_check` / `foreign_key_check`、复合主键均正常，旧 schema 47 备份可读。

### 真实三轮验收结果

测试 Conversation：`conv_hNDVis4qP1Ym`；源用户 interaction：`int_UDIdUuxImy`。
测试只使用合成编号 `MW-EVIDENCE-20261013-314159`，没有远程连接动作。

| 检查 | 结果 |
| --- | --- |
| B、C 各自持久化同一源消息的证据关联 | 通过，两条独立 `(task_id,id)` 记录，互不覆盖 |
| B、C 工作图选取源消息，Executor 实际取得编号 | 通过，两者输出均正确识别历史编号，无 `interaction_not_authorized` |
| 生成 `seed.txt`、`second.txt`、`third.txt` | 失败，用户工作区与每个 attempt 的工作区均不存在相应文件 |
| 执行工具轨迹 | 三次 Pi 原始流均没有 `tool_execution_start/end`，工作区 delta 均为空 |
| 系统完成状态 | 三个 Task 均为 done，receipt 均为 completed；与实际产物不符 |
| 原远程桌面任务 | 仍为 blocked，receipt 摘要与升级前一致，没有新执行 |

本次实际路由为“工程师”/Pi CLI，配置绑定 `Code CLI Anthropic` / `claude-sonnet-5`；这是配置名称，不证明上游真实模型身份。已证明实际执行没有发生以及完成判断误报；尚不能仅据此断言是供应商、协议还是工具配置导致无调用。

结论：历史信息跨任务引用 Bug 已在安装版本真实执行链上通过验收；包含真实文件交付的总体 smoke 未通过。其失败与先前已知的“文字宣称执行、无事实却认证完成”一致，继续由[任务执行可靠性统一方案](2026-10-15-task-execution-reliability-unified-plan.md)跟踪，不以该补丁已部署替代整体执行验收。

本地证据：`.tmp/evidence-fix-20261013/smoke-result.json`、`execution-check.json`、`installed-verification.json` 及合成测试原始事件记录。未将生产凭据、真实远程桌面内容或数据库提交仓库。

## 实施与验证记录（2026-10-13）

已交付：schema 48 复合主键及事务迁移；任务范围 upsert 与身份冲突保护；
准入/物化共用历史消息资格检查；上下文准备按已选引用补齐关联；准备阶段
失败码与统一提示。既有 Work Graph 恢复入口不变，由上下文构建器补齐资料，
Kernel 保持唯一恢复决策权。旧 evidence ID 和 receipt 不改写。

验证结果：

- 修复前新增的 10 项测试全部失败，复现后续任务关联丢失、历史引用误拒绝和共享资源内容覆盖。
- storage 全域与相关 execution/session/Docker 契约测试：49 个文件、295 项通过。
- 安装/升级全域与新增 Work Graph 恢复集成测试：39 个文件、241 项通过；两批去重后共 87 个文件、526 项。
- `npm run lint`、`npm run build`、`git diff --check` 通过。
- 迁移验证包括旧记录及 ID 保留、外键/索引、重复打开、版本提交失败后的整笔回滚，以及安装器克隆升级和原库/备份不变。
- 事故数据库以只读方式在线备份到权限受限的临时目录，在副本上完成 47→48 升级，并用真实已选 interaction 验证阻塞任务可重复准备历史消息。迁移前后旧证据一致，执行 receipt 未改变。只验证本次故障的 interaction 输入，不启动 Harness，不触发附件处理、模型请求或远程连接；临时副本和临时测试文件均已删除。
- 合成集成测试覆盖 A 保存编号、B/C 授权图复用、C 缺失关联、图恢复和重复准备，外加真正越界/缺失消息在 Harness 调用前失败。此验证不等同于模型驱动的真实用户流程 smoke。

首次源码交付时的边界（后续安装进展见上节）：

- 本地构建产物已生成；没有生成或发布签名安装包，没有切换本机正在运行的 release，也没有恢复现有阻塞任务。
- Docker CLI 在本机不可用，已更新 schema 48 数据卷并通过 Docker 静态契约测试，未运行容器。
- 模型驱动的三轮用户流程、真实并发进程压力及安装版本切换后的验收仍待进行，不据此声称已完成上线验证。
- 安装应沿用既有 updater 的备份/候选数据库升级流程，先备份 schema 47、再验证 schema 48 候选库。回滚必须恢复配套的旧 release 与旧数据库备份，不能让旧二进制直接打开 schema 48。

## 1. 用户可见目标

用户在同一会话已经提供的信息，后续“继续排查”“按刚才的信息做”等任务应能按需复用，不因系统拆成了新 Task 就要求用户重发信息或重新授权。

账户内的信息属于用户。一次 Executor 所需的输入由 Planner 选取并交给已授权任务；共享信息不要求给每个 Executor 注入整个账户的全部历史。当前事件涉及同一 Account、同一 Conversation 的明确历史引用，本来就应工作，是实现缺陷。

本补丁修复这种合法引用及相关证据归属问题。跨 Conversation 的账户级检索/引用体验遵循现有入口和契约，不通过删除全部校验来隐式扩展；若后续需要统一扩展该能力，应单独定义产品范围。

## 2. 已确认根因

本机 Conversation `conv_GNkoCi_9r0-U` 的任务 C（ID 后缀 `b983d`）引用历史消息 `int_ebi_v5pPy2`。该消息已经被任务 B（后缀 `c0508`）引用过。

现实现有三处相互作用：

1. `createEvidenceId(kind, sourceId)` 不包含目标任务；两个任务生成相同 evidence ID。
2. `task_execution_evidence` 以 `id` 为唯一主键。`ON CONFLICT(id)` 只更新 title/content，证据的 `task_id` 仍是任务 B。
3. 任务 C 按自身 task ID 读取证据为空，回退读取原始 interaction 时又要求原始消息的 task ID 等于任务 C，因此抛出授权错误。

数据库已确认：源消息存在且属于当前会话；对应 evidence 仅归属任务 B；任务 C 没有这条关联。内存 SQLite 复现确认冲突行为。本次 attempt 原始执行输出为零，失败在组装上下文阶段，尚未调用 Pi 执行业务任务。

另一个需要同步收敛的不一致：新建任务准入允许同会话历史 interaction；`isEligibleInteractionRef` 在已有 targetTask 时却附加源任务必须相同的条件。若只改证据主键，继续任务/恢复仍可能在另一入口被拒绝。

## 3. 推荐实现：每个任务有独立引用关系

### 3.1 使用任务范围的证据主键

推荐将表主键从 `PRIMARY KEY(id)` 改为 `PRIMARY KEY(task_id, id)`，保留现有 evidenceId 字符串和 ContextRef 引用格式。

同一来源引用结果应为：

| 目标任务 | evidence ID | 来源 |
| --- | --- | --- |
| 任务 B | evidence_user_interaction_int_ebi_v5pPy2 | 同一条历史消息 |
| 任务 C | evidence_user_interaction_int_ebi_v5pPy2 | 同一条历史消息 |

对应 upsert 冲突目标改为 `(task_id, id)`。再次准备同一任务输入是幂等操作；准备另一个任务输入则新增独立记录。不得通过更新已有行的 task_id 转移证据，或删除旧任务的引用。

仓储读写统一携带 taskId，审计所有仅凭 evidenceId 的查询。现有 list/get 继续受 attempt 的 task scope 约束。保留 assistant 引用的 exact-only 语义，不能因此把所有旧回答变为可任意搜索的证据。

增加身份一致性检查：同一 `(task_id,id)` 若对应不同 kind/sourceId/exact-only 身份，报告明确冲突，不静默覆盖。现有 ID 截断格式不在本补丁中重命名，避免改写历史引用；身份冲突必须可发现。

### 3.2 统一历史消息引用规则

准入、初次物化、执行上下文准备、恢复使用一致的规则：

- 根据可信的账户数据库、目标 Task 的 Conversation 及受控 session 映射验证来源。
- 消息真实存在，属于允许引用的当前会话；assistant 侧必须具有可用内容。
- 当前已授权工作图明确选中了该 interaction 和 side；不能通过猜测 ID 读任意来源。
- 不要求源消息的 task_id 等于目标 Task。新建、继续、replan、retry 对相同合法来源应保持一致。

在既有 Work Graph/Execution seam 内共用身份与资格判断，数据查询走现有适配层；Kernel 继续仅接收验证过的引用资格，不读取原始消息。

上下文准备发现物化缺失时，调用同一幂等物化逻辑修复合法引用，再按目标任务读取。仅处理该已授权子任务列出的引用，不扫描账户历史。对真实的缺失、会话不匹配或未授权引用，保留明确错误。

## 4. 数据升级及已阻塞任务

当前源码 schema 为 47，实施时以实际版本分配下一迁移（当前预计 48）。在正式迁移路径中事务性重建证据表，保留全部已有行及原 task 归属、内容、时间、exact-only 和来源，重建所需索引及外键，核查行数和完整性。

修改新建数据库 schema、升级路径、Repository 与 Docker 测试，不能只在本机手工 ALTER。更新/回滚沿用现有安装器备份与恢复机制，迁移失败不切换可用版本。

已有任务缺失的关联不能仅靠搬旧表补齐。通过更新后的普通上下文准备路径，对持久化的已授权 ContextRef 做幂等物化。因此：

1. 任务 B 的旧证据仍可读取。
2. 任务 C 的引用资格重新核验通过后，可以创建自己的关联。
3. 重启、恢复或重复准备不会再次丢失关联。

迁移不自动恢复 blocked Task、不修改历史 attempt receipt、不把任务直接标完成。对本次生产任务，先用一致性快照/隔离副本验证上下文能完整构建，使用 mock Executor 边界，禁止发起模型调用或远程连接。真正恢复原始业务执行属于后续操作，不在当前方案审阅或诊断范围内。

## 5. 让错误说明准确

将上下文错误按来源不存在、引用范围不匹配、物化身份冲突等稳定原因分类，保留阶段 `context preparation` 和“尚未调用 Harness”事实。

Adapter/Runtime 上报事实，Kernel 使用既有失败和恢复政策；不能由 Runtime 私自重试业务操作。未发生外部副作用可作为既有恢复判断的输入，不把所有同类错误统一视为可重试。

产品通过统一 TaskView/错误投影呈现“准备任务资料失败”，而不是暗示 macOS/Windows 拒绝访问。准备阶段不应声称 Pi 已开始执行。不给用户展示口令或原始消息正文。

## 6. 改动范围及所有权

| 位置 | 改动 |
| --- | --- |
| `src/storage/migrations.ts` 与迁移测试 | 复合主键、新建/升级一致、索引/外键和事务验证 |
| `src/execution/execution-evidence-port.ts` | 任务范围 upsert、身份一致性检查、物化及读取契约 |
| `src/execution/work-graph-runtime-service.ts` | 继续沿用同一个物化入口，处理初次与恢复的输入准备 |
| `src/execution/subtask-execution-context.ts` | 按任务读取及幂等补齐已授权引用，去掉错误的同源 Task 假设 |
| `src/work-graph/context-ref-eligibility.ts` | 对新任务和已有任务使用一致的同会话引用规则 |
| Execution failure / Kernel 现有入口 | 归一化准备阶段失败；Kernel 保持唯一恢复决策权 |
| TaskView / Gateway / 客户端公共展示 | 显示真实失败阶段，不增加独立状态机 |

遵守 ADR-0020/0031/0038。实施时补充 ADR-0038 的 interaction 跨任务复用及一致性规则，明确同会话源任务不必相同；同步 CONTEXT、技术总览与持久化说明。公开 ContextRef 和 evidenceId 文本格式不变，数据库记录身份改为任务范围，不增加兼容双写器或全局历史访问旁路。

## 7. 必须通过的验收

1. **精确复现本次事故**：任务 A 保存消息，B、C 先后引用同一消息；两者上下文都包含正确内容，B 的关联不被 C 覆盖。
2. **重复与并行**：B/C 准备顺序互换、重试、并发、重启后恢复，结果一致。
3. **新建与继续一致**：新 Task、已有 Task 的合法历史引用均可通过准入并实际读取。
4. **旧库升级**：保留仅有 B 关联的旧库样本，升级后 C 能按授权引用补齐；旧 evidenceId、B 的记录和历史 receipt 不改变。
5. **同类证据**：多个任务复用相同偏好/合法任务资源时不串归属；assistant 精确引用保持现有访问规则。
6. **错误边界**：不存在消息、其他账户或不符合当前会话契约的引用、未在授权图中选取的引用得到准确拒绝；不能把真实越界变为允许。
7. **原子性与身份冲突**：失败迁移可回滚；同主键不同来源不覆盖；准备失败时 Harness 调用次数为零。
8. **真实用户流程 smoke**：使用合成信息，“记住测试编号”→“按这个编号生成文本”→“继续使用刚才编号生成另一个文件”；独立检查两个产物内容。最后一项待实施阶段执行，不使用真实远程连接信息。

集中测试覆盖 evidence repo、context builder、work-graph runtime、eligibility、migrations 和相应 Docker 场景；运行 lint/build。用脱敏 fixture 或受限隔离副本验证本次已阻塞任务，不将含凭据的数据库或消息提交到仓库。

## 8. 分步交付及退出条件

1. 先新增能重现 B/C 共享消息失败的回归测试，确认修复前失败。
2. 一起实现 schema、仓储和准入/物化/读取规则，验证升级与恢复。
3. 补齐错误阶段投影，完成合成用户流程和安装升级验收。
4. 准备修复版本与回滚材料，记录版本、测试结果、未完成项和收尾提交。

关闭标准：连续追问无需重发原信息；多个 Task 均能读取已选择的同会话历史输入；已有阻塞记录经正常输入准备可恢复关联；没有任务间覆盖和权限误拒绝。修复成功不代表此前工具调用或错误完成认证问题同时解决，它们继续由总体执行可靠性方案跟踪。
