# MetaWork 产品收敛整体核对与复盘报告

- 复盘日期：2026-11-07
- 状态：本轮审查完成；产品收敛验收未通过，非实施完成记录
- 审查对象：当前工作区 `HEAD 83c3f80029950e70957253f85cc5d1fb823c355a` 加未提交修改
- 输入：[PRD](2026-11-07-metawork-product-requirements.md)、[实施计划](2026-11-07-metawork-product-convergence-implementation-plan.md)、[技术实施方案](2026-11-07-metawork-product-convergence-technical-implementation-plan.md)
- 验证证据：[本轮测试与复现摘要 JSON](2026-11-07-metawork-product-convergence-review-evidence.json)
- 本轮只做审查、验证和报告；未修改生产实现或既有测试，临时复现测试已移除。未创建提交。

## 1. 结论

**当前工作区不是这三份文档的全部实现，不能按“全部编码完成，准备发布”验收。** 可核实的进展是 B0.1/B0.2 基线修复和一部分 Conversation Git 测试迁移；Phase 2–6 的主要替代能力仍不存在或仍由旧生产路径承担。

三项问题的直接回答：

| 问题 | 结论 | 主要证据 |
| --- | --- | --- |
| 有没有 bug | 有。确认只读准入与写执行不一致、接受结果因封存后的快照变化而误拒、目录 intent 在 schema 与准入之间不一致 | §3 的 B-01～B-03；全量测试及独立复现 |
| 目标是不是全部实现 | 没有。Kernel、Planner 绑定 Agent/model、vendored Pi、Codex、金额账单、TUI、Docker 执行、迁移链都还在生产路径；Server 仍硬编码 loopback | §5、§6 的代码证据与逐条 AC 矩阵 |
| 实现是否合理 | 部分基线修复方向正确，但跨模块契约未完全统一；部分测试将缺陷变成通过断言，且技术方案仍存在冲突和不够具体的设计 | §4、§7 |

本机实测：根项目 **4592 passed / 14 failed / 40 skipped or pending**，655 个测试文件，约 160.58 秒；lint/build 通过。Desktop 类型检查通过，26 项测试通过；official-server 24 项测试通过。这些结果只证明当前旧架构的部分能力，不能证明目标架构完成。

未发现足以定为 P0 的证据。B-01、B-02 是应先修的 P1；B-03 是明确的 P2 契约缺陷。目标未实现另列为交付缺口，不混入“新增 bug 数”。

## 2. 审查边界与事实基线

### 2.1 当前代码究竟做到了哪里

审查开始时有 28 个 tracked 文件未提交修改，其中 12 个生产文件；新增文件主要是规划、ADR 和 B0.2 记录。最近 HEAD 仍是 `83c3f800`，不存在本地可见的 Phase 2–7 完成提交。这里依据的是实际调用链，不单凭 Git 提交多少判断完成度。

[B0.2 实施记录](2026-11-07-b0-2-baseline-failure-classification-record.md) 自身也写明：30/44 关闭、14 项开放、Phase 0 仍开放。本轮完整测试复现了这一数字。总计划还停在 44 项红测的上一批状态；ADR-0055 仍 Proposed。因此“都实施完成”与当前可审查工件不一致。若完成版在另一个分支或工作区，本报告不代表那个版本。

### 2.2 验收口径

以用户已确认的决策修正 PRD 草案中的旧条款：

- Router 不要求同条件确定性；要求资格正确、决策事实和理由可查。AC-13 的确定性部分不作为失败。
- AC-35～37 运行中追加/改向本次延期，不计为漏实现。
- 云端/本机部署拓扑由部署方选择；不要求本次提供云端托管、隔离编排或环境分配系统，也不把 macOS 本机 Server 本身判为缺陷。
- 保留真实 Token 计量，取消模型金额；官方订阅/License/支付与模型成本分开。
- 旧本地数据不迁移；fresh schema 的新旧库处理仍需显式、可预测，不能悄悄删除。
- 官方服务 Docker 与本地任务 Docker 在计划中存在范围差异；本报告不会仅因官方部署 Docker 仍在就判整个清理失败。但本地任务 Docker 的生产路径也还存在，清理目标依然未达成。

