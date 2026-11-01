# Conversation Turn 正文单一权威源技术方案

**Status:** Implemented — scoped validation passed; full-repository regression failures remain
**Plan date:** 2026-11-01
**Scope:** 收敛用户输入与最终回答的正文存储、读取、投影、Planner/Executor 消费、Memory 沉淀、迁移和删除语义。
**Related authority:** [ADR-0020](../adr/0020-core-module-ownership-and-dependency-direction.md)、[ADR-0015](../adr/0015-planner-owned-semantics-and-tool-mediated-context.md)、[ADR-0031](../adr/0031-account-runtime-and-unified-client-gateway.md)、[ADR-0043](../adr/0043-explicit-conversation-observation-and-client-read-models.md)、[ADR-0049](../adr/0049-long-term-memory-ownership-deposition-and-delivery.md)。
**Implementation date:** 2026-11-02。
**Implementation status:** schema 64、正文 Store、Gateway/outbox、历史与搜索、执行引用、Memory 分段幂等、迁移及删除工作流已落地。专项单元测试与隔离端到端冒烟通过；全仓回归仍有失败，详见 §14.3。架构裁决见 ADR-0054。
**Closing commit:** `feat: unify conversation content authority and layered memory`；2026-11-02 按用户指令提交并推送 main，随后构建并激活本机版本。

## 1. 决策摘要

MetaWork 为每个 Conversation Turn 建立一个逻辑上的 `ConversationTurnStore`，作为用户原始输入和最终回答正文的唯一权威源。它由账户 SQLite 数据库中的 Turn 元数据、内容寻址正文和回答版本组成，位于现有 SQLite history 与 content body 能力之上演进。

Planner JSONL 保留为 Pi 恢复对话上下文、工具调用和运行过程所需的非权威副本。它不再定义用户看到的历史正文，不作为 Memory 沉淀正文来源，也不决定会话删除后的正文是否仍然存在。

读模型、FTS、标题、轨迹预览和 Memory L0 均属于可重建或可重投的下游投影/副本。它们只保存 Turn 身份和正文引用，或保存受限预览；任何投影都不得反向覆盖权威正文。Task、Subtask、Attempt 和 ResultObject 继续由各自现有权威存储管理，本方案不改变其状态所有权。

核心规则：

1. 一个被系统接受的用户 Turn，先持久化原始输入正文，再进入 Planner。
2. 最终回答经统一接口写回同一个 Turn，并保留回答版本和来源 Task。
3. 所有消费者通过 `turn_id` 和正文 hash 读取完整正文；预览永远不是回退真源。
4. 任何为执行或搜索而生成的不同文本，必须标记为派生内容及来源，不能冒充用户原话。
5. 删除 Conversation 时，清除正文权威源、派生索引和可定位的运行副本；外部 Memory 清理必须有可验证的会话级删除能力。

## 2. 当前问题

当前一轮对话正文分布在 Planner JSONL、canonical/presentation history、Conversation read model、content bodies/chunks、FTS、Gateway journal、interactions、Task evidence、Kernel decision、Planner proposal、TDAI L0 和 ResultObject 等多个位置。部分是正常投影，部分是并列写入；输入口径、截断长度和写入时机并不统一。

由此产生的问题包括：

- 同一个 Turn 在实时视图、翻历史、Executor 上下文和 Memory 沉淀中可能显示或消费不同文本。
- 4KB 预览可能被误当完整输入/回答，导致 Memory 与搜索永久看不到尾部内容。
- Kernel request、Planner prompt 或 Executor 派生指令可能被错误记录成用户原始输入。
- Direct Reply 与 Task 结果投递采用不同写入链，部分 Turn 只在某些视图中出现。
- 归档、删除、重建和重试没有覆盖所有副本的统一语义。

重复本身不是错误。为分页、检索、Planner 进程恢复或外部 Memory 而保留副本可以接受；前提是每个副本都清楚标明来源、可重建/可清理，不得成为第二个正文权威源。

## 3. 权威边界

