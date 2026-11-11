# Planning 故障追踪与真实 Web 端到端验证

- 计划日期：2026-11-11。
- 状态：本地修复已验证，整体 PRD 验收未完成。
- 本批修复验证日期：2026-11-11；不作为整个收敛计划的完成日期。
- Closing commit：无。按仓库要求仅本地修改，未 commit、push；按用户明确要求，原 8791 实例已接管 8788，见文末迁移记录。
- 依据：[PRD](2026-11-07-metawork-product-requirements.md)、[目标契约](2026-11-07-metawork-target-architecture-contract-design.md)、[ADR-0055](../adr/0055-no-kernel-target-architecture-and-contract-reset.md)。

## 环境与验证边界

使用真实 Chrome，以 Admin 账号登录网页，通过页面选择 Workspace、发送消息、回答澄清、停止任务、打开文件与下载；没有以直接写入业务数据库代替这些交互。

原已安装实例为 `http://127.0.0.1:8788`，首先在该实例复现 Planning 失败：Conversation `conv_Z5IipESo1YN4`、Turn `turn_3ZrxZSAt-ka6`。后续修复使用源码构建的隔离实例 `http://127.0.0.1:8791`，运行根目录 `/tmp/mw-planning-e2e-RDW7Um`，专用 Workspace `/private/tmp/000-metawork-planning-e2e`。此前仅切回浏览器而未替换 8788 服务，用户再次遇到旧版 Planning 故障；现按用户要求将完整隔离实例改为监听 8788，原安装数据单独保留，见文末。

Manager 与 Executor 使用仓库准备的打包 Pi。真实模型调用使用现有自备 Provider；为绕过不可达的外部 Router，**仅隔离实例配置启用一个合格 Executor（助理）**，因此文件执行成功只证明单候选路径，不能代替多候选 Router 验收。账号凭证与 bearer token 不写入本报告。

## 发现的问题与本批修复

| 问题及用户影响 | 根因与修复 | 主要 owner |
| --- | --- | --- |
| 提交即 Planning 失败 | Manager 缺少完整现行提案 schema，生成退休字段、缺少必填字段或错误的 Workspace/task 语义。将 canonical schema 注入扩展，明确 host-owned 字段和显式 null；normalizer 处理缺失的空澄清值，不恢复退休 response 字段。 | `src/planning/manager-host/extension/index.ts`、plan normalizer/types |
| 修复提案仍收到矛盾反馈，最后显示空白 | 手写字段白名单漏掉合法 workspaceIntent；移除重复白名单，使用严格 schema 提供准确嵌套路径。三次拒绝后返回明确 convergence_exhausted。 | `src/planning/planning-agent-plan-validator.ts`、`manager-planning-agent.ts` |
| 多轮澄清后忘记最初要求 | 每轮 Pi 使用 --no-session。按 Conversation + Workspace 建立账户拥有的稳定 Pi session，使用原生续接；permission 和最终 summary 判断保持独立临时 session。 | `src/planning/manager-host/manager-agent.ts`、composition/session transport |
| Router 超时被显示成“没有合格候选” | 实际存在三个合格绑定，失败来自决策服务不可用。增加 route_decision_unavailable 分类、真实原因和恢复提示；不默认选候选、不伪造路由。 | `src/execution/router-failure.ts`、control execution runtime |
| 页面只提示运行失败，历史刷新后看不到原因 | 补充轮次内错误与 trace 兜底、历史读取的失败展示，移除可见的 Kernel 链路提示。 | ConversationTurn、ExecutionNotice、ObservedConversationView |
| 窄屏登录/发送/停止与会话切换被遮挡 | 修正 app frame/grid 高度、短窗口文档滚动；防止 sidebar 及横向会话列表被压缩到控件不可点击。 | `web/src/styles.css` |
| 本机目录超过 500 个后无法选择后续目录 | 增加 cursor 分页和“加载更多”，按原始目录项推进游标，客户端去重。 | directory browser、server/http client、WorkspaceCreator |
| 任务执行方式显示“未知来源” | Task view 裁剪丢失 publicDelivery 的来源字段；传递完整投影。未发布状态明确显示“尚无已发布的文件”。 | `src/server.ts`、delivery/Web 投影 |
| 文件已发布，但对话最终仍说尚未完成 | 异步 Workspace merge 完成没有跨过 durable result delivery 边界。校验 account/task/generation/attempt 与 certified safe projection，创建幂等业务结果，交给现有后台交付写回原 Turn；支持 outbox 重放。 | `src/execution/workspace-completion-result.ts`、control execution runtime |
| 发布文件预览和下载返回 410 | Git 固定版本被错误要求同时存在 loose CAS；改为读取并验证固定 commit 的内容，下载使用已验证 bytes。HTTP 410 又可能被浏览器缓存，因此 API 响应和客户端读取均禁用缓存。 | `src/management/artifact-preview-service.ts`、`src/server.ts`、Web HTTP client |
| 停止后下一轮问答完成但空白 | Pi 最终 assistant text 在 Manager adapter 中丢失，只传了 proposal/usage。单独保留原生最终文本，仅在已接受 no_action 时交给会话输出与 Turn Store；不提取 thinking/tool 文本，空回复明确失败。 | manager-agent/protocol/planning-agent、ConversationSession、保留 Session facade |
| 可见角色仍混用 Planner、旧执行链 | 本批 Web 可见文案统一为 Manager；输入区链路显示“Manager 拆解 → Router 派发 → Executor 执行”。内部 planner/runtime 兼容标识保留。 | settings/observation 与相关 Web 组件 |