### 2.3 执行了哪些验证

| 验证 | 本轮结果 | 边界 |
| --- | --- | --- |
| `npm run lint` | 通过 | 根 TypeScript |
| `npm run build` | 通过 | 含 schema/extension 生成及 Web 构建；非 DMG 发布验收 |
| `npm test -- --reporter=json --outputFile=...` | 4592 通过 / 14 失败 / 40 跳过或 pending | 当前 macOS arm64，Node 22.23.3；655 文件 |
| `npm run lint:desktop` | 通过 | Desktop 类型检查 |
| `npm run test:desktop` | 10 文件 / 26 项通过 | 单测，不是 Electron 真实三端旅程 |
| `npm test --prefix official-server` | 24 项通过 | 官方服务自动测试，不是生产支付操作 |
| 目录 intent 临时探针 | schema 通过、准入拒绝，预期断言失败 | 确认 B-03，未计入上面的 14 项 |
| 封存前后 delta 实验 | 文件字节未变化，但 delta 不等 | 确认 B-02 的机制 |
| 文档链接检查 | 总计划与 ADR 有失效引用 | 见 §7.3 |

未执行 Linux 原生全测、真实付费模型调用、全新机器安装、真实 Web/Desktop/Feishu 联调、非回环 Server 访问与全面断电/进程故障注入。没有这些证据的 AC 不能标“已验收”。

## 3. 已确认的问题

### B-01 / P1：只读准入可以变成写执行并回写用户目录

**位置：** [control-kernel.ts](../../src/kernel/control-kernel.ts) 第 1200–1202 行、[subtask-attempt-runner.ts](../../src/execution/subtask-attempt-runner.ts) 第 604–605 行、[workspace-effect.ts](../../src/work-graph/workspace-effect.ts) 的 `supportsSharedWorkspaceRead`。

触发条件：单节点 `deliveryKind='report'`、`fileOutputs=[]`、`workspaceIntent.operation='read_only'`，省略 `workspaceEffect`。这是 schema 允许、validator 也允许的单节点输入。

准入只根据 `deliveryKind/fileOutputs` 得出 `writes=false`；Runtime 只有看到显式 `workspaceEffect='read_only'` 才走只读分支。省略字段的节点因而拿到可写 Conversation Worktree，随后被 seal 并合并到用户 Workspace。

**本轮证据：** [declared-file-delivery.test.ts](../../tests/e2e/declared-file-delivery.test.ts) 的 `unsolicited action reports` 用例通过，但第 133–143 行明确断言两个未请求的报告文件已经出现在用户根目录。其 helper 为该计划生成的恰好是 read-only intent。这证明通过的是缺陷行为，不是只读保证。

这不是“所有未声明文件都不许存在”的产品争议：普通代码编辑 `fileOutputs=[]` 可以有合法源码变更；此处问题是**明确只读授权被执行层升级为写权限**。是否登记 artifact 与是否有权写用户目录是两件事。

影响：只要求回答/浏览的任务可能修改用户 Workspace，准入与 Host/lease 的权限语义不一致。

建议：由 Work Graph/Workspace owner 定义唯一 effect 解析规则，让 schema、validator、admission、claim 和 Attempt launch 使用同一结果；对 unknown effect 要么要求补足写意图，要么按已批准的 read-only admission 强制只读，不能默认为写授权。恢复“只读不回写”的负向端到端断言。此问题已在 B0.2 O5 留痕，但现有绿测不能将它关闭。

### B-02 / P1：接受结果把 Git 封存误认为用户修改，任务无法完成

**位置：** [subtask-attempt-runner.ts](../../src/execution/subtask-attempt-runner.ts) 第 389–390 行，关联第 1203–1213、1785–1786 行；[workspace-change-tracker.ts](../../src/execution/workspace-change-tracker.ts) 第 38–67 行；[conversation-worktree-service.ts](../../src/execution/conversation-worktree-service.ts) 第 245–267 行。