| 数据 | 唯一权威源 | 允许的下游副本 | 明确禁止 |
| --- | --- | --- | --- |
| 用户原始输入正文 | `ConversationTurnStore` 的 input body | Planner JSONL 运行上下文、Gateway/客户端有界预览、FTS、Memory L0 投递副本 | 从 Task prompt、Kernel request 或截断预览反推原始输入 |
| 最终回答正文 | `ConversationTurnStore` 的 answer body revision | Planner JSONL、客户端预览、FTS、Memory L0、ResultObject 引用 | presentation/read model 或 ResultObject 反向覆盖正文 |
| Turn 身份与顺序 | `ConversationTurnStore` | journal、读模型和 Task 关联表中的 ID/hash | 用 Planner session 顺序或 Task 创建顺序替代 Turn 身份 |
| Task/执行状态 | 现有 Task/Attempt 状态权威 | Conversation 展示投影 | 让 Turn 正文表取代 Task 状态机 |
| 执行指令/改写文本 | 对应执行记录及来源关系 | Executor 运行上下文 | 将派生指令标成用户原话 |
| L1/L2/L3 记忆资产 | TDAI（ADR-0049） | MetaWork 绑定与召回快照 | 把 TDAI L0 副本当作 Conversation 正文来源 |

SQLite 内的多张规范化表仍是一个逻辑真源：Turn 表定义正文归属与引用，body 表保存不可变字节，answer revision 表定义哪个回答版本属于该 Turn。跨表写入必须在同一数据库事务中完成。

## 4. 存储模型

### 4.1 `conversation_turns`

每条记录代表一个被接受的用户 Turn，至少包含：

- `account_id`、`conversation_id`、稳定的 `turn_id`；
- Conversation 内单调递增的 `sequence`；
- `user_input_hash`，引用完整用户输入正文；
- 当前 `final_answer_revision`，没有最终回答时为空；
- 接收时间、创建版本和必要的来源元数据。

主键为 `(account_id, conversation_id, turn_id)`，序号在 Conversation 内唯一。Turn ID 由 Gateway 在受理用户请求时生成；重试沿用相同 ID。输入正文不可由后续 Planner/Executor 文本替换。

本表不拥有 Task 的运行状态。对话中的 queued/running/blocked/completed 等状态仍由现有 Task/Turn runtime facts 投影，避免再造一套状态真源。

### 4.2 `conversation_turn_bodies`

按账户内 SHA-256 寻址的不可变正文表：

- 主键 `(account_id, body_hash)`；
- 保存 UTF-8 正文、精确 byte length、正文格式和创建时间；
- hash 对原始 UTF-8 字节计算，不做 Unicode、空白或换行归一化；
- 写入已存在 hash 时必须校验长度与正文一致，不一致视为完整性错误。

用户输入和回答都引用该表。重复正文可在账户范围去重；正文内容不复制到 Turn header。大正文由读取 API 分段返回，分段是传输方式，不形成第二份持久正文。

### 4.3 `conversation_turn_answers`

答案以追加版本保存，字段至少包括 `account_id`、`conversation_id`、`turn_id`、`revision`、`body_hash`、`source_task_id`（Direct Reply 可为空）、`created_at`。Turn header 指向当前有效 revision。相同 Turn/revision/hash 的重试幂等；同 revision 不同 hash 必须报冲突，不得静默覆盖。

新回答版本不删除旧版本，直到 Conversation 删除或按明确保留策略清理。客户端默认读取当前 revision；审计/恢复接口可按 revision 查询。

### 4.4 现有表迁移定位

实现时将现有 `conversation_history_turns` 的 conversation 内容和 content body 能力迁移为以上权威 Store。现有 `presentation` 内容、`conversation_read_turns`、chunks/manifests 等在迁移完成后属于投影实现，不继续拥有正文。

权威 body 必须与 `epoch`、读模型重建周期、单个 Conversation 当前 head 解耦。重建 read model 时不得删除仍被 Turn/Answer 引用的 body。旧表可在回填和回滚窗口内只读保留；切换后禁止旧 writer 继续写正文。

## 5. 写入流程与事务规则

### 5.1 接收用户输入

