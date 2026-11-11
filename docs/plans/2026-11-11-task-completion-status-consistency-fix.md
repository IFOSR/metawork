# 已完成任务阻塞、轨迹状态滞后与错误澄清修复

- 计划日期：2026-11-11。
- 状态：本批修复已完成并运行于 8788；真实旧任务恢复、页面状态核对、架构比较续测均通过。完整产品验收仍见下方局限。
- 完成日期：2026-11-11。
- 本批修复验证日期：2026-11-11。
- Closing commit：无；按要求仅本地修改，未 commit 或 push。
- 依据：ADR-0055 Task Runtime 恢复职责、ADR-0049 唯一 Task 状态、ADR-0054 正文真源。

## 用户反馈与实际根因

1. **黄金、英伟达、上海天气的子任务全部完成，整体却阻塞。** 这三个任务包含一次或多次 `contract_correction`：原输出正文已有安全投影，但完成报告格式错误，原 immutable result 标记为 `partial`；修正完成报告后 receipt 已 `completed`，且通过 sourceAttemptId 引用同一正文。最终汇总额外要求旧 object 的 completeness 必须变为 complete，导致 `workspace_completion_missing_certified_results`。该错误又被恢复项读模型一律解释为外部操作结果未知。
2. **对话与轨迹卡片不一致。** 轨迹页独立读取 TaskView，没有采用对话页统一状态投影，且把第一页/正在浏览的历史 trace 作为当前卡片事实；旧的执行事件与健康检查文案残留。
3. **鸡蛋任务轨迹仍运行。** 除上述页面问题，该任务有四个子任务，大量研究进度使 ExecutionTimeline 单独达到 **74,264 bytes**，超过 Gateway 单响应 **64 KiB**。TaskView 响应被拒绝，前端只有旧 trace，无法显示持久化的 done 状态。只改前端不足以解决。
4. **架构比较要求用户重复回答。** `conv_Rp8ik3gzkXdi` 的计划使用 `interaction:conv_Rp8ik3gzkXdi:user`，把 Conversation ID 当成 interaction ID。准入的安全拒绝正确，但错误被翻译成 clarification，交给用户修复内部引用。该轮实际上未创建 Task；不是已启动 Task 在等待用户。

## 修复边界

- 最终汇总复用经过 `resolveSafeResult` 身份核验的正文；只有 completed contract correction 且其 sourceAttemptId 精确对应正文 owner 时，允许正文仍保持原 partial 元数据。跨账号/Task/generation/来源引用不放宽，不修改原 receipt 或 immutable result。
- complete_task 恢复项单独提示“最终结果汇总或交付尚未完成”；不再声称有未知外部操作。其恢复 fence 仍阻止伪造成功。
- 轨迹与对话共用 `useTurnPresentation`，包括 TaskView 状态、刷新和连接 generation；卡片使用最新 trace，事件表独立保留历史分页。
- TaskView 超预算时压缩重复的 progress/history，仅保留每次 Attempt 最新进度摘要，保留所有子任务、Attempt 身份、状态和时间。完整细节仍由 trace/detail 分页提供；不提高传输上限、不伪造终态。
- terminal 卡片清除旧健康警报及仍在执行的文案。
- Conversation 在保存/准入之前检查上下文资格，向 Manager 返回 validation feedback，在既有最多三次提案内修正；准入兜底拒绝不再伪装成用户澄清。有效资料不被自动授权，真正缺少用户信息时仍允许模型明确提问。

## 真实恢复与页面证据

服务使用原迁移实例 `/tmp/mw-planning-e2e-RDW7Um`，端口仍为 8788，Memory 为 8421，8791 未启动。修复前 SQLite 一致性备份：`~/.metawork-backups/state-consistency-20261111/before-fix.db`。通过正常启动恢复 owner 接续，未手写数据库将任务改为成功。

| Conversation | 任务 | 修复后 | 执行 receipt 修复前 → 后 |
| --- | --- | --- | --- |
| `conv_-YG-BMGg_Cg2` | 黄金 | succeeded，最终汇总已写回，恢复项 settled | 5 → 5 |
| `conv_mLrulbAviNbP` | 英伟达 | succeeded，最终汇总已写回，恢复项 settled | 4 → 4 |
| `conv_yXz2FLCqhb25` | 上海天气与跑步 | succeeded，结果已写回，恢复项 settled | 2 → 2 |
| `conv_zLTvUkZlxuPY` | 鸡蛋 | 原本 succeeded；现在轨迹完整显示四个 done 子任务 | 未重跑 |

Admin 实际网页逐一打开上述会话：对话不再显示阻塞提示；轨迹卡片全部已完成；加载更多历史后仍没有 running 卡片。日志 `/tmp/mw-state-verify-final.log`，截图 `/tmp/mw-state-fixed-<conversationId>.png`。中间曾只修复前端而仍复现鸡蛋卡片不一致，因此进一步定位并修复了传输大小问题；不以第一轮结果冒充最终通过。

### 架构比较的真实续测

通过 Admin 网页在原会话 `conv_Rp8ik3gzkXdi` 补充当前服务源码目录 `/Users/yuanjubian/program/metawork`，明确只读比较、禁止修改和提交，并保留原 GitHub URL。原用户消息把本机目录重复写成了 GitHub URL；但此前的错误提示实际来自内部 interaction 引用，不是正确询问本机路径。

- 新 Turn：`turn_CQmPorPU_Xhg`；Task：`task_plan_event_plan_conv_Rp8ik3gzkXdi_turn_CQmPorPU_Xhg_int_aadOk9aI6J`。
- 本机取证、GitHub 取证、综合比较三个子任务均为 `done`；Task 于北京时间 2026-11-11 09:02:14 完成，持久化状态 `succeeded`。
- 最终答案 revision 为 1，恢复项为空；未手改任务状态或结果。
- 重新打开网页后，最新对话明确显示“任务已完成”和最终报告，轨迹的三个执行卡片全部已完成，没有运行中或需要用户处理的状态。
- 旧 Turn 的错误澄清文字保留为历史记录，不改写已经发生的回复；本次续测没有新的待回答项。
- 验收日志 `/tmp/mw-architecture-final-check.log`；对话截图 `/tmp/mw-architecture-retry.png`；轨迹截图 `/tmp/mw-architecture-trajectory-final.png`。

结束时确认 Server 继续监听 8788、Memory 监听 8421，8791 没有监听服务。

## 自动验证与局限

- 完整 `npm run build`、`npm run lint` 通过。
- 本批专项加全部 Web：**63 文件，424 项通过**，日志 `/tmp/mw-state-final-tests-2.log`。
- 新测试包含 certified correction 源正文、错误来源/generation/未认证拒绝、内部 context ref 的修复反馈、真实 SQLite 恢复分类、大研究时间线预算、卡片与历史分页隔离。
- 本次也执行了旧 `plan-admission-policy.test.ts`，26 个既有用例失败，主要 fixture 仍含 response/executorBindings 或缺 workspaceIntent；旧 `read-only-query-handler.test.ts` 有 3 个已删除金额/账单接口用例失败。未为迎合旧测试恢复退休接口；相关新回归独立使用现行契约。完整 maintained-host 尚未全绿，不能把本批通过数等同整体验收。
- 本批验证流程状态与恢复结果持久化；不认证金融研究内容或数据准确性。