触发：Executor 写入合法结果但 completion metadata 不完整；系统保存 safe result 并允许用户接受。执行时先记录 delta，结束时 `sealAttempt` 更新 Git ref/index；用户接受时又用 `captureWorkspaceState(rootPath)` 相对**当前** HEAD 采集脏文件，并与封存前 delta 做 `JSON.stringify` 全等比较。

独立实验中，同一 `answer.md` 字节始终为 `accepted answer`：封存前 `changed=[answer.md]`，提交后 `changed=[]`，比较为 false。不是文件真的变了，而是比较基准变了。filesystem fallback 与 Git 通道差异还会叠加类似问题。

**本轮证据：** `task-result-service-acceptance` 的 `accepts an uncertified result...` 失败为 `queued != succeeded`；`task-state-recovery-journeys` 的两条接受/重启恢复也失败。该结果与 B0.2 O2 的 uncertain effect 记录吻合。

影响：用户明确接受后仍卡在 queued/待恢复，重启也不能可靠地只交付一次；不满足接受、恢复和最终交付不变量。

建议：以 result 对应的固定 commit/tree 和采集通道为身份校验基准，保留原始基线；检查是否真正发生内容变化，不能用移动 HEAD 的脏状态替代。修复同时覆盖接受、接受后进程退出、重复接受和真实文件被篡改四种情况；不能简单删掉校验或只比文件名。

### B-03 / P2：目录 intent 的 schema 与准入语法不一致，现有夹具掩盖了问题

**位置：** [planning-agent-plan-schema.ts](../../src/planning/planning-agent-plan-schema.ts) 第 187–195 行、[planning-agent-plan-validator.ts](../../src/planning/planning-agent-plan-validator.ts) 第 205 行附近；[workspace-execution-decision.ts](../../src/kernel/workspace-execution-decision.ts) 第 208–211 行。

本批把 `workspaceIntent.targetPaths` 改成接受 `isValidFileOutput`，因此 `['site/']` 合法；plan validator 也去掉尾斜杠再检查覆盖。但 Kernel `safeTargetPaths` 仍用 `isWorkspaceRelativePath`，后者拒绝末尾空路径段。

临时测试直接构造 `targetPaths=['site/']`、`fileOutputs=['site/']`：`PlanningAgentPlanSchema.safeParse(plan).success === true`，实际 `resolveWorkspaceAdmission` 返回 `rejected`，原因为 unsafe/non-relative target path。

[planning-agent-plans.ts](../../tests/support/planning-agent-plans.ts) 第 115 行提前删除尾斜杠，使原有 `dedicated directory` 测试一直使用 `site`，没有覆盖真正被新 schema 接受的 `site/`。

影响：真实模型按生成 schema 给出目录目标时，规划验证通过，实际准入失败；报告中 F4“统一语法”的关闭范围不完整。这是当前未提交 schema 修改带来的新增不一致，不在原 14 项失败中。

建议：明确 `targetPaths` 是否保存规范化目录名，并在同一个生产规范化入口实施；若不支持尾斜杠，schema 不应宣称支持。增加从 schema 输出直接进入准入的 contract test，不通过 helper 替换被测输入。

### B-04 / P2：部分测试改写失去了原先的安全/恢复验收能力

**位置：** [declared-file-delivery.test.ts](../../tests/e2e/declared-file-delivery.test.ts) 第 133–143 行；[blocked-task-user-journey.test.ts](../../tests/session/blocked-task-user-journey.test.ts) 第 137 行后的 unblock 断言。

前者将“没有授权的文件不交付”改为“文件确实进入用户目录”。作为临时行为记录可以帮助排障，但不能继续计入安全要求的通过证据。后者由“恢复成功”改为“仍 needs_action、无第二次执行”；对无法确认外部副作用的 fail-closed 是合理的，却不再验证原先的可恢复 Workspace-only 工作。

建议：将 characterization 与验收状态分开记账；保留 unknown-effect 拒绝重跑测试，同时补一条真实可证明安全的恢复成功路径。B0.2 的“30 项关闭”不等于 30 个产品不变量均已恢复。

## 4. 14 项红测的复核与其他风险