1. Gateway 完成身份、Account、Conversation 和输入校验，分配或确认幂等 `turn_id`。
2. 同一 SQLite 事务写入 body、Turn header 和 `turn_started` outbox 事实；若该 Turn 已存在且 hash 相同，返回原记录；hash 不同则拒绝为冲突。
3. 事务提交后才启动 Planner。若 Planner 启动失败，原始输入仍然存在，并能与失败/Task facts 关联。
4. 附件仍通过既有附件资源身份引用，不将附件二进制塞进正文。用户输入文本与附件引用均关联同一 `turn_id`。

### 5.2 写入最终回答

Task 交付、Kernel Direct Reply 和其他对用户可见的最终回答都调用同一个 `appendFinalAnswer()` 接口。接口在一个事务中写入 body、answer revision、当前 revision 指针和 `final_answer` outbox 事实。交付重试按 Turn、revision、hash 幂等。

答案正文的完成事实由回答写入提交确定；Task 是否成功、失败或取消仍按现有 Task 状态权威判断。回答存在不自动把 Task 标为 succeeded，Task succeeded 也不允许投影层自行补造正文。

### 5.3 事件与外部副作用

SQLite 事务只负责 Turn Store 与其 outbox。Gateway journal、TDAI 和其他跨进程消费者由 outbox publisher 幂等投递；失败可重试，不回滚已接受的 Turn，也不重复创建 Turn。Journal 只记录 `turn_id`、hash、长度和事件时间，不保存用户输入/回答全文或内容预览。

## 6. 读取与投影

- 会话历史读取以 `ConversationTurnStore` 为内容来源，按 sequence 分页；页面可先加载摘要，再按 body hash 拉取完整正文。
- `conversation_read_turns` 保存 turn 身份、顺序、Task/轨迹关联、预览、hash、长度和投影 revision。它不保存可作为完整历史回退源的正文副本。
- 轨迹、标题、活动摘要和 FTS 从 Store 与其各自权威的 Task/journal 事实派生；投影可删除后重建。
- FTS 可在索引中保存分词文本，但必须有来源 hash、可整会话重建；删除 Turn 或正文后同步清理索引。
- read model rebuild 只能读取 Store 和其他领域权威源，不能以 Planner JSONL、presentation history 或旧预览修正 Store。
- 投影落后时返回 freshness/checkpoint 状态并后台追平。不得为了修投影而将不同副本中的文本静默择一覆盖。

所有全文消费者都必须经过按 hash 校验的 `readBody(accountId, hash)`；返回值包含正文、byte length 与 hash。找不到正文或 hash 校验失败时返回明确的 `body_unavailable`/完整性错误，不允许回退到 preview、Task prompt 或其他副本。

## 7. Planner 与 Executor

Planner JSONL 保留，因为 Pi 需要工具调用、运行事件和恢复上下文。它是运行时 transcript，不是真实会话历史的权威存储：

- MetaWork 为每个 Planner user turn 维护 `conversation_id`、`turn_id`、`input_hash` 映射；继续使用 `planner_turn_inputs` 时，其权威用途仅为幂等与关联。
- Planner JSONL 中同一条用户消息应能追溯到稳定 Turn ID/hash。JSONL 与 Store 不一致时，UI、Memory、搜索和删除均以 Store 为准，并记录 transcript integrity diagnostic。
- Planner 进程重启可以使用 JSONL 恢复工具上下文；若需展示用户历史正文，必须向 Turn Store 读取。
- 清理 Conversation 时必须删除或按已有隔离规则清除对应 Planner session 文件；不能因为 JSONL 仍保留正文而声称会话已删除。

Executor 收到与用户原话相同的正文时，通过 Turn 引用物化。Planner 改写后的 Task prompt、子任务 goal、命令或脚本是独立的派生执行对象，必须带 `derived_from_turn_id`、Task/Attempt 身份和自身 hash。它们可以作为执行审计/恢复材料保留，但不得进入会话历史或 Memory 时冒充原始 query。

`interactions`、`task_execution_evidence`、`planner_proposal_turns` 和 Kernel ledger 中的用户输入字段，改为保存 Turn ID/hash 引用。确属执行所需的改写文本以明确类型保存为派生对象；不得继续以 `user_input` 的名义无关联地复制一份正文。