## 真实用户路径证据

1. **多轮澄清及重启后上下文**：Conversation `conv_6hbhlBZCrw6t`，最终 Turn `turn_2ZRFGjCL8GvH`。覆盖专用文件的确认后，`e2e-clarify.md` 与初始需求逐字一致（69 UTF-8 bytes），包含 `MW-CONTEXT-73921`，未在澄清过程中改写原始正文。另有 `e2e-exact.md` 精确内容回归。
2. **提交 → 执行 → Git 发布 → 最终对话 → 刷新**：Conversation `conv_S_XqUKHUWmQ2`，Turn `turn_PCeDSXnhp1sL`，Task `task_plan_event_plan_conv_S_XqUKHUWmQ2_turn_PCeDSXnhp1sL_int_Iz1Pt_GK8w`。状态 succeeded；对话显示文件已发布，刷新后保留。
3. **文件预览和真实下载**：上述任务的 `e2e-publish-final.md`，打开 artifact drawer、下载菜单、Markdown 原文。下载文件 `/tmp/mw-e2e-publish-downloaded.md` 与 Workspace 文件均逐字节等于预期 73 bytes；包含 `MW-FINAL-20261111`。artifact `artifact_f78efb6f-8332-4adb-ad40-060ef0f77e23`，version `artifact_version_0653483c-3020-4ac4-9f97-ed1926c30b04`，固定 commit `f5a840dbf56a3084c6c9101877f55e9a579b21f2`，SHA-256 `ff64a99e284f04d4b6cf73f177d30f96caafe3ee16a0f49e8a51393d62045910`。
4. **756×469 窄屏停止及继续对话**：Conversation `conv_GooXiQel4yWG`。实际 Executor 进入 executing 后点击停止，Task `task_plan_event_plan_conv_GooXiQel4yWG_turn_XZw6XsMy7T5X_int_g-62ZQb1WR` 进入 cancelled，receipt 为 cancelled_or_stale，输入恢复。再次发送消息，Turn `turn_gqOz86Cd4IyL` 显示并持久化 `MW-AFTER-STOP-OK`；刷新后可见，未新建/恢复 Task。已取消 Task 没有恢复按钮，不以此冒充 blocked Task 的恢复验收。另已真实点击窄屏其他会话验证切换。
5. **超过 500 个目录**：专用 505 目录 fixture `/private/tmp/000-metawork-directory-pagination`。首屏 500 个目录加父目录，dir504 不可见；点击加载更多后 505 个目录加父目录，dir504 可见。关闭对话框，没有创建多余 Workspace。
6. **账号用量**：真实页面可读取总 Token、自备 Provider On-demand 和官方 Included；本批自备调用计入 On-demand，Included 为 0、官方剩余额度不变。已验证 Provider 分组展示 `custom-model-1`、切换本月后范围变为 `2026-11-01 — 2026-11-11`，再切换模型分组展示 `deepseek-flash`。未将页面读数当成官方服务扣费结算验收。

本地截图（临时文件，并非仓库交付物）：