### 4.1 失败分组

| 文件 | 失败数 | 本轮事实 | 判断 |
| --- | --- | --- | --- |
| `tests/e2e/task-result-service-acceptance.test.ts` | 5 | 独立 API smoke 未满足预期；接受结果仍 queued；原路径修改返回 failed；两个服务状态查询报“服务不存在” | 接受路径已确认 B-02；其余含夹具/完成协议/服务来源问题，不能全部直接定为生产缺陷 |
| `tests/e2e/task-state-recovery-journeys.test.ts` | 5 | 两个接受恢复失败；服务重启对应 Task failed；端口归因为 service_start_failed 而非 port_in_use；publication 计数为 0 | 接受恢复受 B-02 影响；服务与旧 publication 断言需进一步隔离 |
| `tests/e2e/publication-delivery-recovery.test.ts` | 4 | resume/restart/copy-before-save/cancel 用例读取 undefined publication 的 id/status | 现有测试没有跑到目标恢复断言，属于验证缺口；不能据此声称生产的全部 merge 恢复坏了或已经正常 |

14 项的具体测试名已保存在证据 JSON。本轮没有删除、skip 或改写这些用例。

下一步服务验收应把 harness 的 publication 目录解析换成实际 Conversation Git 的 delivered change/service worktree 事实，再分别验证启动、health、EADDRINUSE 和重启。发布恢复应在现行 merge/writeback seam 注入错误，并保留“Executor 不重复执行、commit 保留、恢复只交付一次、取消不新增写回”的原有断言。

### 4.2 新修改的维护风险

- [git-artifact-reader.ts](../../src/delivery/git-artifact-reader.ts) 第 19–25 行用两种 `dirname` 深度加 `existsSync` 猜 repository root。正常读取路径修复有价值，但仍把目录布局当成契约且新增 fallback。建议由 Account workspace services 注入唯一可信 Git root 或 resolver port。当前保留 pin、hash、size 校验，本轮未证明它导致跨账户读取，不能把这个风险写成已证实漏洞。
- [session-kernel-runtime.ts](../../src/session/session-kernel-runtime.ts) 第 457 行新增缺失 owner 的 legacy 恢复分支。作为现有架构基线修复可解释，但属于额外兼容路径，必须登记到 Phase 3/6 删除清单；不能算 fresh schema 收敛的一部分。
- [subtask-attempt-runner.ts](../../src/execution/subtask-attempt-runner.ts) 第 1653 行留下直接 `console.error('ATTEMPT_ERROR', error)`，未走结构化/脱敏日志；[metaclaw-session.ts](../../src/session/metaclaw-session.ts) 第 481–482 行重复赋值。前者需清理日志边界，后者属于小型质量问题。本轮没有实际敏感信息泄露证据。

## 5. 核心目标完成情况

以下引用是**仍被产品调用的实现**，不是仅凭目录名存在就判断未完成。