## 8. Memory 集成

TDAI 继续是 L1/L2/L3 抽取、管理和召回的权威引擎（ADR-0049）。TDAI L0 接收的是 Turn Store 正文的下游投递副本，绝不反向成为 MetaWork 的历史真源。

- Memory deposition 按 `conversation_id + turn_id + input_hash + answer_hash` 构造幂等键，从 Turn Store 读取完整输入和当前最终回答。
- 不从 `conversation_read_turns` 的 preview 或 4KB `body_json` 读取正文；长度超出 TDAI 单次接口限制时，调用明确的分段/批量沉淀协议，不能静默截断后推进 cursor。
- 只有 Store 中具有最终回答且符合 ADR-0049 完成语义的 Turn 才进入 L0。失败、取消、未完成 Turn 不沉淀。
- 只有 TDAI 确认整批成功后才推进 memory deposition cursor；缺失正文、hash 不符、部分失败均保留待重试状态并产生可诊断记录。
- Recall 仍来自 TDAI；它不能用 L0 回答覆盖 Turn Store。

## 9. 归档、删除与保留

归档是目录元数据，不删除 Turn Store。删除 Conversation 是覆盖正文真源及其衍生数据的显式工作流：

1. 持久化删除 tombstone，拒绝新的正文写入和 Memory deposition。
2. 删除该 Conversation 的 Turn/Answer 关系和读模型、FTS、搜索索引、交互/evidence 中的内容投影；按引用计数或全库引用检查回收无其他 Turn 引用的 body。
3. 删除 Conversation 对应的 Planner JSONL/session 及可清理的 task/query 副本。Task、审计、账单等必须保留的非正文事实仅保留不含用户正文的身份与状态信息。
4. 通过 outbox 请求 TDAI 删除该会话的 L0 输入。只有外部删除确认后，删除流程才能报告“完整完成”；此前状态为 `deletion_pending` 并可重试。
5. 删除后重建任意 read model，不得从 journal、Planner transcript、旧 history 或 Memory 重新复活正文。

TDAI 在实施前必须验证并补齐按 Conversation/L0 session 的删除 API、幂等性和可查询确认。若该能力不可实现，不得宣称“删除会话即删除所有记忆副本”；Memory deposition 必须暂时禁用会话级删除承诺，直到外部契约满足。

SQLite WAL、诊断包及备份中的物理擦除和保留周期另按隐私/备份策略定义；应用级删除完成不得被描述为备份介质的即时物理销毁。

## 10. 存量数据迁移

迁移必须可重入、可审计、先 dry-run 后 cutover，且不以“哪个副本最近写入”决定真源。

1. 生成每个 legacy Turn 的候选来源清单，使用 `account/conversation/turn_id` 对齐并读取完整 body refs。
2. 用户输入只接受能证明属于原始 Gateway Turn 的正文：优先匹配带来源身份和 hash 的完整 body ref；其次接受带同一 turn 身份且原始输入 hash 一致的 Planner proposal 输入；最后接受有明确原始输入标记且可校验的 canonical history。Kernel request、Task prompt、Executor instruction 和预览不得作为原始 query 候选。
3. 最终回答按完整 answer body ref 与 `final_answer` 来源校验；缺失时才使用有明确来源的 canonical answer。摘要、Task prompt 和结果说明不得替代最终回答。
4. 每条字段分类为 `exact_match`、`recoverable_single_source`、`conflict` 或 `missing`，记录候选来源、hash、长度及决策。冲突不自动择新/择旧，不静默覆盖；不能唯一证明的字段标记 unresolved 并保留原始候选供修复。
5. 校验迁移前后 Turn 数、输入/回答 hash、UTF-8 byte length、sequence、Task 关联和已知 Direct Reply 覆盖率。未通过时禁止切换读取路径。
6. 启用唯一 writer 后，旧正文 writer 停止写入；读路径逐步切到 Store，观察期内只做 hash 对账，不双写正文。
7. 验证通过后从 `cutoverAt` 开始保留 **7 天**回滚窗口；重复迁移不延长窗口。期满再次验证 Turn 引用、输入 hash 和历史答案 hash，清除 rolling records/presentation 文件副本及已由 Store 接管的 bodies/chunks/manifests，记录 `retiredAt`。有 unresolved/conflict 的会话不执行自动回收；保留来源 hash、长度与分类诊断。