- `/tmp/mw-e2e-publish-final.png`、`/tmp/mw-e2e-publish-preview.png`
- `/tmp/mw-e2e-directory-pagination.png`
- `/tmp/mw-e2e-narrow-running.png`、`/tmp/mw-e2e-narrow-stopped.png`
- `/tmp/mw-e2e-narrow-followup.png`、`/tmp/mw-e2e-narrow-conversation-switch.png`
- `/tmp/mw-e2e-usage.png`、`/tmp/mw-e2e-usage-filters.png`

## 自动验证与失败记录

- 最新根 `npm run build`、`npm run lint` 通过；窄屏补丁后 Web production build 再次通过。
- 最终专项 **17 文件、155 项通过**，包含真实打包 Pi RPC/Executor/native session、Manager proposal/repair/最终文本、Router 失败分类、durable completion、后台交付、真实 Git 固定版本读取、目录分页和 Web 失败展示等。日志 `/tmp/mw-final-focused-tests.log`。专项没有覆盖整体 PRD。
- HTTP artifact 路由专项 2 项通过（其余 67 项由过滤跳过），日志 `/tmp/mw-artifact-http-tests.log`。
- 先前本批 opt-in Chrome 目录/会话套件 2 项通过，日志 `/tmp/mw-final-browser-tests.log`；上面的 Admin 验证是另行连接真实实例执行。
- 后续已迁移上述 10 项旧 Web 断言到当前 Token/Pi 契约，未恢复退休路径。整个 Web 测试已 **58 文件、371 项通过**（`/tmp/mw-web-postrace-tests.log`），并包含在最新 **76 文件、518 项全部通过**的专项批次（`/tmp/mw-latest-regression.log`，启用真实打包 Pi）中。后续新增失败任务按钮和 MCP 方法边界用例，专项 **4 文件、36 项通过**（`/tmp/mw-last-fixes-tests.log`）；最终 Web 数量见下方续测记录。
- 完整 `npm test` 曾运行超过 18 分钟后停滞，终止了停滞测试 worker，未得到完成报告，日志 `/tmp/mw-full-e2e-regression.log`。过程中除已删除模块/迁移的收集错误外，仍出现路由 smoke、native install、Git delivery recovery、取消/准入、Session control、Executor 配置和架构测试失败。**尚未逐项证明这些只是测试过时；完整 maintained-host suite 未通过、未完成。**

## 仍然阻塞整体验收的事项

- **多候选真实路由（AC13/AC16）**：现有 `local-jev` 的 `192.168.0.110:8082` 不可达，请求超时；实际决策接口为 `/v1/systemone`。需要该服务恢复或确认现行地址，随后恢复隔离配置中的多候选并执行真实 Router → Executor。不得把单候选绕过判为 AC13/AC16 通过。
- **多子任务最终语义汇总（AC18）**：已实现并通过真实三子任务案例，见下方续测证据；模型内容质量、更多拓扑和汇总期间取消仍需扩大覆盖。
- **Memory（AC12）**：已隔离到 8421；真实提取、网页检索/详情/导出和跨 Conversation 的 L1/L2 证据执行通过。后台去重替换导致旧引用失效的案例已复现，恢复策略已修复并有专项测试；该自动重新规划闭环、完整停用/删除/账号切换矩阵仍需继续验收。
- **Permission 与恢复**：打包 Pi 的权限 RPC fixture 通过不代替真实权限升级/拒绝完整矩阵；本批停止后新一轮通过不代替 blocked Task 的原任务续跑、失败候选排除和重启恢复。
- **完整回归失败**：整个 Web 已通过；maintained-host 旧失败仍需逐项迁移/核定。补跑 control 相关 12 文件曾得到 61 通过、1 断言失败及 1 收集失败；目录提案测试的退休字段已修复并复测通过，`tests/execution/control-loop-policy.test.ts` 仍导入已删除 `src/kernel/control-kernel.js`。不恢复旧 Kernel 或 migrations 来迎合测试。没有完整全绿退出证据，不关闭整体 PRD。
- **交付文件类型**：本批真实 Markdown 预览/下载通过；Git report 内嵌图片、PDF/Office 等未在此路径逐类验证。
- **可见命名**：本批 Web 组件文案已调整；底层原始 trace 字符串仍可能出现历史角色词，不能据此声明 AC33/AC34 全量扫描通过。
- **发布验收**：原安装的 trial16 文件未改写，8788 现由修复版实例接管；签名干净机器以及 ADR-0055 D14 延后的 Desktop/Feishu/Linux 不属于本批通过项。