| 领域 / 阶段 | 当前实现证据 | 完成度判断 |
| --- | --- | --- |
| Phase 0 基线 | B0.2 记录开放，完整测试仍红；本轮新增目录 intent 缺陷 | 部分完成 |
| Phase 1 契约重置 | ADR-0055 第 3 行 Proposed；当前 ADR-0020/CONTEXT 仍描述 Kernel；被引用专项设计缺失 | 未关闭，不能当作已接受契约 |
| Phase 2 单一上游 Pi | [package-release.mjs](../../scripts/package-release.mjs) 第 101、208–210、455 行仍打包 vendored Planner；其 coding-agent package 为 0.80.2；[account-execution-services.ts](../../src/account/account-execution-services.ts) 第 133–140 行同时注册 Codex/Pi | 未完成；现有 managed Pi 不等于规划/执行共用一个上游 runtime |
| Phase 3 无 Kernel/Router 直派 | [account-kernel-services.ts](../../src/account/account-kernel-services.ts) 第 20–25 行实例化 ControlKernel/ledger；[account-kernel-coordinator.ts](../../src/account/account-kernel-coordinator.ts) 第 83 行使用 DurableKernelWorkflow；Server composition 第 1169 行仍为 SpanRoutingAdvisor | 未完成，旧策略路径还在 |
| Manager 不派发 | planning schema 第 120–134 行仍包含 `executorBindings.agentClassRef/modelSelection` | 未完成 |
| Manager 权限判断 | [permission-workflow-service.ts](../../src/execution/permission-workflow-service.ts) 第 316–353 行走静态 `evaluateCapabilityRequest` 和 escalation hook；无 Manager judgement 调用，仍引用 Kernel workflow | 未完成。已有硬规则/用户授权机制不等价于 Manager 自主判断 |
| Manager 最终汇总 | [kernel-execution-runtime.ts](../../src/execution/kernel-execution-runtime.ts) 第 5466–5485 行将 Subtask 首行和状态拼成摘要 | 未完成；完成提示修复不等于针对原始需求的 Manager 综合回答 |
| Phase 4 Token 替代金额 | [billing-schema.ts](../../src/storage/billing-schema.ts) 第 126、137、157 行仍创建 price/cost/bill；[BillingView.tsx](../../web/src/components/BillingView.tsx) 仍按当前 Query 展示 MetaCoin；[usage-normalizer.ts](../../src/metering/usage-normalizer.ts) 仍保留 unavailable | 未完成 |
| 所有模型调用计量 | [official-server/server.js](../../official-server/server.js) 第 216–220、240–244 行只记操作审计且只返回业务 JSON，未保存 provider usage | 明确缺口，官方 AI 调用仍无法进入完整 Token 对账 |
| Phase 5 网络 | [management/server.ts](../../src/management/server.ts) 第 357 行硬编码 `127.0.0.1`；第 682–695 行 WebSocket Origin 硬编码 loopback/端口 | 未完成。现有 Nginx 部署说明不能替代 Server bind/origins 的产品配置契约 |
| Phase 5 客户端 | [cli/args.ts](../../src/cli/args.ts) 第 27 行裸命令返回 tui；[index.ts](../../src/index.ts) 仍运行 TUI；[WorkspaceHeader.tsx](../../web/src/components/WorkspaceHeader.tsx) 第 5 行只有 conversation/trajectory/billing | 未完成；独立 memory Tab 不存在 |
| Memory | [MemorySettingsPanel.tsx](../../web/src/components/MemorySettingsPanel.tsx) 和 [api/memory.ts](../../web/src/api/memory.ts) 已有分页/筛选/正文；API 只有 status/list/get/toggle/delete，无导出 | 部分已有，但独立 Tab、导出及三端验收未完成 |
| Desktop 矩阵 | [electron-builder.config.mjs](../../apps/desktop/packaging/electron-builder.config.mjs) 第 39 行附近仍允许 x64 的 native builder | 未严格限制 Apple Silicon；现有 Desktop 单测通过不能证明发行矩阵合规 |
| Phase 6 原生唯一执行 | [account-task-services.ts](../../src/account/account-task-services.ts) 第 47 行与 session 第 341 行仍可选择 DockerCliAttemptExecutionBackend | 未完成，非单纯历史文件残留 |
| Phase 6 迁移清理 | [migrations.ts](../../src/storage/migrations.ts) 第 2923 行起仍识别并迁移多版数据库，main schema 65 + billing 41；新补 legacy owner fallback | 未完成 |
| Phase 6 Windows/文档 | release script 接受 win32/x64；install.ps1、Docker assets、已完成 active plans 仍在 | 未完成 |
| Phase 7 验收 | macOS 根套件未绿；无本轮 Linux、干净安装及目标三端旅程证据 | 未通过 |

## 6. PRD 验收项逐条核对

“未验收”不等于认定代码一定错误；表示没有足够证据对该目标签收。旧功能部分已存在时，不标整项完成。