迁移必须覆盖普通 Task 交付、Direct Reply、重试、失败/取消、长输入/长回答、附件 Turn、历史重建和已经缺少 planner session 的 Conversation。

## 11. 分阶段实施

### Phase 0：架构裁决与接口冻结

批准本方案，新增/修订 ADR，明确 Turn 接收、答案 revision、删除、Memory L0 删除和正文 hash 契约。为所有现有 writer/reader 建立调用清单，确认不存在未登记的正文写入路径。

### Phase 1：权威 Store 与统一写入口

增加 schema/repository/API、hash 校验、唯一 `turn_id`、答案 revision、transactional outbox 和幂等测试。先将新 Turn 输入和所有最终回答路径接入 Store；未接入的旧路径不得继续独立写历史。

### Phase 2：迁移与历史读取切换

运行 dry-run 分类和数据对账，回填可证明的历史 Turn；冲突生成报告。Conversation history API 与 Web/TUI/Gateway reader 切到 Store/其投影，不再将 Planner JSONL 或 presentation history 当正文 fallback。

### Phase 3：执行、搜索和 Memory 引用化

将 interactions/evidence/planner proposal 改为 Turn 引用或显式派生对象；统一 FTS 从 Store 建索引；Memory 从完整 Store body 投递并保存逐 Turn idempotency/watermark。验证 TDAI 会话级删除后再开启完整删除闭环。

### Phase 4：清理旧副本写入与存储

观察 hash 对账和读流量后停用旧 canonical/presentation 正文 writer；回收旧正文副本和未引用 bodies；保留必要的运行 transcript 与可重建索引，并执行删除端到端验收。

## 12. 验收标准

- 每个被接受的 user query 在 Planner 启动前恰有一个权威 Turn input body；重复请求不产生重复 Turn。
- 普通 Task、Direct Reply、长任务最终交付和重试均写入同一个 Store；历史页、实时页和跨端读取的全文 hash 一致。
- 超过 4KB 的输入和回答完整显示；Memory 收到完整字节且不从 preview 截断；单层/批次失败不推进 cursor。
- Planner JSONL 与 canonical Store 故意构造不一致时，UI、Memory、搜索、导出与删除仍以 Store 为准。
- Kernel request/Task prompt/Executor 派生文案不会出现在“原始用户输入”字段；派生内容可追溯其 Turn/Task/Attempt 来源。
- Read model、FTS、标题和轨迹删除后可仅从权威源重建；重建不能改变输入/答案 hash。
- 删除 Conversation 后，历史 API、FTS、read model、Planner session 和 TDAI L0 均不可再取得正文；删除未完成时 API 明确返回 pending，而不报告成功。
- 存量迁移可重复运行、逐字段 hash 校验，冲突不静默丢弃或择源。
- Task、Subtask、Attempt、ResultObject、账单和 Memory 资产仍由各自已有权威边界管理。

## 13. 风险与实施门槛

- **历史数据无法证明原始输入：** 有些 legacy `userInput` 可能实际来自 Kernel request 或 Task prompt。迁移不能伪造精确度，必须保留 unresolved 分类和诊断。
- **Planner runtime 兼容：** Planner JSONL 仍承担进程恢复。Store 读取故障时，Planner 可以恢复运行上下文，但不能将 JSONL 内容回写成权威历史。
- **外部 Memory 删除：** 没有 TDAI L0 会话级删除接口时，完整删除能力无法验收；这是 Phase 3 开启删除保证的硬门槛。
- **正文访问与保留：** 原始正文成为唯一权威后，权限、备份、WAL、诊断包、加密和保留周期必须沿用并明确账户数据策略；内容 hash 不能被误当作加密。
- **领域边界：** 本方案改变 Conversation 内容真源和多个消费者引用方式，属于架构所有权变化；不得只改局部 Repository 而不更新 ADR、`CONTEXT.md` 和技术总览。

## 14. 实施记录

### 14.1 实现记录（2026-11-02）