本记录保留失败与未验证项，后续继续在本地修复验证。本次本地端口迁移已获用户明确要求；正式发布仍未进行。


## 继续 Admin Web 验收与修复（2026-11-11）

### 新发现及处理

- **最终汇总**：增加 detached Manager summary turn，仅消费 certified subtask 结果；业务结果幂等持久化，刷新后可读，模型 Token 归原 Query。接受非空 `answer` 并容忍附加解释字段，修复真实模型返回 `{answer, confidence, reason}` 被拒的问题。只读完成统一显示“任务已完成”，不虚报发布文件。
- **汇总恢复**：`retry_authorized` 的 complete_task 原来没有实际接续入口。Runtime 仅在配置 pin 匹配、全部子任务 done、无其它 residue 且未取消/失败时复用已认证结果。完成事务内结清自身 recovery fence；提交失败会回滚结清。取消、未完成、配置变化和其它 residue 均不绕过。
- **恢复请求丢约束**：内部 Task goal 不等于用户原话；summary composition 通过原 Query/Turn 读取权威输入，保留长度要求。已有恢复结果不通过手改数据库重新生成。
- **Manager 上下文工具未接通**：仅生成 `mcp.json` 不会在当前 upstream Pi 中自动启用 MCP；原工具列表只有文件读取和 proposal。因此出现“Memory 已召回但 Manager 不引用”。新增显式 `read_metawork_context`，方法白名单只包含既有读接口，固定 account/database/config 路径及每轮 Conversation/Planner session/revision/attachments；模型不能改身份。每次调用限时并关闭子进程连接，Provider secret 不传给 MCP。permission/summary 保持只有 proposal 工具。
- **Memory 积压与丢提取**：排空 sidecar stdout/stderr 防止管道阻塞；初始化启动 scheduler；L1 返回失败不推进游标；重启从持久化 L0 恢复 pending L1，而非直接清零转 L2。修改已写入 release-owned compat patch，并通过反向 apply 校验。
- **记忆变化被误报成 Executor 不可用**：后台去重替换 L1 后旧 memoryId 不存在，原策略把启动前资料错误当作候选失败继续路由，最终无候选。对有 no-launch/no-side-effect 事实的记忆/资源引用失效，使用现有单次 generation replan；replan 前刷新 recall，耗尽后保留真实系统资料错误。Router 不排除未实际启动的健康绑定。
- **task_resource 资格不一致**：仅 prompt 中提到文件名曾被 admission 放行，但 Executor 只认 Task.resources。移除 prompt substring 放行，Workspace 文件以 current_user_input + goal 路径规划；准备失败有明确类型和未启动/无外部效果事实。
- **新建会话竞态**：创建请求进行中仍可向旧会话发送，随后跳到新会话让用户误以为消息消失。创建期间禁用发送，handler 同步检查 pending ref。真实网页延迟创建请求验证发送按钮禁用、显示创建提示、新会话没有误发 Turn（`/tmp/mw-new-session-race.log`）。
- **失败任务错误操作入口**：所有 failed 任务原来都显示“重试未完成部分”和取消，实际命令只接受可复用交付/服务结果。真实点击资料失败任务时必然被拒。现在按具体交付/服务失败及无残留事实展示重试；执行失败保留原原因和重新说明请求的提示，不承诺复用不存在的成果。

### 真实案例

- `conv_OvArKfoWXji8`：三个子任务分别读两个标记并比较，最终 Manager 给出 120 字以内结论，刷新保留。`/tmp/mw-ac18-browser-5.log`、`/tmp/mw-ac18-refreshed.png`。
- `conv_SCtagmVLJ5Hh`：原来三个 Executor 已 done、summary 失败的旧 Task，重启后 succeeded，recovery assumed_applied，Executor receipt 仍只有 **3** 条，未重跑。页面也变为成功。该旧例的生成文字仍有字符数错误，且此前恢复时未传原始长度约束；不能把状态恢复成功等同于内容质量完全合格。原始输入修复有独立回归。
- `conv_rl59JJe1yFRe`：Admin 网页发送“先给结论，再给可复现步骤”偏好。正常停机沉淀后，在隔离实例重启，真实模型提取 1 条 L1。网页列表、搜索、详情均可读，真实下载 `/tmp/mw-memory-live-export.json` 包含该偏好；截图 `/tmp/mw-memory-live-list.png`。
- `conv_eMvpQY-v0Iks`：文件任务完成但没有 memory ContextRef，不能算记忆执行验收；由此发现 Manager MCP 未接通。
- `conv_QiWazVsq3wdf`：接通 MCP 后 Manager 引用了记忆，但旧 L1 被后台替换，准备报 memory_asset_not_found，错误路由耗尽；随后点击重试也被拒。此失败记录保留，用于追踪上述分类与 UI 修复。
- **`conv_K4BywojoCqTn`**：修复后新建 Conversation，通过网页要求读取记忆并只读检查文件。Task succeeded；计划含带 revision 的 L1、L2 ContextRef，`task_execution_evidence` 有两个对应 long_term_memory 源；页面按“结论 → 可复现步骤”完成。证据为 `/tmp/mw-memory-recall-browser-3.log`、`/tmp/mw-memory-recall-browser.png`。这才是实际走到 Executor 的记忆验收，不以输出风格相似代替引用事实。