| AC | 状态 | 核对结果 |
| --- | --- | --- |
| 1 | 未实现 | TUI 仍是实际入口，不止三个客户端 |
| 2 | 未实现 | 裸命令仍进 TUI，不是 Web |
| 3 | 部分 / 口径修正 | Desktop 仍接受 Intel；Linux Server 已有路径。“Server 只能 Linux”不按草案否定用户允许的本机部署 |
| 4 | 未实现 | 仍打包并运行 vendored Agent 内核 |
| 5 | 未实现 | Codex 与 Pi 均注册，仍有 Codex 设置 |
| 5b | 未验收 | managed Pi 已有部分保障；未证明 Manager/Executor 同一上游版本的干净机器全链路 |
| 6 | 未实现 | SettingsPanel 第 2312、2330 行仍有输入/输出人民币价格；新路由模式亦未收敛 |
| 7 | 未实现 | BillingView 仍是 Query bill，缺目标时间线、三卡和 Provider 分组 |
| 8 | 未实现 | 金额/MetaCoin 和不完整 usage 状态仍存在；未实现新北京时间用量聚合合同 |
| 9 | 未完成 | 现有 payer 概念不构成 Included/On-demand 周期额度 API/页面验收 |
| 10 | 未完成 | 未找到完整 quota exhaustion→导流→继续执行的新产品链路与验证 |
| 11 | 部分已验证 | 官方服务模型 Key 位于 server 环境，响应只返回业务结果；官方/授权测试通过。新 Included Provider 全客户端敏感字段验收未执行 |
| 12 | 部分实现 | 已有分页/检索/筛选/全文；仍在设置内，无独立 Tab 和记忆包导出 |
| 13 | 部分 / 口径修正 | 现有资格过滤不等于新 Router 直派/trace；“同条件确定性”已由用户取消，不计缺陷 |
| 14 | 待产品配置 / 未完成 | 档位具体数值可延期；新 Token 额度合同未交付，云环境分配不在本次部署范围 |
| 15 | 未实现 | Planner schema 仍接受 Agent/model binding |
| 16 | 未实现目标合同 | 已有 span routing 事实；不是本方案 RouteDecision→逐 ready Subtask 直派闭环 |
| 17 | 未实现 | Kernel 决策/授权链仍存在。这里指额外决策层，不据此推断每次都有用户审批弹窗 |
| 18 | 未实现 | 完成逻辑仍拼接 Subtask 摘要，未接 Manager 汇总 |
| 19 | 未实现 | 静态权限规则直接 grant/deny/escalate，尚无 Manager 意图判断流程 |
| 20 | 部分 / 未验收 | 旧 Planner/Executor 边界已有；目标 no-candidate、部分结果与 Manager 角色合同未完成 |
| 21 | 证据不全 | 原审计报告当前不在工作区；缺完整删除理由与替代验证链 |
| 22 | 未通过 | 根套件 14 红测；当前大批未提交修改不具备逐批 closing/rollback commit 证据 |
| 23 | 未实现 | plans 仍有已完成文档；当前架构与新目标尚未同步，索引有失效链接 |
| 24 | 未实现 / 口径修正 | 按用户确定的 fresh schema / 不迁移验收；当前仍保留多版升级路径 |
| 25 | 尚不适用完成认定 | 当前主要是基线缺陷修复，不是已完成纯删除批次；新增 legacy fallback 需明确退出 |
| 26 | 规划层已具备 | 有统一实施次序，但不能由此认定全部批次已落地 |
| 27 | 未实现 | native 与 Docker 后端仍可选择；云隔离拓扑不由本轮替用户决定 |
| 28 | 未实现 | 本地 docker/、Dockerfile.test、镜像脚本、Docker 后端及测试仍存在；不依赖官方部署资产是否例外来判定 |
| 29 | 未通过 | 本轮 macOS 可原生跑但 14 失败；Linux 原生未验证 |
| 30 | 未实现 | 监听地址硬编码 loopback |
| 31 | 未完成 / 未验收 | 反向代理可实现某些访问不等于产品客户端 endpoint 配置合同已完成 |
| 32 | 未实现 | 来源策略仍固定 loopback；内部服务仍回环这一子条件不足以完成整项 |
| 33 | 未实现 | 设置/账单等产品文案仍显示 Planner，例：SettingsPanel 第 2465 行 |
| 34 | 未实现 | 真实链路仍 Planner/Span/Kernel/Executor，不能展示成已完成 Manager/Router/Executor |
| 35 | 本次延期 | 用户确认保留运行中输入阻塞 |
| 36 | 本次延期 | 用户确认不做运行中改向/追加编排 |
| 37 | 本次延期 | 随 35/36 延期 |