- `conversation_turns / conversation_turn_bodies / conversation_turn_answers` 构成账户内权威 Store；原始 UTF-8、hash、长度、请求幂等、回答 revision 与 outbox 在事务内提交。相同回答的后台完成更新不新增 revision，也不允许旧重试把状态退回 running。
- Gateway 在 Planner 前受理正文。Direct Reply 与后台交付均在发送结果前提交答案。journal 只持久化正文引用；分块消息为实时传输。进程启动与每 5 秒维护负责重试 outbox。发布失败不丢弃已提交正文。
- canonical/presentation history 新 Turn 只存引用和展示元数据；records 文件不再滚动双写正文。历史读取按 Store 物化，Task 状态仍由 Task 事实映射。read model 与 FTS 重建不影响权威 bodies。
- 读模型以权威 Turn sequence 排序；projector version 2 会后台重建旧投影，重建期间保留当前可见 epoch。
- 请求登记、interactions、Executor evidence、Kernel request 与队列 requestText 使用带来源的内容引用；Planner proposal 保留 hash，`planner_transcript_turns` 保存 Planner session、Turn、权威 input hash 与实际 transcript hash 的关联。派生执行文本明确标为 `task_instruction`；同一 Turn、Task、Executor、正文引用的 interaction 重试只写一条。
- 已交付 ResultObject 的 hash 与答案一致时，新增引用关系并通过 Store 读取；无其他非引用 ResultObject 使用的旧文件可回收，ResultObject 身份/状态事实不变。
- Memory 从完整 Store 正文读取，外部边界仍执行既有 secret sanitizer。`conversation_memory_receipts` 记录 Turn/input hash/answer hash，支持乱序完成和答案修订；旧 sequence cursor 不再决定正文是否已经投递。`conversation_memory_attempts` 在 HTTP 前落盘，防止部分成功后关闭 Memory 导致误报外部清理完成。
- TDAI 补丁增加 `/v3/metawork/conversation/upsert` 与 `/delete`。每片最多 8192 Unicode code points、每请求最多 100 片；稳定 ID、整批 hash、分页暂存与成功凭据保证重试不新增 L0 记录。删除分批处理全部 L0，并使用遇错必报的查询确认，不能把后端错误当作空会话。
- 删除先落 tombstone；清理 Planner JSONL、执行 HOME/log、journal、正文/FTS、交互与执行副本、通知队列。Task、Attempt、ResultObject、计费的非正文身份/状态保留。正文不完整清理或外部未确认时返回 HTTP 202 / deletion_pending，启动及后台维护继续重试。已删除会话不能回写或重建正文。

### 14.2 迁移口径

迁移适配器提供只读 `review()` 与事务 `migrate()`，后台维护调用前先 review。每个字段的来源 hash/长度和分类记录在 `conversation_turn_migration`。

旧 Gateway 的 `userInputRef` 可能指向脱敏文本；仅凭该 ref 不足以证明原始 query。必须有原始 hash/来源标记，或能以账户、会话、requestId 对齐的 Gateway admission 原文。Planner/canonical 候选也必须具备稳定 Turn 关联与可核验 hash。无法证明的旧数据标记 `legacy_unresolved`，不送入 Memory、不提升为正文权威；保留原证据供修复。冲突不会按“最新副本”自动覆盖。

同一会话已有新 Turn 且旧 Turn 顺序无法直接追加时，报告 `offline_order_reconciliation_required`，不在后台静默重排。已验证迁移不发送新的用户通知；Task 原状态保留。旧正文证据不会在未经验证的情况下被自动删除。

### 14.3 验证记录（2026-11-02）