### 构建排障说明

中途仅执行 `tsup` 会清空 dist 却不生成提案 schema，导致测试实例持续 Planning schema 失败；这几轮不归因于模型能力。已恢复完整 `npm run build`（生成 schema、Pi tools、Web），缺失配置 schema 时明确报 `manager_plan_schema_unavailable`。未增加修复次数掩盖问题，仍为最多 3 次提案。所有真实成功案例均使用完整构建。

隔离实例 Memory 为 8421，原 8420/8788 未停止或改动；全部修改仍只在本地，未提交或安装切换。


### 最后复测

- 全部 Web：**58 文件、373 项通过**（`/tmp/mw-final-web-4.log`）；新增用例覆盖执行失败与可复用交付失败的按钮差异。根 lint、完整构建及最终 Web production build 通过。
- 最新真实三子任务 Conversation：`conv_VWfAZJdSlBD8`，Task succeeded；Manager 最终正文 **120 字**，刷新后保留，页面显示“尚无已发布的文件”。日志 `/tmp/mw-ac18-browser-final.log`。
- 回到资料失败 Conversation `conv_QiWazVsq3wdf` 刷新：无效的“重试未完成部分”按钮数量为 **0**；截图 `/tmp/mw-failed-task-actions-fixed.png`。
- 外部 Router 再次连接超时（HTTP 000）；未切换候选、伪造路由或将单候选成功认作多候选验收。

## 用户要求的实例端口迁移（2026-11-11）

用户明确要求把原 8791 上的全部服务原封不动迁到 8788。已停止旧 trial16 Server 及其 8420 sidecar，使用原隔离实例的代码、账号、配置、数据库、Workspace、Manager/Executor 和 Memory 依赖接管 8788；8791 不再监听。未覆盖或合并两套业务数据库，未改动原 trial16 安装文件。

- 当前运行根：`/tmp/mw-planning-e2e-RDW7Um`，`app/current` 仍指向本仓库，沿用之前验证过的完整构建。
- Web：`http://127.0.0.1:8788`，监听 `0.0.0.0`；保留 localhost 及此前两个 LAN/Tailscale 地址的 8788 origin。
- Memory：原实例的 8421，沿用 `/tmp/mw-memory-diagnostic` 入口和原账户 Memory 数据。
- 原单候选 Executor 配置保持不变；迁移前后 41 个配置文件哈希一致。此迁移不代表外部 Router 或多候选验收完成。
- 启动脚本：`/tmp/mw-planning-e2e-RDW7Um/run-on-8788.sh`；日志：`/tmp/mw-8788-migrated-server.log`。运行根和依赖仍为此前临时路径，未另行搬移目录或增加开机自启。
- 两套迁移前备份：`/Users/yuanjubian/.metawork-backups/port-cutover-20261111`，包含各自账户、配置、数据、凭据及 SQLite 一致性快照；旧安装仍保留在 `/Users/yuanjubian/.metawork-trial-0.1.26`。
- 迁移后已用 Admin 登录；历史会话可读。Conversation `conv_Xk9tDIqg4XQb` 已通过 Planning、三个子任务及最终汇总，Task `succeeded`、三个 Subtask `done`，刷新后结果保留。截图 `/tmp/mw-8788-migration-refreshed.png`。

用户随后明确表示剩余验证自行进行，助手仅负责迁移，因此停止继续测试和功能修改。整体 PRD / maintained-host / 异常恢复未关闭项保持原状态。无 commit 或 push。