这里不计算“完成百分比”：单项包含多条条件，部分条款被用户修正，还有真实旅程未执行；用总测试通过比例作为产品完成度会误导。

## 7. 合理性复盘

### 7.1 已做对的部分

- 让 E2E 使用真实 Conversation Worktree、seal 和 merge，而不是继续断言新 Task 在用户根直写，方向正确。`planner-owned-workspace-mode` 等本轮已通过。
- 重规划从 Task 自身绑定恢复 Workspace，避免依赖客户端当前选择，符合账户/会话所有权要求；generation replan 与 startup recovery 的适配修复有实际价值。
- 重试复用耐久 Workspace identity、handoff 相对路径与 immutable artifact identity 对齐，修复发生在相应运行边界，没有删掉认证检查。
- 文件交付后的状态/输出刷新修复了用户看到陈旧完成状态的问题；`scripted-session` 与 planning/session 路径本轮通过。
- 整体技术方向——Router 单一派发决策、Manager 权限语义、Runtime 机械执行、持久事实保留、逐批替代后清理——合理。但当前尚未实现，不能把设计合理当成交付合理。

### 7.2 实施过程暴露的问题

1. **把前置修复当作产品收敛完成。** 基线 53→44→14 的下降是实际进展，衡量的是现有系统回归，不是无 Kernel/Pi/Token/客户端功能完成。
2. **同一规则在多处分别实现。** Workspace effect 和目录语法分别存在于 schema、validator、Kernel、lease 和 runtime，导致 B-01/B-03。需要 owner-owned 公共规则与跨边界合同测试。
3. **测试 helper 修正了生产输入。** 尾斜杠被夹具提前消掉；多数普通用例通过，但真实 schema 输出没有经过相同规范化。
4. **测试目标发生改变却继续计为关闭。** 对 B-01 的 characterization 可以保留为已知行为证据，但要单列未满足的不变量，不能用绿测覆盖风险。
5. **结果身份与可变工作区状态混淆。** immutable commit/result 已存在，接受路径仍依赖当前 Git dirty set，破坏恢复可靠性。统一持久事实比给字符串比较增加例外更可靠。
6. **文档与代码阶段状态不同步。** 三份计划未形成完成日期、交付行为、验证矩阵和 closing commit；新增实现记录则明确尚未完成。需要以仓库事实管理阶段状态。

### 7.3 技术方案本身也需要修订

这些是本轮对设计合理性的复盘，不是要求用户重新批准已经明确的目标：

- **用量描述自相矛盾。** 技术方案 §7.1 同时允许 unavailable/zero/estimated 又禁止不确定量。应明确 provider 支持矩阵、异常/取消时的 usage 获取方式及 durable call identity；不能把 missing 当 0，也不能仅通过“调用失败”抹掉已消费的 Token。
- **权限策略不能机械沿用旧规则。** 技术方案 §6.3 / ADR Proposed 中的 always-escalate catalogue 若跳过 Manager，会与“所有额外权限先由 Manager 判断、尽量少问用户”冲突。不可授予的硬隔离边界与可由 Manager 语义判断的权限应分清；旧 capability 分类不是已确认的新产品政策。
- **部分权限隔离参数仍不足。** 当前 fingerprint 只含 task/subtask/capability/partition/operation/scope；新方案要求的 account/generation/attempt/request revision/config binding 需要真正设计并验证，不能靠给旧 service 改名完成。
- **批次编号不一致。** 技术方案总表 P3-B 同时放 Router/权限、P3-C 放 Kernel 删除；正文则 P3-C 是权限、P3-D 是删除。后续实现记录难以追踪，应统一。
- **完成顺序需要按实体区分。** 技术方案 §6.4 的“Subtask 终态→...→handoff materialization”若按字面执行，与当前 `Subtask done` 和出边 handoff 同事务的不变量冲突。应明确 Attempt receipt、Subtask dependency-ready、Task user-delivered 三种状态，避免先 done 后补 handoff。
- **新 schema/API 仍是方向而非完整规格。** 当前技术稿多数是字段举例、端口命名和测试清单，缺最终 DDL/索引/事务、版本号、HTTP DTO 与错误码、Pi 选定版本和扩展差异清单、额度完整回收/对账语义。不能把这些写着“需确定”的内容视为已经落地。
- **已经确定的产品输入无需再当作未决。** Router 不要求确定性、运行中输入保持阻塞已由用户确认；不应再次用 P-4 或旧 PRD 条款阻塞这一结论。
- **文档链接缺失。** 总计划链接的 baseline alignment、target contract design、target reset implementation 文件当前不存在；ADR-0055 还链接缺失的 audit report。应恢复真实记录或移除失效引用，不能靠失效评审表宣称 Accepted。