- `npm run build`、`npm run lint` 通过；前端构建仍提示现有大 chunk，不影响构建成功。
- 聚焦回归：38 个测试文件、454 项通过。覆盖 Store 原始 UTF-8/hash、事务回滚、revision/重试、投影乱序、全文与尾部搜索、迁移分类/回滚窗口、删除失败重试、隔离副本清理、恢复队列不重放已删除正文，以及 Memory 乱序完成、版本回执和空正文拒绝。
- 锁定版本真实 TDAI：从 `memory/engine.lock.json` 的上游 commit 创建隔离 checkout，验证兼容补丁可干净应用；在该源码上运行 6 文件、26 项端到端测试，全部通过。链路为 SQLite → Memory Port → 本地 HTTP sidecar → 持久 L0；抽取模型采用确定性测试服务。超过 100 个分片的 Unicode 正文逐字一致，重复投递行数及时间戳不变，整会话删除为零且拒绝复活；同时覆盖记忆抽取、召回、evidence 和设置启停。
- `npm run smoke:gateway` 通过：170 项 MetaWork 契约测试、126 项 Pi 客户端测试，加原生隔离安装的多客户端流程。实际进程完成 Workspace 创建/初始化、Conversation 创建、命令 Turn 完成、两个观察客户端答案 hash 一致，以及 Server 重启后目录恢复。脚本已使用 `followConversation`，并有界等待 Workspace 初始化。
- 最近一次全仓 `npm test`：599 文件通过、19 文件失败、20 文件跳过；4418 项通过、69 项失败、39 项跳过。随后补充的 queued Task/空正文边界由专项回归覆盖。**不能宣称全仓全绿。**
- 本机无 Docker 可执行文件，未运行容器测试。Docker shell 数据卷版本已同步 schema 64，旧版本 SQLite 迁移夹具同步适配新增 view。

全仓剩余失败的实际表现：

| 范围 | 观察到的失败 | 验证结论 |
| --- | --- | --- |
| Kernel、Workspace 执行/恢复、文件交付、Session | `no Workspace is bound`、旧 in-place/publication/接受流程断言，以及 Executor 返回后 Task 未完成 | 涉及 `control-kernel`、`account-startup-recovery-service`、`declared-file-delivery`、`independent-branch-failure`、`planner-owned-workspace-mode`、`publication-delivery-recovery`、`span-recovery`、`task-result-service-acceptance`、`task-state-recovery-journeys`、`blocked-task-user-journey`、`kernel-retry-control-loop`、`planning-agent-session-routing`、`planning-kernel-path`、`scripted-session`。本轮没有为通过这些测试回改既定 Workspace/Kernel 行为，也没有把所有失败都认定为“仅测试过时”。 |
| 导航与图片端到端 | `navigation-performance` 预期 404、实际 200；`web-image-planner-flow` 使用旧 submit 参数，触发 `text.startsWith is not a function` | 与本轮成功的原生多客户端冒烟分开列示，尚未修复这些用例。 |
| 发布与静态契约 | `task8-cross-repository-contract` 的 Planner schema hash 不符；缺少 `docs/releases/v0.1.20.md`；`conversation-view` 断言旧前端源码位置 | 未据此更改产品版本、发布文件或历史契约快照。 |

本轮引入的新 view 对旧版本迁移夹具的影响、Kernel 仓储测试的精简 schema 缺表、legacy history 被允许覆盖正文的旧断言，均已修复并通过相关回归。剩余 19 个失败文件不计入本方案专项通过数字。

### 14.4 交付边界

本方案代码及专项验证于 **2026-11-02** 完成；全仓验证未全部通过，记录如上。专项验收时未部署、未操作真实用户数据库。2026-11-02 用户随后授权提交 GitHub、重新构建并重启；部署沿用原生安装升级流程和数据库备份/迁移机制。

删除是应用数据的删除流程：关闭对应空闲 Session/Planner 进程，清理已登记的 transcript、执行 HOME/log、旧 admission 文件、records/presentation 与隔离副本；SQL 清理保留 Task/Attempt/ResultObject/计费身份与状态，已擦除的待处理控制消息不再进入恢复执行。外部 L0 未确认前返回 `deletion_pending`。用户 Workspace 交付文件、L1/L2/L3 资产及备份介质不在“即时清除 L0 会话正文”的承诺内。

历史来源无法证明时仍保留 `legacy_unresolved` 与来源报告，不送入 Memory，也不伪称原始输入已无损恢复。TDAI 远端后端的分片 upsert 并非跨进程分布式事务；稳定 message ID 与整批 receipt 保证重复请求可重试，MetaWork 仅在整批确认后记录已投递版本。