## 8. 建议修复与实施顺序

| 顺序 | 工作 | 关闭条件 |
| --- | --- | --- |
| 1 | 修 B-01 只读授权边界、B-02 接受快照、B-03 目录语法 | 真实 schema→准入→执行负向/正向测试通过；接受/重复接受/重启/篡改均验证 |
| 2 | 完成剩余 B0.2 测试迁移，保持失败恢复不变量 | 14 项逐条关闭，恢复服务与 merge 故障测试；不以删测试或接受缺陷换绿 |
| 3 | 修正文档状态与技术规格，补齐缺失的决策/设计记录 | 需求变更口径一致；P1 合同可实施；矩阵、编号、DDL/API、Pi 版本清楚 |
| 4 | 依次实施 Pi 收敛、Router/Runtime/Manager 权限及 Kernel 替代 | 每条新 owner 链通过后再删除旧生产路径；接口、恢复和安全边界可复核 |
| 5 | 实施完整 Token 调用账本/额度、用量和记忆客户端、Server 地址配置 | 每个调用有精确用量；客户端目标可实际演示；认证/origin/内部回环验证 |
| 6 | 完成 Docker/Windows/迁移/历史文档清理 | macOS/Linux 原生测试通过、替代能力通过、删除清单有依赖证据 |
| 7 | 真正执行 Phase 7 | 干净安装、真实模型、三客户端、远程地址、恢复、用量对账全部有记录 |

本轮应签收的交付物是这份复盘与证据摘要，**不应签收整项产品收敛完成或开始发布**。

## 附录：本轮证据如何复查

- 根套件命令：`npm test -- --reporter=json --outputFile=/tmp/metawork-convergence-review-tests.json`；持久化的简化摘要见本报告顶部 JSON。
- B-01：运行 `npx vitest run tests/e2e/declared-file-delivery.test.ts -t 'unsolicited action reports'`，结合 read-only intent 与用户根文件存在的断言检查；用例通过恰好说明风险存在。
- B-02：运行 `npx vitest run tests/e2e/task-result-service-acceptance.test.ts -t 'accepts an uncertified result'`。独立最小机制复现：新建 Git 仓库→采集空 baseline→写 answer.md→采集 delta→提交文件→重新采集 delta；文件哈希不变，但 dirty delta 由一个文件变成空数组。
- B-03：构造 `workGraphPlan({goal:'Create site',deliveryKind:'edit',fileOutputs:['site/'],overrides:{workspaceIntent:workspaceIntentFixture({operation:'create_in_target',targetPaths:['site/']})}})`；schema 接受后，把相同 intent、`writes:true`、`declaredOutputPaths:['site/']` 和合法绑定 Workspace 交给 `resolveWorkspaceAdmission`，结果为 rejected。本轮临时测试已移除，后续修复时应转为正式回归。
- 现有通过的关键套件：declared-file-delivery 11、planning-kernel-path 23、planner-workspace-intent 15、subtask-attempt-runner 43、workspace-merge-worker 2；账户/Gateway 隔离的两组专项各 2 项通过。它们不是目标收敛全项通过证明。
