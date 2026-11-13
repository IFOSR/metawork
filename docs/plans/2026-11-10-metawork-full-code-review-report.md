# MetaWork 全盘代码 Review 报告

- **审查日期：** 2026-11-10
- **审查对象：** 当前工作树（包含未提交的 ADR-0055 / D2-D6 收敛改动）
- **对照文档：** [产品需求 PRD](2026-11-07-metawork-product-requirements.md)、[产品收敛实施计划](2026-11-07-metawork-product-convergence-implementation-plan.md)、[技术实施方案](2026-11-07-metawork-product-convergence-technical-implementation-plan.md)、[ADR-0055](../adr/0055-no-kernel-target-architecture-and-contract-reset.md)、[收敛续作记录](2026-11-08-metawork-convergence-continuation-record.md)
- **状态：** R-01～R-45 已修复；根 lint/build、完整测试、真实引擎记忆计量与 10 个真实 Chrome 套件通过；整体产品发布验收仍未完成
- **提交：** 本轮不提交、不推送，保留在本地供核验

## 1. 结论

当前工作树在 R-01～R-24 的基础上，先以 R-25～R-32 删除本地金额链、Codex 和容器执行实现，建立 fresh-only schema 67，收紧 Manager proposal 与 Router 的边界，保护数据库发布快照并细分每次模型调用及其时间事实；随后以 R-33～R-40 关闭该阶段的遗留失败与缺陷。**删除与契约收敛、Router 与 Memory sidecar 计量（R-41/R-42）以及真实浏览器验收（R-45）均已通过；真实供应商任务与发布级验收仍未关闭，因此不等于 PRD 全面完成。**

R-33～R-40 继续关闭上一轮遗留：提案准备取消的异常映射、fresh schema 缺少的 `retry_wakes.session_id`、Router 提交期执行器可用性重读、用量事实来源身份校验、Span 残留金额字段，以及 40 个文件的陈旧回归（Codex/金额/预准入 Span/Kernel 账本断言）。当前根 `npm run lint`、`npm run build` 通过；完整测试为 **627 文件通过、25 文件跳过；4547 用例通过、71 跳过，0 失败**（`/tmp/metawork-full-4.log`）。

剩余主线是真实供应商与干净安装任务验收，以及发布级验收（签名/公证/DMG、Linux、Feishu）。当前结果继续保留本地，不提交、不推送、不切换用户安装。

## 2. 验证结果

### 2.1 当前工作树的最近验证

| 检查 | 结果 | 范围与证据 |
| --- | --- | --- |
| 根 `npm run lint` | **通过** | R-33～R-40 完成后重跑，退出码 0 |
| 根 `npm run build` | **通过** | tsup、Planner schema、Pi 扩展、PDF 资源与 Web TypeScript/Vite，`/tmp/metawork-build-2.log` |
| 完整 `npm test` | **通过** | 627 文件通过 / 25 跳过；4547 用例通过 / 71 跳过，0 失败，`/tmp/metawork-full-4.log` |
| 最近专项回归 | **通过** | 此前 13 文件 / 3 失败已全部关闭，见 §14 |
| 金额链清理专项 | 该批次通过 | 79 文件 / 737 用例，`/tmp/metawork-no-price-focused-3.log`；后续 Router/时间字段变更后未整体复验 |
| 金额链清理后的 Web 构建 | 该批次通过 | TypeScript / Vite，`/tmp/metawork-web-no-prices.log`；不代表最后一轮修改后的构建 |
| fresh-schema/安装专项 | 该批次通过 | 56 文件 / 329 用例，`/tmp/metawork-fresh-focused-2.log`；后续 schema 67 细化后的检查范围见最近专项 |
| Pi/native 清理专项 | **本轮复验通过** | 曾为 206 文件通过 / 2 失败、1624 用例通过 / 4 失败；旧 Codex fixture 与 `tests/e2e/executor-runtime-parity.test.ts` 已按唯一 Pi 收敛，最新全量见上行 |

### 2.2 历史批次验证（不代表当前工作树）

以下保留原批次证据；其通过结果不覆盖 R-25～R-32：

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `npm run lint` | 通过 | 根 `tsconfig` 类型检查通过 |
| `npm run build` | 通过（修复后） | tsup、Planner schema、Pi 扩展、Web Vite 构建均通过 |
| `npm test`（R-17 后历史全量） | 通过 | 648 文件 / 4788 用例通过、71 用例跳过（24 文件跳过）；包含启动恢复、权限用量、新工具链、固定配置版本归属和无 fork 安装校验回归 |
| Server binding 专项 | 通过 | `tests/server/server-binding.test.ts` 10 项 |
| Memory/Management/Web 专项 | 通过 | 首轮 18 文件 / 257 用例；新增取消与分页变化用例后 service/adapter 35 用例通过；当时全量也已通过 |
| Memory 真实 Chrome 验收 | 通过 | 独立 Tab、分页、完整正文、全部导出、异常/取消、删除翻页、记忆设置直接展开，1440px / 390px 共 3 条流程，最终复验通过 |
| Token 用量真实 Chrome 验收 | 通过 | 无选中会话、图例/分组/自定义日期、乱序响应、空数据/重试；桌面/窄屏和完成答案/报告无逐 Task bill，两条流程通过 |
| npm 依赖审计 | **已修复本轮告警** | 根、Web、Desktop、official-server 四份锁文件均为 0 项；不等于嵌入式 Pi/Memory/系统二进制的完整供应链审计 |
| 干净依赖安装 | 通过 | 根与 Desktop 标准 `npm ci` 通过，包含 SQLite / Electron 安装脚本；Web 由 build 执行 `npm ci --ignore-scripts` |
| 图表/富文档真实 Chrome | 通过 | 最终构建后 2 文件 / 2 流程通过，生产 Server 进程与浏览器；图表导出、DOCX/PPTX/XLSX/XLS/CSV/PDF/HTML、损坏文档、隔离预览 |
| Desktop 类型/构建/测试 | 通过 | `lint:desktop` / `build:desktop` 通过，11 文件 / 28 用例通过；打包筛选与 CommonJS matcher 兼容性回归包含在内 |
| macOS 原生 Electron smoke | 通过 | 隔离安装身份、真实生产 Server/Web 资产，830ms 就绪；认证/无 Node、中文文件与 PDF 保存、1440/1100/900px、200% 缩放、10 次同 PID 重连、renderer 崩溃恢复和退出后服务存活；对话框及下载 HTTP 使用 fixture |

首轮静态清点（非最新修复后重新计数）显示：`src` 仍有约 115 个 `Kernel/kernel_` 语义文件命中，Codex 相关生产/客户端文件约 30 个，Docker 资产至少 6 个，价格/金额相关生产和 Web 文件约 28 个，Planner/TUI 兼容引用仍广泛存在。计数包含注释和兼容层，不能单独作为删除依据，该清点已被后续删除改动部分取代，不再作为当前残留数量或“仍未删除”的证据。

## 3. 修复记录（各项验证边界见正文）

### R-01（高）：Web 生产构建被未使用常量阻断

- **证据：** `npm run build` 在 `web` 子项目 TypeScript 阶段报 `TS6133`，涉及 `src/control/control-contracts.ts` 的三个旧策略常量和 `src/management/execution-projector.ts` 的 `MAX_TIMELINE_DECISIONS`。
- **修复：** 删除已迁移策略留下的未引用常量；保留实际仍由 `src/execution/dispatch-policy.ts`、`failure-retry-policy.ts` 使用的限制。
- **验证：** `npm run lint`、`npm run build` 通过。

### R-02（高）：裸 `metawork` 行为不符合 PRD

- **证据：** `src/cli/args.ts` 对空参数返回 `{ kind: 'tui-retired' }`，`src/index.ts` 只输出“终端界面已移除”提示。PRD AC-2 明确要求裸命令打开 Web。
- **修复：** 空参数现在解析为 `{ kind: 'web' }`，显式 `metawork tui` 仍保留为退役命令诊断；帮助文本同步更新；CLI 回归测试改为验证 Web。
- **验证：** `tests/cli/args.test.ts` 通过；Web launcher 仍要求先有已启动的 Server，启动失败会明确报告 endpoint 错误。

### R-03（高）：非回环部署的 WebSocket allowlist 没有生效

- **证据：** `src/server/server-binding.ts` 已实现 `server.allowedOrigins`，HTTP 请求使用 `isOriginAllowed`；但 `src/management/server.ts` 的 `isAllowedWebSocketOrigin()` 只允许 `http://127.0.0.1|localhost` 加当前端口。配置 `host=0.0.0.0` 与 `allowedOrigins=https://app.example.com` 时，HTTP 可以通过，WebSocket 升级被 403，实时任务/进度/输入全部不可用。官方账号 bootstrap、launch-context、logout 和诊断入口也复用了这条旧判断。
- **修复：** `isAllowedWebSocketOrigin()` 改为统一调用 `isOriginAllowed(origin, binding, requestHost)`；所有调用点传入 Host；诊断消息改为“Origin 不在服务端允许范围内”。
- **验证：** 新增 `tests/management/server.test.ts`：非回环绑定、显式远程 Origin、认证 Cookie 的 WebSocket 握手通过；现有外部 Origin 拒绝用例继续通过。

### R-04（高）：Task Runtime 中断恢复和工作流边界校验缺失

- **证据：** `TaskControlWorkflow` 原先在 `runtime.apply()` 抛出 `ControlApplicationInterruptedError` 时直接结束 drain；当前事件已出队且已进入内存去重集合，却没有调用 `recordUncertain` 或返回 `pendingRecovery`。此外，构造函数接收的 `acceptedEventTypes`/`acceptedActions` 一直没有执行，专用 workflow 可以接受不属于自身边界的事件或决定。
- **修复：** 中断 apply 现在按未确定操作记录 recovery 回调并返回 `pendingRecovery: 1`；事件类型在入队前校验，决定动作在 Runtime apply 前校验，越界请求以 `ControlApplicationRejectionError` fail closed。统一提取 recovery fact 的 task/subtask/attempt 归属逻辑，并在不带 taskId 的动作上回退到 workflow/event 的 task 事实。
- **验证：** 新增 `tests/execution/task-control-workflow.test.ts` 覆盖中断故障注入、事件白名单和动作白名单；协调器、Session Runtime、span recovery 与架构测试共 32 项通过，`npm run lint` 通过。

### R-05（中）：账户级控制协调器永久保留事件上下文

- **证据：** `AccountControlCoordinator` 把初始事件和 Runtime 产生的 follow-up observation 放入 `contexts`，但没有在事件处理完成后删除；工作流的 512 条内存去重上限并不能限制这个 map，长驻账户运行时会持续保留旧的闭包和 Runtime 上下文。
- **修复：** `TaskControlWorkflow` 增加 `onEventSettled` 生命周期回调，在成功、拒绝、中断和异常路径统一释放事件路由上下文；协调器提交层增加 `finally` 清理，覆盖尚未进入 drain 的白名单拒绝。
- **验证：** 协调器、工作流和 recovery 聚焦测试 12 项通过，`npm run lint` 通过。

### R-06（中）：记忆管理缺少独立入口和完整导出

- **证据：** PRD FR-M1 / AC-12 要求独立 Memory Tab 与 memory package；原实现只在高级设置内管理记忆，且没有导出 API。
- **修复：** 新增独立“记忆”Tab，不依赖选中会话；原有搜索、类型/层级/启停筛选、分页、完整详情和删除移入该入口。设置保留开关与模型配置，“记忆设置”直接展开对应部分。新增认证的 `GET /api/memory/export`，账户由 Server 绑定，忽略客户端账户参数。按用户确认采用 `metawork-memory` / `version: 1` JSON，导出所有 L1/L2/L3 启用/停用条目正文、背景、版本与治理元数据，不受当前筛选和页码影响，不包含引擎凭据。
- **边界：** 单次最多 10,000 条、32 MiB JSON；同一 MemoryService 只允许一个引擎扫描，支持用户取消、页面卸载及连接断开取消，拒绝超限、数量变化、重复/缺页，失败不返回部分包。引擎没有快照端口，等数量并发修改不能被完全检测；这是扫描导出，不承诺同一时刻快照。记忆关闭或引擎不可用时不能导出；不会为导出偷偷启动引擎。L0 对话原文不属于管理资产包，也未新增导入能力。
- **验证：** service/adapter/query/HTTP/client 聚焦回归及真实 Chrome 验收覆盖完整跨页导出、账户范围、凭据白名单、停用项、超限、取消、列表变化和错误恢复；最终全量结果见验证记录。

### R-07（高）：跨层级同名引擎 ID 导致资产丢失或详情串层

- **证据：** 列表以引擎 ID 为 Map key，详情也只比对 ID。L1/L2/L3 使用相同 ID 时，列表互相覆盖，L2/L3 详情可能读到 L1 正文。
- **修复：** 去重键改为 `layer:id`，详情同时核验层级和 ID，继续使用账户/层级绑定的本地 memoryId。
- **验证：** 三层同 ID 的列表、唯一治理 ID、详情和导出回归均通过；没有修改持久化 schema。

### R-08（中）：缺少账号级 Token 用量时间线

- **证据：** PRD FR-B1/FR-B2 与技术方案 §7.2/§8.3 要求账户用量，原“账单”入口依赖所选会话并展示逐 Query 金额，无法按日期/模型/Provider 查看。
- **修复：** 新增 Metering owner 的区间解析和 timeline projection、Server 绑定账户的认证 `GET /api/usage/timeline`；页面不依赖会话，支持今日/本周/近 7 天/近 30 天/本月/上月/订阅周期/自定义（最多 366 天）、Total/Included/On-demand、零填充每日堆叠图、模型图例、Provider/Model 分组、完整每日表和手动刷新。北京时间自然日、周一起始、UTC `[from,to)`；BigInt 精确求和。跨账户/孤立事实排除，system 不入用户量，unknown/缺失单独披露，网络错误可重试并防止旧请求覆盖新筛选。对话和轨迹停止渲染/轮询逐 Turn 金额账单。
- **边界：** 本批次最初复用 capturedAt 事实；后续 R-25 删除本地金额链，R-26/R-32 将表纳入 fresh schema 67 并区分 occurredAtUtc/recordedAtUtc。R-22 的流式读取与十万行验证属于此前批次；最新时间字段变更仍有回归待修，完整调用覆盖及生产延迟尚未验收。
- **验证：** API 认证/参数单值/账户注入/错误脱敏，日历/闰日/时区/订阅试用边界、整数精度、分组对账和 SQLite 隔离；真实 Chrome 覆盖桌面/窄屏、图例、日期、空数据/失败重试和乱序响应；完成答案/报告可见且不再有逐 Task bill。

### R-09（高）：官方额度仅累计 Manager，漏算 Executor 等角色

- **证据：** Server quota guidance 与 Manager preflight 调用 `aggregate` 时限定 `agentClassRef: 'manager'`，官方 Executor、记忆等已持久化事实不会扣到同一账号额度。
- **修复：** 新增 Metering `readAccountTokenQuota`，guidance、preflight 和时间线订阅窗口使用同一账号全部 `payer=platform` 事实；自备 Provider 不扣 Included；额度耗尽保持引导语义。
- **验证：** SQLite 同时插入 Manager/Executor/Memory、自备 Provider、system、unknown、其他账号及无上下文事实；官方额度准确累计三个官方角色，并排除其余类别。完整模型调用覆盖仍是独立未关闭目标。

### R-10（高）：Pi 缓存 Token 未进入完整输入量，导致用量与额度低估

- **证据：** 打包主机安装的上游 Pi 1.5.0 的 OpenAI/Anthropic 适配器将 `input` 定义为不含 cacheRead/cacheWrite 的普通输入，`totalTokens=input+output+cacheRead+cacheWrite`。MetaWork 原 Manager/Executor 直接将 input 记为完整输入，却把缓存标记为 input 子集，因此下游只算 input+output 时漏掉缓存。
- **修复：** 两个入口共用 `normalizePiUsage`，完整输入 = Pi input + cacheRead + cacheWrite；缓存仍保留子集标记，reasoning 不再额外计入输出。精确整数支持 BigInt 字符串；可选缓存字段缺省兼容，但显式错误计数使完整输入缺失。Manager RPC 收集层保留这种缺失语义，避免错误缓存被解析成“无缓存”。
- **验证：** 输入 12、输出 5、缓存读 3、缓存写 1 经 adapter → recorder → SQLite → timeline/quota 得到 **21 Token**；重复回调仍只有一次调用。覆盖大整数、蛇形缓存字段、负数/unsafe number/无效缓存和缺失输入；Manager 2100 输入（1200+800+100）、300 输出的缓存/推理子集均正确。
- **历史边界：** 旧事实缺少可靠上游版本/语义证明，不自动重算；不能将这次入口修复当作历史计量已校准。

### R-11（高）：Web 依赖树包含已知 XSS 等漏洞

- **证据：** 初始 Web 审计报告 6 项漏洞（3 moderate、2 high、1 critical），涉及 DOMPurify、ECharts、Vite、source-map-js，以及 ExcelJS 的旧 uuid 依赖。审计严重度并不等于已证实生产可利用，但 Markdown/图表/文档预览处理模型及外部文件内容，应更新到已修复版本。
- **修复：** DOMPurify 3.4.17、ECharts/zrender 6.1.0、Vite 6.4.6、source-map-js 1.2.2；保留 ExcelJS 4.4.0，并仅在其依赖范围 override uuid 11.1.1。核对 ExcelJS 唯一调用为 CommonJS `v4()`，不降级文档库或全局替换其他依赖。
- **验证：** Web 审计 0 漏洞；lint/build 通过，图表规范/预览控制/加载及 XLSX 兼容专项 4 文件 / 35 用例通过。新增回归实际写入 extended dataBar 规则、校验不同 UUID v4 并读回中文/数值/条件格式。真实 Chrome 及最终全量结果见本批次验收记录。
- **边界：** 这是 Web 锁文件的当前审计结果，不能据此宣称根项目、official-server 或整个供应链均无漏洞。

### R-12（阻断启动）：启动恢复查询了不存在的配置版本列

- **证据：** 实际 `dist/index.js server start` 的隔离安装启动直接退出，报 `SqliteError: no such column: configuration_revision`。`loadRecoveryConfigurations()` 仍按旧账本列查询 `task_recovery_items`，但 D6 recovery owner 将版本固定在 `decision_json.configurationRevision` 中；即使没有任何恢复项，也会在 SQL prepare 阶段失败。原专项 fixture 未注入生产配置 resolver，因此没有执行到此查询。
- **修复：** `TaskRecoveryItemRepo` 提供未完成操作的去重版本列表，启动服务与 active graph 的固定版本合并读取；包含 `pending` 和 `retry_authorized`，排除 `assumed_applied`。缺少版本、错误 JSON 或 resolver 返回版本不一致均拒绝恢复，不降级到当前配置。不新增列、迁移或第二份版本事实。
- **验证：** 新增带生产 resolver 的空账户完整初始化，以及 active graph/未完成操作重复版本、已授权重试、已结算排除、缺失版本和快照不匹配用例；恢复专项 2 文件 / 19 用例通过。真实生产进程启动与浏览器结果见本批次验收记录。

### R-13（高）：根项目生产及测试/构建依赖存在已知漏洞

- **证据：** 首轮直接依赖更新后，根锁文件审计仍有 18 项（6 moderate、9 high、3 critical）；涉及 MCP HTTP 依赖、旧 Vitest/mocker/tinypool、Vite 和构建工具的 esbuild。审计分级是依赖风险，未据此声称所有漏洞均已在生产可利用。
- **修复：** MCP SDK 1.32.2、js-yaml 4.3.2、nanoid 5.1.16、zod 4.6.7；更新兼容范围内的传递依赖。Vitest 4.1.12 + 显式 Vite 6.4.6，tsup 9.0.0 使用 esbuild 0.28.2，避免旧 esbuild 漏洞；Node 22.23.3 完整验证。Span 集成 smoke 显式选择 default reporter，避免 Vitest 在 agent 环境自动选择 minimal reporter 后吞掉成功样本，误报集成失败。
- **验证：** 根审计 0 项，标准 `npm ci` 成功，lint/build 和最终全量 647 文件 / 4774 用例通过；Span 彩色/普通输出与工作流专项 12 用例通过。依赖更新阶段绕过 npm 10 optional-peer resolver 的 `edgesOut` 错误生成锁文件，最终安装不需要 `--legacy-peer-deps`。

### R-14（高）：Manager 权限判定的 BYOK 用量被记入官方额度

- **证据：** `server-composition.ts` 权限回调直接使用 `configuredUsagePayer`，默认是 platform；常规 Manager/Executor 已按 provider 所有权判定付款方。用户自备 Provider 的权限判定调用会被错误计入 Included。
- **修复：** 抽取 Server 的 `createManagerPermissionUsageRecorder`，复用常规模型调用的 `resolveUsagePayer(providerRef)`；保留 requestId 命名空间、Query/Task 归属、配置版本和幂等键。
- **验证：** SQLite 集成模拟 BYOK 和官方各 12 输入 + 5 输出，重复 BYOK 回调一次，最终 2 次调用、Included 17、BYOK 17 Token；不同权限请求复用上游 callId 不碰撞。权限上下文与记录专项 2 文件 / 11 用例通过，并纳入全量。
- **后续：** 此项统一了现有所有权策略；随后 R-16 继续修复按固定配置版本判定归属和 Manager preflight 的 Provider 选择。

### R-15（高）：Desktop 独立锁文件仍携带 Electron 与工具链漏洞

- **证据：** 根/Web 更新不会改变 Desktop 的依赖树。Desktop 审计发现 15 项（10 moderate、3 high、2 critical），包括 Electron 44.5.1 的 eMudhra 中间证书信任问题、旧 Vitest 及 undici 等传递依赖。
- **修复：** Electron 44.10.2、electron-builder 26.18.0、Vitest 4.1.12、Vite 6.4.6；更新 fast-uri/undici 等。最新版 builder 的 minimatch 仍在告警区间，因此只在 `app-builder-lib` 和 `@electron/universal` 范围 override 到 11.0.1，保留旧 glob/asar 所依赖的其他 minimatch 主版本。
- **验证：** Desktop 审计 0 项，标准 `npm ci` 包含 Electron 二进制安装成功；类型检查、构建和 11 文件 / 28 用例通过。新增真实 FileMatcher 检查中文路径、目录递归、隐藏凭据和私有目录排除，并验证 universal 所用 CommonJS named matcher；原生启动验收见本批次记录。
- **边界：** macOS arm64 本地验证不替代 Developer ID 签名、公证、DMG、独立原生架构和干净发布包验收。

### R-16（高）：配置热更新会改变在途调用的付款归属，BYOK 还会收到官方额度提示

- **证据：** `resolveUsagePayer` 直接读取活动配置。同一 Provider ID 的 `systemManaged` 在热更新前后改变时，旧版本发起的 Manager/权限/Executor 调用会按新配置扣减或漏计 Included。Manager preflight 仅检查全局默认 payer，没有检查实际所选 Provider，自备调用也可能收到额度耗尽提示。
- **修复：** Metering 提供带必填配置版本的归属 resolver；Manager 用 planning context 固定版本，权限用 Attempt 配置，Executor 的 Span/观测用授权绑定版本。不存在的版本/Provider 记录 unknown，不回退活动设置或默认 payer。历史 snapshot 加载进入 runtime cache，校验请求版本且不改变 active；恢复、权限和执行共享。Manager preflight 复用实际 `selectManagerModel`，每次清除旧提示，只对官方调用读取额度；仍为非阻断引导。
- **验证：** SQLite 证明热更新后旧 BYOK 权限调用与新官方调用分别 17 Token，Included 仅 17；Conversation 模拟设置在回调前激活，晚到用量仍以旧版本记入 BYOK。Executor 同时核验 Span/观测传递固定版本。固定/auto 模型选择、BYOK 的 planning/permission 跳过额度读取、双向 ownership 变化、缺失事实与错误 snapshot 版本均有回归；最终全量见本批次记录。
- **边界：** 不自动重算已错误归属的历史数据；此批次当时尚未修复的初始 Span 默认 payer 已由 R-21 改为 unknown；权威 Token 事实按固定版本解析。完整模型/后台调用覆盖和旧金额链删除仍保留为 F-07/F-03。

### R-17（高）：无 fork 安装仍被旧产物探测和元数据必填校验阻断

- **证据：** `BuildSourceMetadata.plannerRoot` 和安装输入已是可选字段，但 `assertBuildSourceMetadata` 仍无条件要求非空字符串；省略 fork 的写入/读取均失败。生产配置探测同时只查旧 `planner/.../cli.js`，不认识 Manager 实际使用的 packaged Pi；不带 fork 的安装和配置激活会被错误拒绝。新增回归在修复前分别复现元数据错误和 `Planner artifact is missing`。
- **修复：** 可省略 `plannerRoot`，明确提供时仍要求非空字符串；配置探测接受 `resolveExecutorTool('pi', { releaseRoot })` 实际解析到的可执行普通文件，不用 PATH 上存在全局 Pi 代替发布产物。既有 fork 探测在此批次尚未删除，后续 R-20 已移除。
- **验证：** 无 fork、无模型凭据的源安装在临时目录完成配置/数据库/应用指针激活并保存正确来源元数据；仍拒绝重复安装。覆盖既有元数据读写、错误字段、缺失 Pi、非可执行文件和同名目录。安装/更新/配置探测专项 **4 文件 / 56 用例通过**，lint/build 通过；该批次全量见后文历史记录。
- **边界：** 安装回归的 Pi wrapper 是产物 fixture，不代表完整上游 Pi、依赖和模型任务验收。本批次尚未修复的 Desktop/source/release fork 步骤已由 R-18 替换；完整任务和 F-02/F-05 的剩余契约仍未关闭。

### R-18（高）：开发、原生安装与发布仍构建已删除的 Pi fork

- **证据：** Desktop/native/release 的准备分支仍对不存在的 `planner/AnyFusion-Pi` 执行 npm/build；归档、安装器与签名 Desktop payload 仍要求 Planner 产物，干净路径失败。
- **修复：** 共用 `scripts/lib/packaged-pi.mjs`，从固定上游 Pi release 验证版本、lock SHA 和 package bin 后打包可搬移的运行时；入口由 package bin 读取，适配上游 1.5.0 的 `dist/bundle/cli.js`。wrapper 用 Desktop sibling Node 或受支持 host Node，运行时不查全局 Pi。native/source/Desktop/setup/release、安装器、资产校验与 Desktop 签名包统一携带 Pi；不要求 fork 路径。新增 `tools/pi-runtime` 精确锁文件及独立 CI 打包 host，拒绝覆盖既有安装目录。
- **验证：** release/install 专项 20 文件 / 155 用例通过；实际 package subprocess 生成无 fork 归档，覆盖搬移、空格路径、host 删除、sibling Node 和篡改拒绝。实际 upstream Pi 在隔离 HOME 下完成 Manager RPC、权限 extension 与 Executor JSON 进程；本地 SSE 模型 fixture 提供 17 输入/3 输出，Manager 只注册提案工具。最新单独真实 Pi 验收 1 用例通过。
- **边界：** 未调用外部付费模型或读取个人 auth；本地 HTTP fixture 不等于完整 Task 图或供应商验收。签名/公证/DMG、Linux 和干净机器任务门尚未关闭；CI 已接线，未声称远端 CI 已运行。

### R-19（高）：去重提前返回、失败后丢重试及空 drain 入队竞态

- **证据：** 事件入队就被标记“已记忆”，并发重复提交可提前得到空成功；snapshot/policy 失败后相同 ID 无法重试；中断的不确定状态可能被已应用缓存挤掉。空恢复 drain 结束瞬间入队还可能跟随旧 promise 提前返回。
- **修复：** 区分 queued/applying/applied/uncertain；并发调用共享 drain，apply 前失败释放身份，不确定外部效果保留 fence 并报告 pendingRecovery。仅已应用状态参与 512 项淘汰，recovery writer 失败也保留 fence。先登记共享 promise、再 drain，并在完成前处理新入队事件。
- **验证：** workflow 10 项故障/并发回归通过，包含 520 条后不确定状态保留、recovery writer 抛错及空恢复结束竞态；Runtime/协调器与最终全量复验通过。
- **边界：** 不确定操作不自动重放；实例内 fence 不是持久幂等账本。恢复 owner 解决后的在线清理和完整重启旅程仍需独立验收，不重新引入 ledger。

### R-20（高）：新安装生成 Codex 默认执行器且 fork-only 可伪装就绪

- **修复：** source installer 不再探测全局 Codex/Pi 或生成 Codex harness；创建使用 packaged Pi 的 engineering/research 默认类，保持独立 harness 开关。移除默认模型价格。Manager readiness 只认 resolver 返回的可执行普通 Pi 文件，旧 fork 文件不能满足准备条件。
- **验证：** 配置、真实临时目录安装/更新/回滚回归通过；没有外部工具也可准备 Pi，fork-only / 缺失 / 不可执行 / 同名目录均拒绝。
- **边界：** 只关闭源安装默认值与准备探测缺陷；其他生产配置/schema/driver/discovery/UI 的 Codex 删除仍属于 F-02。

### R-21（中）：尚未选模型的准入 Span 使用部署默认付款方

- **修复：** admission 生命周期占位 Span 改为 `payer=unknown`；配置默认 payer 不构成实际调用证据，不制造 Token fact。实际模型观测继续按 R-16 的固定版本归属。
- **验证：** platform / user_direct 两种部署默认均无法将该占位 Span 标为 Included/On-demand；对应 billing 回归通过。
- **边界：** 旧 Span/金额链仍在；不将此修复描述为模型全调用覆盖或历史校准。

### R-22（中）：时间线和额度查询一次物化全部事实

- **修复：** Metering SQLite adapter 提供迭代读取；时间线和额度聚合直接逐行精确求和，不再生成整个区间的事实数组。保留原账号 EXISTS 过滤与半开区间，内存 adapter 可继续使用原 list port。missingCalls 与时间线统一包含缺失输入/输出的调用。
- **验证：** 100,000 条 SQLite 事实、超过 JS 安全整数的输入值，精确汇总、每日分组和另一账号零泄漏全部通过；测试令 list port 抛错，证明生产走迭代路径。
- **边界：** 此批次当时仍按 capturedAt；R-32 已改为 occurredAtUtc，尚待完成回归。耗时仍随行数增长，同步 SQLite 聚合可能占用事件循环；这不是生产延迟 SLA 或数据库分组聚合验收。

### R-23（高）：生产 Router 的 freshness 回调没有重读 owner

- **证据：** account composition 将 `readCurrentRequest: () => request` 传给 Router，模型等待期间 Task 取消、graph/configuration/candidates 变化无法触发事务内拒绝；没有绑定时还退回旧 suggested binding。
- **修复：** 提取 account route adapter，由同步 owner 读构建当前请求；append 事务内再次检查 Task 存活、generation/revision/configuration、Subtask 和候选快照。空候选持久化 no-candidate，不回退旧绑定；已选绑定消失则拒绝派发。
- **验证：** 生产使用的 adapter 配合真实 SQLite route repository 覆盖取消/删除 Task、generation/graph/configuration、候选变化及删除 Subtask；全部拒绝晚到决定且表内零记录。正常路径证明 owner 读发生在事务内。Router/相关专项 12 文件 / 147 用例通过。
- **边界：** 修复的是生产落库接线；Manager 候选绑定 schema、路由资格来源和完整 dispatch/launch/recovery 语义门仍属于 F-01/F-05。

### R-24（高）：重复调用可将另一 Provider/模型的 Token 混入已有归属

- **证据：** `recordModelUsageFact` 原只固定 query/role/payer；同一 call key 携带不同 Task、Provider、model 时会更新 Token 数值，却保留旧 Provider/model 标签，时间线模型分组因而错误。
- **修复：** 将 Task、Provider、model 一并纳入不可变调用身份，冲突在 upsert 前拒绝；合法同身份增量仍可更新 Token。
- **验证：** query/task/provider/model/role/payer 六种身份冲突均拒绝且原事实完整不变；metering 与 recorder 专项 7 文件 / 69 用例通过。没有 schema 变化或历史事实重写。

### R-25（高，已实现/批次专项通过）：删除本地金额计费链

- **交付：** 删除本地模型价格/成本、逐 Query 金额账单的服务、仓储、配置、API 和 Web 组件；Auto policy 更新为 v3，OpenRouter cache 更新为 v2。官方账号订阅与支付金额保留在 `official-server`。
- **验证：** 清理专项 79 文件 / 737 用例通过，Web TypeScript / Vite 构建通过。以上在后续 Router/时间字段修改前执行，不能替代最新全量回归。
- **边界：** Router 的旧 Span usage 类型/解析仍有 cost 字段待清理；全仓文档残留和完整调用覆盖未关闭。

### R-26（高，已实现/后续修改待整体复验）：fresh-only schema 67 与写前拒绝

- **交付：** `current-schema.ts` 成为唯一 fresh DDL；删除历史 SQLite `migrations.ts` 和数据库升级事务实现。启动、更新、回滚预检拒绝非当前库；校验 schema 对象数量及实际 DDL，拒绝缺失、额外对象和伪造当前版本。Metering 表/index 纳入 fresh DDL，删除 Metering constructor 与 retry-wake 的运行中 CREATE/ALTER 补丁。
- **验证：** fresh-schema/安装批次 56 文件 / 329 用例通过；后续 DDL 细化及 schema/快照测试包含在最近专项中，最新完整测试尚未执行。
- **边界：** 不迁移已有 schema 66/旧库，也不自动改写已安装数据库；prepared recovery / previous pointer 指向旧库的针对性验证仍需补齐。

### R-27（高，已实现/回归待收敛）：唯一 Pi 与 native 执行边界

- **交付：** 删除 Codex driver、配置 schema、catalog、发现和 Web 展示；只接受支持的 Provider protocol，并在读取凭据前拒绝未知值。doctor 以 packaged Pi 为准。删除容器执行适配器，配置/backend 收敛 host-only。
- **验证：** Pi/native 清理批次为 206 文件通过、2 文件失败；四个失败来自旧 Codex fixture，已调整但尚未重跑该整批。当前 lint 通过。
- **边界：** `docker_socket` 的 HARD_DENY 保留为安全拒绝规则，不是可用的容器执行路径；官方服务部署资产另属边界。真实供应商与干净安装验收仍未完成。

### R-28（中，已实现/待完整复验）：移除 TUI facade 与权限投影耦合

- **交付：** 删除退役 TUI facade，权限投影归入 account service；不增加第二交互表面。内部 `MetaClaw`/`Metaclaw*` 及有归属的 AnyFusion 兼容名称按仓库约定保留。
- **验证：** 当前根 lint 通过；最后修改后的完整客户端/脚本扫描、构建及回归尚未完成。

### R-29（高，已实现/取消回归未通过）：Manager 只提案，准入只保留资格池

- **交付：** Manager proposal 类型与 strict schema 删除 `executorBindings`/`modelSelection`；候选来自固定配置中 enabled、local-cli、pi-cli 且能力满足的类与模型，保留全部硬资格候选，采用 `router-hard-eligibility-v1`。Runtime `Subtask.executorBindings` 表示资格池，不是 Manager 选择。延迟绑定改为按 Subtask ID 索引，并校验精确键与配置 pin。
- **交付：** 删除 Session/recovery 的预准入 Span evaluator 接线及 `span-plan-preparation`；保留真正 dispatch Router 需要的模型适配器。原 Session 测试改为提案准备集成测试。
- **验证：** 最新专项中的 plan-admission、deferred storage 通过；提案准备集成测试有两个取消场景失败，尚未确认并关闭生产行为与测试预期的差异，不能标记本项验收完成。

### R-30（高，已实现/策略链待验证）：实际模型身份、失败排除与无默认路由

- **交付：** account route adapter 读取固定配置及 attempts，传递实际 `modelId`；同 Task/Subtask/generation/graph 的已失败绑定按 fingerprint 排除，提交时重读事实。模型评估异常或 evaluator 缺失时不按字典序/首个候选默认选中。失败策略支持同路由最多两次 retry；耗尽后进入 Router/no-candidate 链。continuation / contract correction / merge repair 保持来源绑定。
- **验证：** 最近 account-router / span-router 专项通过；完整失败重试、同 Agent 多模型、continuation/repair 行为仍需补充验证。
- **边界：** dispatch 阶段 health/capability 等实时资格尚需完整重读；retry policy 中仍有 `nextUsableBinding` 占位选择，须核对其与唯一 Router 语义一致；独立 route 轨迹仍有旧 Span 投影待清理。

### R-31（高，专项通过）：数据库快照不得覆盖已有目标

- **交付：** 只读预检源库，解析父目录别名，拒绝已有备份/clone（包括悬空软链接及硬链接）；先写 staging 并校验，再用 `COPYFILE_EXCL` 发布。异常只清理本次创建的文件，finally 回收 staging。
- **验证：** 最新专项内 `tests/installation/database-release-snapshot.test.ts` 七项全部通过，覆盖普通文件、软链接、硬链接、悬空软链接不覆盖，源库/WAL 保持、旧库拒绝及部分 schema 拒绝。

### R-32（高，已实现/一项集成断言失败）：逐调用用量与发生/落库时间分离

- **交付：** Executor call key 从单个 attempt 的公共 ID 改为 `attemptId:usage.callId`，避免同一 attempt 多次调用合并。事实增加 `occurredAtUtc`、`recordedAtUtc`、`sourceId`、可空 `providerResponseId` 和 `normalizationVersion`；时间线和额度按 occurredAtUtc 查询/归日。缺失量保留 NULL 并标记 `provider_unavailable`，不补零。
- **时间语义：** occurredAtUtc 使用适配器观测到的调用完成时间；没有 Provider 原始时间时，不宣称它是供应商事件时间。recordedAtUtc 是本地记录时间，upsert 保留首次时间。
- **验证：** 根 lint 通过；最近用量集成有一项元数据断言失败，涉及新版本/source/responseId/recordedAt 预期，待修后复验。跨天晚到、同 attempt 多 call 的专门回归仍需补充。
- **边界：** 不重算历史数据；Router 决策模型计量已由 R-41 补上，Memory sidecar 的实际调用仍未接入。

## 4. 高优先级未完成目标与架构漏洞

### F-01（部分修复，owner 语义待贯通验收）

ADR-0055 D6 接受 `TaskControlWorkflow` / `ControlLoopPolicy` 进程内生命周期 facade，禁止第二语义解释器、持久账本重放或 Router 二次审批。R-29 已移除 Manager 提案选择字段，R-30 收紧 dispatch 决定；当前需验收完整失败/重试/恢复/发布旅程及动态资格变化，不再以 facade 名称或 Runtime 资格池本身判定架构违规。

### F-02（代码清理已实施，唯一 Pi 验收未关闭）

旧报告列出的 Codex driver/schema/catalog/discovery/Web 路径已在 R-27 删除；R-18 已完成 packaged upstream Pi 交付接线与隔离进程验证。剩余是重新跑完受影响回归、扫描残留可达入口，以及干净机器 Manager→Router→Executor 真实任务验收。不能继续将已删除文件列作现存缺陷，也不能以删除完成替代发布通过。

### F-03（本地金额链已删除，残留字段与计量覆盖未关闭）

R-25 已删除本地价格/成本/逐 Query 金额配置、表、服务、API 与 UI，相关批次专项及 Web 构建通过。Router 旧 Span 类型/解析中的 cost 字段与文档仍需清理；官方订阅/支付金额保留在 `official-server`。全角色实际模型调用计量是 F-07 的独立目标。

### F-04（native-only 已实施，删除清单与发布门待复验）

R-27 已删除容器执行适配器并收紧 host-only 配置/backend，本地 Docker 资产已分批删除；旧报告中的资产清点已失效。仍需复核 scripts/CI/测试/文档与原生发布包。`docker_socket` HARD_DENY 是拒绝规则，应保留；官方服务 Docker 不属于本地执行删除范围。

### F-05（提案/TUI 清理已实施，取消行为及 Router 轨迹待完成）

R-28 删除 TUI facade，R-29 删除 Manager binding/model selection 与预准入 Span，R-30 禁止评估失败后默认选路。当前提案准备取消有两个失败回归；真正 Router 仍用 SpanRoutingAdvisor 网络适配，旧配置分支、命名和轨迹投影尚未完全收敛，必须逐项替换并验证，不能直接删除可达适配器。

### F-06（原去重缺陷已修复，恢复旅程待验收）

R-19 已修复并发 drain、apply 前失败重试与空 drain 入队竞态；中断操作保留 recovery fence。实例重建后的 owner 恢复、已解决操作在线清理与 prepared update/rollback 的数据库 pin 仍需专项验收。

### F-07（页面已交付，完整 Token 事实未验收）

Memory v1 JSON 导出、账号 Token 时间线及缓存/全角色额度已完成此前本地验收。R-32 新增调用来源、归一化版本和独立时间字段，替代旧 capturedAt 归日描述，但最新集成仍有一项断言失败。Router 的每次真实调用（包括失败/超时）和 Memory sidecar 用量尚未完整接线，不能宣称全调用覆盖；来源身份冲突、跨天晚到、同 attempt 多 call 回归仍需补齐。十万行回归不代表生产查询延迟 SLA；正式额度档位/供应商目录、真实供应商对账仍需验收。

### F-08（文档状态已校正，全仓一致性仍开放）

本次更新修正报告、续作记录、索引及核心现状说明，不把历史通过当作最新通过。当前 fresh-only schema 为 **67**，删除历史 SQLite 升级链，不自动迁移旧库。长文中的旧 schema/Planner/TUI/Span/金额/容器叙述、失效链接与阶段目标仍需逐项核对；历史批次保留当时证据，不作为当前权威。

## 5. PRD 验收矩阵

| AC | 当前判断 | 证据/说明 |
| --- | --- | --- |
| AC-1/2 | **AC-2 已修复；AC-1 清理待复验** | 裸 CLI 打开 Web；TUI facade 已删除，完整入口/脚本扫描待收尾 |
| AC-3 | 部分 | Linux Server 路径存在；发布矩阵与实际 Linux 验收未完成 |
| AC-4 | 部分/待验收 | vendored fork 已删除，upstream Manager/Executor 交付与隔离进程已验证；缺完整 Task/签名干净安装验收 |
| AC-5/5b | 代码清理已实施/待验收 | Codex driver/配置/catalog/Web 已删除；受影响整批回归及干净机器真实任务待完成 |
| AC-6 | 部分 | 本地模型价格已删除；Router 旧字段/配置分支残留待核对 |
| AC-7/8 | **页面已验收；删除链待最新复验** | 账号 Token 时间线已交付；本地金额表/API/配置/UI 已删除并有批次专项；后续时间字段变更尚未全绿 |
| AC-9/10/11 | 部分 | 角色/缓存/固定版本归属已修；完整调用覆盖、正式额度/目录和官方 Key 边界待端到端验收 |
| AC-12 | **本地实现并验收** | 独立 Memory Tab、完整详情、筛选分页、版本化 JSON 全部导出；边界见 R-06 |
| AC-13 | 部分 | Router 失败排除/重试已有改动；动态资格、完整重试/恢复与用户轨迹待验收 |
| AC-14 | 未验收 | 订阅/环境规格档位缺少统一产品验收证据 |
| AC-15/16 | 部分修复 | Manager strict schema 已删除 binding/model selection；独立 Router decision 与旧 Span 轨迹收敛待完成 |
| AC-17 | 部分/待集成验收 | 直接准入/D6 已有测试；新提案取消有两个失败用例，真实 dispatch 旅程待验收 |
| AC-18/19/20 | 部分 | 结果/权限安全链存在；Manager 汇总与权限真实流程待验收 |
| AC-21～26 | 部分 | fresh schema 67、金额/Codex/TUI/容器删除已分批实施；模块/文档逐项清单未完成 |
| AC-27/28 | 清理已实施/待复验 | native-only 与本地容器资产删除已有改动；拒绝 docker_socket 的安全规则保留 |
| AC-29 | 未验收 | 历史 macOS/Desktop/依赖审计通过；最新全量有待执行，Linux/干净发布包无证据 |
| AC-30/31/32 | 部分修复 | HTTP/WebSocket allowlist 已统一；真实反代/远程浏览器待验收 |
| AC-33/34 | 部分修复 | TUI facade/预准入 Span 已移除；旧配置/命名/文案和实际 Router 适配待收敛 |
| AC-35～37 | 按计划延期 | 执行期插话/改向按实施计划延期，不列为本轮回归缺陷 |

## 6. 后续修复顺序

已完成（R-33～R-40，见 §14）：

1. ~~修复/核对最近三项失败：提案取消两个场景、Pi 缓存用量元数据断言；重跑 Pi/native 受影响整批。~~
2. ~~补 Router 动态资格与失败两次 retry 后重选/no-candidate 的行为回归；核对 retry 占位选择语义。~~ 同 Agent 多模型与 continuation/repair 的来源绑定回归见 §14 边界。
3. ~~完成用量来源身份约束、跨天晚到与同 attempt 多调用验证；清理残留 cost 字段。~~ Router 决策模型计量见 R-41；Memory sidecar 仍未接线。
4. ~~补更新/回滚恢复 pin 与旧库写前拒绝回归，核对 schema 67 与所有仓储/安装路径。~~
5. ~~完成根 lint/build/完整测试。~~ 客户端真实浏览器与 Desktop 重验仍需单独执行。
6. 单列真实供应商、Feishu、签名/公证/干净机器和 Linux 验收，未取得证据前保持未验收。
7. ~~为 Router 决策模型与 Memory sidecar 的实际调用接入计量（query 归属、payer、source identity）。~~ 见 R-41/R-42；正式额度档位与供应商对账仍需产品确认。

## 7. 本轮状态

报告现记录 R-01～R-40。R-25～R-32 是删除与契约收敛批次，R-33～R-40 关闭其遗留失败与新增缺陷。**当前根 lint/build 与完整测试通过（627 文件 / 4547 用例通过，0 失败），整体 PRD 与发布验收仍未完成。** 历史全绿、fixture 流程和本地删除均不能替代真实任务与发布验收。本次仅本地修改，不提交、不推送，不切换用户安装。

## 8. 2026-11-10 Memory 修复批次验收

§8～§12 为历史批次记录，保留当时结果；§13 记录 R-25～R-32 阶段快照，当前工作树状态见 §1、§2.1 和 §14。

- **批次状态：** R-06 / R-07 本地实现完成并验证；整体 PRD 收敛仍在进行。
- **产品确认：** 用户选择版本化 JSON；技术方案 §8.2 已补齐范围和格式。
- **验证：** `npm run lint`、`npm run build`、`git diff --check` 通过；最新 `npm test` 为 **644 文件 / 4738 用例通过，70 跳过**。最终 Web 构建后单独运行 `RUN_BROWSER_E2E=1 npx vitest run tests/e2e/settings-workbench-browser.test.ts -t 'memory|asset on the last'`，**3 条通过、其余 8 条未选择**；真实 Chrome 覆盖 1440px 桌面和 390px 窄屏。浏览器采用管理 API fixture，不代表已对生产 TDAI 实例或干净机器发布包完成验收。
- **同步文档：** ADR-0049、CONTEXT、技术概览、技术实施方案、文档索引和续作记录。
- **关闭日期：** 2026-11-10（本批次）；**closing commit：不适用，遵循用户要求，不提交、不推送。**
- **剩余主线（该批次结束时）：** 唯一 Pi 执行器、Token 用量页面与金额链删除、Manager/Router 契约与真实任务验收、剩余资产清理；不能以本批次或全绿测试宣称整个产品已经完成。

## 9. 2026-11-10 Token 用量与计量修复批次验收

- **批次状态：** R-08 / R-09 / R-10 本地实现并完成验证；整体 PRD 尚未验收。
- **交付：** 账号 Token 用量时间线、全部官方角色 quota、Pi 缓存归一化；旧金额链删除未关闭。
- **验证：** 专项 8 文件 / 162 用例通过（新增 Manager RPC 错误缓存用例包含在随后全量中）；真实 Chrome 两条流程通过，11 条未选择，1440px / 390px；lint/build 通过。最终全量 **645 文件 / 4768 用例通过，71 用例跳过（24 文件跳过）**。
- **同步文档：** ADR-0055 检查点、CONTEXT、技术概览、技术实施方案、文档索引和续作记录。
- **关闭日期：** 2026-11-10（本批次）；**closing commit：不适用，只保留本地修改，不提交、不推送。**

## 10. 2026-11-10 安全依赖、启动恢复与 Desktop 验收批次

- **批次状态：** R-11～R-15 本地修复并验证；不代表整体发布通过。
- **交付：** 修复 Web、根服务与 Desktop 依赖漏洞；生产 Server 启动恢复不再执行无效 SQL；权限判定调用按 Provider 归属记录 Token；更新测试工具链，并保留 Span smoke 的可解析输出。Desktop 打包筛选新增真实 matcher 兼容性检查。
- **安装与审计：** 根、Web、Desktop、official-server 四份 npm 锁文件审计均为 **0 漏洞**；根和 Desktop 标准 `npm ci` 通过，包含 SQLite/Electron 安装脚本。该结果不涵盖嵌入 Pi、Memory 引擎和 OS 全部供应链。
- **验证：** 根 lint/build 通过；本批次全量 **647 文件 / 4774 用例通过，71 跳过（24 文件跳过）**。Desktop lint/build、**11 文件 / 28 用例**通过。生产 Server 进程的图表/富文档真实 Chrome **2 条流程**通过；预览覆盖中文、损坏文件和隔离边界。
- **原生 Electron：** 隔离安装身份与生产 Server/Web 资产下，**830ms 就绪**；认证桥、renderer 无 Node、中文文件/PDF 保存、1440/1100/900px、200% 缩放、10 次同 Server PID 重连、renderer 崩溃恢复、退出后 Server 存活均通过。保存对话框及下载 HTTP 使用 fixture。最初 smoke 的 releaseId 不匹配来自临时 harness 在 Server 启动后才建立安装身份，修正 fixture 后通过；不是绕过生产版本校验。
- **证据：** `/tmp/metawork-review-full-test-final.log`、`/tmp/metawork-review-browser-final.log`、`/tmp/metawork-desktop-smoke-final.log`；本地 `.tmp/review-desktop-evidence/electron-smoke.json` 保存原生验收明细。以上为本地证据，不纳入发布资产。
- **剩余：** 原生 smoke 不替代签名、公证、DMG、干净机器安装、Linux 和真实模型任务验收；四份审计为当前锁文件快照。R-16 继续修复配置版本归属，见下一批次。
- **完成日期：** 2026-11-10；**closing commit：不适用，仅本地修改，不提交、不推送。**

## 11. 2026-11-10 固定配置版本的用量归属与额度提示修复批次

- **批次状态：** R-16 本地完成并验证；整体 PRD 收敛继续进行。
- **缺陷与交付：** 同一个 Provider 在自备/官方之间切换时，Manager 延迟回调、权限调用和 Executor 均按调用固定的 `configurationRevision` 解析 payer；恢复及仅权限调用可加载历史配置且不改变活动配置。缺失 Provider/版本或返回错误版本时保留 unknown，不回退当前配置。Manager planning/permission 预检复用实际模型选择规则，仅官方调用读取 Included 额度，并清除旧提示；BYOK 不再显示官方额度耗尽提示。
- **验证：** SQLite 回归证明旧 BYOK 与新官方调用分别计 17 Token，Included 只累计官方的 17；Conversation 在设置激活后收到旧回调仍计入 BYOK，Executor 的 Span 与用量传递固定版本。覆盖固定/auto 模型、两方向归属切换、缺失事实、错误版本和历史加载不改变活动配置。最终聚焦 **5 文件 / 63 用例**通过，Executor/Manager 等此前聚焦 **6 文件 / 112 用例**通过。
- **最终检查：** `npm run lint`、`npm run build` 通过；该批次全量 **648 文件 / 4783 用例通过，71 跳过（24 文件跳过）**，日志 `/tmp/metawork-review-full-test-pinned-payer.log`。上一批次 Electron smoke 在 R-16 之前执行，不作为 R-16 后的重新验收结果。
- **边界：** 不改写历史错误归属；本批次当时的初始 Span 默认 payer 问题已在后续 R-21 修复，权威 Token 事实按固定配置解析；完整模型/后台调用覆盖仍待专项验收。没有 schema 改动。
- **同步文档：** ADR-0055 检查点、CONTEXT、技术概览、技术实施方案 §7.2、续作记录及文档索引。
- **完成日期：** 2026-11-10；**closing commit：不适用，遵循本地核验要求，不提交、不推送。**

## 12. 2026-11-10 无 fork 安装契约修复批次

- **批次状态：** R-17 本地完成并验证；累计十七项修复，整体安装/发布收敛尚未完成。
- **交付：** 来源元数据可省略 vendored Planner 路径，显式错误值仍拒绝；配置探测检查 Manager 实际解析的 managed Pi 可执行普通文件，不再只接受旧 fork。没有引入全局 Pi 回退或修改 schema。
- **验证：** 修复前新增用例分别复现元数据校验失败、无 fork 安装被产物探测拒绝；修复后安装/更新/配置探测 **4 文件 / 56 用例**通过，包含真实临时目录的应用/配置/数据库指针激活。Pi wrapper 使用 fixture。lint/build 通过，最终全量 **648 文件 / 4788 用例通过，71 跳过（24 文件跳过）**；日志 `/tmp/metawork-review-full-test-forkless-install.log`。
- **边界与文档：** 此批次当时遗留的 fork 构建脚本/兼容探测已由 R-18/R-20 修复；完整 Task 及 F-02/F-05 其他契约仍开放；不以安装 fixture 代替干净发布包验收。ADR-0055、CONTEXT、技术概览、技术实施方案、索引及续作记录已同步。
- **完成日期：** 2026-11-10；**closing commit：不适用，仅本地修改，不提交、不推送。**

## 13. 2026-11-10 阶段性修复进度快照（R-25～R-32）

- **记录日期：** 2026-11-10。
- **批次状态：** 实现与验证进行中；没有整体完成日期，当前不是发布候选。
- **新增实现：** 本地金额链删除、fresh-only schema 67、Pi/native-only、TUI facade 删除、Manager/Router 边界、数据库快照不覆盖、逐调用用量与发生/落库时间分离。具体状态见 R-25～R-32。
- **当前类型检查：** 本次 `npm run lint` 退出码 0，证据 `/tmp/metawork-review-documentation-lint.log`。
- **最近专项：** `/tmp/metawork-review-current-focused.log`，13 文件 / 185 用例，11 文件 / 182 用例通过，2 文件 / 3 用例失败。覆盖 metering、schema、数据库快照、准入、提案准备、account Router、Span Router 及 attempt runner；通过的范围不等于每个新增行为都有独立回归。

### 尚未关闭的三个失败

| 文件/场景 | 实际结果 | 下一步 |
| --- | --- | --- |
| `tests/session/proposal-preparation-integration.test.ts`：取消期间的 `request_replan` | 返回的 Promise 抛出 `AbortError: preparation cancelled`，预期 resolve null | 核对生产取消传播与 owner 未持久化/未准入语义，修复后复验 |
| 同文件：取消期间的 `request_merge_replan` | 同上 | 一并核对 merge replan 路径 |
| `tests/metering/token-usage-timeline.test.ts`：Pi 缓存从 adapter 到 SQLite/timeline/quota | Token 数值断言未报差异；新来源、responseId、normalizationVersion 和 recordedAt 的预期不一致 | 更新有依据的测试预期并补独立时间/来源约束回归，不仅改断言求通过 |

先前 `/tmp/metawork-review-fix-focused.log` 的两个候选排序失败已调整 fixture，最新 plan-admission 专项通过；先前 `plan-proposal-store` 残留 spanRouting 类型错误已修复，本次 lint 通过。Pi/native 整批四个旧 Codex fixture 失败虽已调整，尚无该整批重跑结果，继续列为待复验。

### 验证与交付边界

最新代码后未完成根 build、完整 `npm test`、Web/Desktop 重验及真实 Manager→Router→Executor 任务。Router/Memory 全调用计量、动态资格重读、恢复 pin、全仓文档一致性仍是开放工作。历史浏览器/Electron/依赖审计结果仅归属其执行批次；临时日志位于本机 `/tmp`，不是可随仓库复现的发布证据。

**closing commit：** 不适用；仅本地工作树，不提交、不推送、不部署、不切换用户安装。

## 14. 2026-11-10 遗留失败与缺陷关闭批次（R-33～R-40）

- **记录日期：** 2026-11-10。
- **批次状态：** 本地实现并验证；根 lint/build 与完整测试通过。整体 PRD 与发布验收仍未完成，不构成发布候选。
- **输入：** §13 的三项未关闭失败、§4/§6 的开放项，以及该批次代码改动引入或暴露的回归。

### R-33（高）：提案准备期间取消被当成准备失败抛出

- **证据：** 取消 Turn 后，准备 seam 以 `AbortError` 结束；`preparePlanProposal` 只捕获并重抛，`request_replan` / `request_merge_replan` 返回 rejected Promise，而契约要求返回 `null`（未持久化、未准入）。同文件初始提交路径已经按 `null` 处理，两条重规划路径不一致。
- **修复：** 新增 `awaitPreparation`：`AbortError` 且取消确实生效时，Turn 取消返回 `null`；dispose/Server 关闭时非初始提案抛出 `ControlApplicationInterruptedError`，保持可恢复语义。无取消信号的 adapter 侧 abort 仍是真实错误，不会被误读为“用户取消”。合并等待者与首个调用者共用同一映射。
- **验证：** `tests/session/proposal-preparation-integration.test.ts` 24 项全部通过（此前 2 项失败），含合并提交、重复身份、重建后 fence 与 dispose 路径。
- **边界：** 仅覆盖准备期取消；执行期插话/改向仍按实施计划延期（AC-35～37）。

### R-34（高）：fresh schema 67 缺少 `retry_wakes.session_id`，重试唤醒在生产库必然失败

- **证据：** `RetryWakeRepo.arm` 写入 `session_id`，`current-schema.ts` 的 `retry_wakes` 没有该列。旧升级链也从未添加它，因此这是 fresh-only schema 折叠时丢失的列；`tests/account/retry-wake-worker.test.ts` 两条用例以 `SqliteError: table retry_wakes has no column named session_id` 失败。真实后果是网络/超时重试在写入持久唤醒时抛错。
- **修复：** fresh DDL 加入 `session_id TEXT`（Session 为空是合法的 fail-closed 事实，由 worker 判定），并把 `wake_kind` 从表尾补丁列并入正式定义。
- **验证：** 新增 `tests/storage/fresh-schema-repository-columns.test.ts`：用 fresh DDL 建库后扫描 `src/storage` 全部字面量 `INSERT`/`UPDATE` 列，与 `PRAGMA table_info` 对齐（`rowid` 与动态 SQL 除外）。该测试当场只报出 `retry_wakes.session_id`，修复后通过；`retry-wake-worker` 2 项通过。
- **边界：** 该审计覆盖仓储字面量写入列，不覆盖触发器/视图内部引用，也不替代安装路径验收（见 R-40）。

### R-35（高）：Router 决策提交时未重读执行器实时可用性

- **证据：** `createAccountRouteDispatcher` 的 `readCurrentRequest` 在 append 事务内重读 Task/图/配置/失败指纹，但不读 Executor 健康。模型等待期间 Executor 被禁用或进入错误态时，仍会按旧候选落库并派发（R-30 遗留的“dispatch 阶段实时资格”缺口）。
- **修复：** 账户组合把 `kernelExecutorStatusProjector.list(revision)` 接入 route adapter；事务内用 `unavailableAgentClasses` 过滤候选，并在 Route 决策的 `excluded` 记录 `provider_unavailable`。候选为空时落 `no_candidate`，不退回提示绑定。
- **验证：** `tests/account/account-router-dispatch.test.ts` 新增用例：提交前把 `pi` 标为 disabled → 不调用决策模型、不写 `route_decisions`、返回 `binding: null` 且 `excluded` 含该 AgentClass；原有 9 项继续通过。
- **边界：** 重读的是投射后的可用性事实（健康/失败窗口），不重新解析 Harness/Model 定义；配置版本本身按 revision 固定。

### R-36（高）：用量事实的来源身份可被重放改写

- **证据：** `model_usage_facts` 的不可变身份校验只覆盖 query/task/provider/model/role/payer；同一 `call_idempotency_key` 重放时改动 `sourceId`、`providerResponseId`、`normalizationVersion` 或 `occurredAtUtc` 仍会更新 Token 数值，导致时间线按错误来源/日期归集。R-32 已把这三个字段写入 schema，但未纳入身份校验。
- **修复：** 四字段纳入 upsert 前的冲突检查，冲突抛 `model_usage_identity_conflict`，原事实保持不变；`recordedAtUtc`（本地记录时间）继续取首次值。
- **验证：** `tests/metering/token-usage-service.test.ts` 身份冲突矩阵从 6 字段扩展到 10 字段；`tests/metering/token-usage-timeline.test.ts` 的 Pi 缓存用例改为断言真实来源（`sourceId=executor`、`providerResponseId=cached`、`normalizationVersion=usage-normalizer-v1`）与发生/落库时间分离（注入固定 recorder 时钟）；新增用例覆盖同一 Attempt 两次调用分别计量、跨北京自然日按 `occurredAtUtc` 归日、`recordedAtUtc` 保持本地记录时间。metering 目录 74 项通过。
- **边界：** 不重算历史事实；Router 与 Memory 的实际模型调用仍未接入计量（F-07 剩余项）。

### R-37（中）：Span 用量仍携带本地金额字段

- **证据：** R-25 删除本地价格链后，`SpanUsage.cost`、响应解析与 advisor 聚合仍保留 `cost`，与“本地无金额”契约冲突，也让 provider 返回的金额进入 Runtime 事实。
- **修复：** 从 `SpanUsage`、`span-response-validator` 与 `aggregateUsage` 删除 `cost`；provider 若返回金额字段一律忽略（测试固化该行为）。
- **验证：** `tests/routing` 11 文件 / 136 用例通过，含真实 dated-snapshot 响应仍解析出 Token、金额被忽略。
- **边界：** 清理的是 Runtime 侧残留字段；官方订阅/支付金额仍在 `official-server`。

### R-38（高）：陈旧回归清理（40 文件 / 82 用例）

- **证据：** 上一轮实现后未完成的整体回归包含 40 个失败文件，根因分四类：已删除能力（Codex driver/默认命令、金额查询/事件、Kernel 账本表、预准入 Span 排序、`executorBindings`/`modelSelection`）的陈旧断言；Router 成为唯一决策模型后未注入决策适配器的 17 个会话/E2E 脚本；fixture 与投影字段变化（展示名、bindingSource、deferred scope 形状）；以及 schema 严格化暴露的探针表。
- **修复与替换：**
  - 新增 `MetaclawSessionDeps.spanRoutingEvaluator`（legacy facade 唯一消费方），测试通过 `tests/support/router-decision-fixture.ts` 的 `scriptedRouterEvaluator` 显式声明路由决策，而不是让 Runtime 默认选路。
  - `tests/execution/plan-admission-span.test.ts` 改写为 `plan-admission-candidate-pool.test.ts`：断言准入保留全部硬资格候选、`router-hard-eligibility-v1`、无 score/span 投影、Manager 选择字段被 strict schema 拒绝、不可用类被剔除、replan 耗尽时 deferred。
  - 新增 `tests/e2e/span-router-integration.test.ts` 取代已删除的 Kernel 期 Span E2E，`scripts/smoke-span-routing.mjs --integration` 随之指向 Router 决策模型；四条代表性负载在内网 fixture 下 7 项通过，smoke 脚本 10 项通过。
  - 失败/重试策略回归改按 D1 断言：同路由最多两次 retry、耗尽后由 Router 决策（`no_candidate` 阻止），不再是 Runtime 默认重规划；deferred 激活 fixture 改为按 Subtask ID 的 scope 记录。
  - gateway 只读查询改为 `get_token_usage`/`get_quota_guidance` 与“已删除金额查询被拒绝”；事件种类契约 28 → 27。
  - Codex 相关断言改为唯一 Pi：`configuration-candidate-projection`、`executor-runtime-parity`（并移除 Codex driver 依赖）、安装目录映射、命令展示/默认执行器等。
- **验证：** 完整 `npm test` 627 文件 / 4547 用例通过，71 跳过，0 失败（`/tmp/metawork-full-4.log`）；根 `npm run lint`、`npm run build` 通过（`/tmp/metawork-build-2.log`）。
- **边界：** 这些是测试契约与生产边界对齐，不新增第二个语义路由器：`scriptedRouterEvaluator` 只是测试内的决策模型实现，生产仍由 Server Span advisor 决策。

### R-39（中）：schema 校验只报“对象数量不符”，运维无法定位

- **证据：** `assertDatabaseSchema` 在对象数量不符时统一抛 “unexpected schema objects”，即使真实原因是缺少表/索引/触发器。
- **修复：** 改为比对期望对象名集合，报告 `missing <names>` / `unexpected <names>`（各截断 12 项），保留“备份并用 fresh 库”的处置指引。
- **验证：** `tests/storage/runtime-database-opening.test.ts` 断言缺失 `task_plan_proposals` 时错误包含 `missing task_plan_proposals`；10 项通过。
- **边界：** 仍是对象级校验（不逐列），列级漂移由 R-34 的仓储列审计覆盖。

### R-40（中）：安装探针表绕过了关闭 schema；prepared 恢复缺旧库拒绝回归

- **证据：** 两个安装回归用自建 `updater_wal_probe` / `adoption_test` 表验证“WAL 数据保留/既有账户数据保留”，与“fresh schema 不接受额外对象”冲突；同时缺少“prepared activation 的 previous 指针指向 schema 66 时必须在任何写入前拒绝”的回归。
- **修复：** 安装回归改用既有表 `client_action_references` 承载标记数据；新增用例构造 prepared journal（candidate 指向当前库、previous 指向 schema 66 库），断言 update 在建锁/迁移/切指针前以 `refuses legacy SQLite schema 66` 拒绝，且数据库指针、应用指针与 journal 字节不变。
- **验证：** `tests/installation/source-native-updater.test.ts` 40 项、`desktop-clean-install.integration.test.ts` 3 项通过。
- **边界：** 不迁移旧库；真实签名/公证/DMG、干净机器与 Linux 验收仍未取得证据。

### 本批次验证与交付边界

- **通过：** 根 `npm run lint`（tsc）、根 `npm run build`（tsup + Planner schema + Pi 扩展 + PDF + Web Vite）、完整 `npx vitest run`（627 文件 / 4547 用例通过，71 跳过，0 失败）、`git diff --check` 无告警。
- **未执行：** Web/Desktop 真实浏览器与 Electron smoke 重验、真实供应商模型任务、Feishu、签名/公证/干净机器与 Linux 验收；此前批次的浏览器/Electron 证据仍只归属其执行批次。
- **仍开放：** 正式额度档位/供应商目录与真实供应商对账；F-01/F-05 的完整失败-恢复-发布旅程；签名/公证/干净机器/Linux/Feishu 验收；全仓文档逐项一致性。
- **完成日期：** 2026-11-10（本批次）；**closing commit：** 不适用，仅本地工作树，不提交、不推送、不部署、不切换用户安装。

## 15. 2026-11-10 Router 决策模型计量接入（R-41）

- **记录日期：** 2026-11-10。
- **批次状态：** 本地实现并验证；根 lint/build 与完整测试通过。
- **交付：** Router 的每一次真实决策模型调用产生一条用量事实，来源固定为 `router`，阶段 `planning`，`agentClassRef=router`；付款方为 `system`，因此时间线可见、缺失调用可见，但不计入用户 `Included/On-demand`。事实只在真实调用发生后写入：重放已持久化决策、策略禁用、凭据缺失、无候选都不产生事实；调用发生但适配器未返回用量时写 `provider_unavailable` 缺失指标，不补零。
- **归属：** 决策模型调用由发起该次派发的 Query 承担归属；`control-execution-runtime` 把 `request.queryId` 传入 Router，account route adapter 再传给 `RouterDispatchService`。没有账户绑定 Query 的系统派发不写事实（无法归属时不伪造账户或零值）。
- **实现：** `RouterModelOutput`/`RouteDecision.call` 增加调用事实（usage、`callAttempted`、观测时间），`SpanRouterModel` 只在 `advised` 或“确实发出请求”的 fallback 原因上标记 `callAttempted`；`RouterDispatchService.onModelUsage` 仅在 `produce`（真实调用路径）回调；`src/metering/router-usage.ts` 把记录转换为 `RawUsageEvent`，account 组合把它接到 Server 的 `usageObserver`。
- **验证：** `tests/routing/router-dispatch-service.test.ts` 14 项（新增真实调用记账、缺失用量、重放不重复、无 Query 不落账）；`tests/account/account-router-dispatch.test.ts` 11 项（Query 透传/缺失）；新增 `tests/metering/router-usage.test.ts` 4 项（system 付款方、缺失指标、无 Query 返回 null、重复事件仍一条事实且 Included 与 quota 均为 0）。完整回归 628 文件 / 4555 用例通过、0 失败（`/tmp/metawork-full-4.log` 之后的最新一轮）；`npm run build` 退出码 0。
- **边界：** Memory sidecar 仍无用量通道，未接入计量；Router 决策模型 tokens 也因此不计入用户额度——这是本批次的产品判断（路由是平台内部开销），若后续要纳入 Included 需改 payer 并更新额度验收。
- **完成日期：** 2026-11-10（本批次）；**closing commit：** 不适用，仅本地工作树，不提交、不推送。

## 16. 2026-11-10 Memory sidecar 计量与真实浏览器验收（R-42～R-45）

- **记录日期：** 2026-11-10。
- **批次状态：** 本地实现并验证；根 lint/build、Web 构建、完整测试与 10 个真实 Chrome 套件通过。发布级验收（签名/公证/Linux/Feishu/真实供应商）仍未完成。

### R-42（高）：Memory sidecar 的模型调用没有任何用量事实

- **证据：** 记忆提取/场景/画像的模型调用发生在 TDAI 引擎进程内，MetaWork 只经 v3 数据面读写记忆，因此 R-09 的“memory 角色额度”没有事实来源；时间线也看不到记忆调用。
- **修复（引擎侧，release-owned compat patch）：** 新增 `src/gateway/usage-ledger.ts` 有界账本（2048 条，进程级 `instanceId` + 单调 `seq`），`StandaloneLLMRunner` 在成功路径用 AI SDK 的聚合 `totalUsage`（工具循环计全部步骤）记账，失败路径记 `success:false`；新增 Bearer 保护的 `POST /v3/metawork/usage/drain`，返回并清空账本。补丁仍以 `memory/tdai-metawork-compat.patch` 交付，`prepare-memory-engine.mjs` 在每次检出后应用；已验证补丁可干净应用到 `engine.lock.json` 的固定上游提交。
- **修复（MetaWork 侧）：** `MemoryPort.drainUsage` + `TdaiMemoryAdapter` 解析；`src/memory/memory-usage.ts` 把每次调用转成 `RawUsageEvent`（`sourceId=memory`、`stage=context`、`agentClassRef=memory`、`sourceEventKey=memory:<instance>:<seq>`）；payer 由抽取 Provider 在**固定配置版本**下的所有权解析（官方→Included，自备→on-demand），与 R-16 一致；后台记忆工作挂在一个幂等的账户级 `system` Query 上；调度器每个 tick 先 drain 再沉积，关机前再 drain 一次。无 Query 归属时不伪造事实。
- **验证：** 新增 `tests/memory/memory-usage.test.ts` 5 项（一次调用一条事实、payer 归属、失败保留缺失指标、无 Query 不落账、重复 drain 不重复计量）；真实引擎 E2E（`tests/acceptance/memory-e2e.test.ts` 11 项）在提取后 drain 到非零 Token 并写入 metering harness，`facts.every(agentClassRef==='memory')`；引擎自带单测 5 文件 / 69 用例通过。

### R-43（高）：设置保存会把已删除的本地金额字段复活

- **证据：** 真实浏览器验收（settings-workbench）显示：当旧修订仍带有 `costInputPerMillion`/`pricing`/`costTier` 时，“保存并激活”会把它们原样写回新配置。根因是 `models[ref] = { ...(sameIdentity ? originalModel : {}), ... }` 把整条旧记录铺开，覆盖了“本地无金额”的契约（D5）。
- **修复：** `web/src/components/SettingsPanel.tsx` 只前向携带 schema 拥有的字段（`systemManaged`），其余由当前表单生成。
- **验证：** 该浏览器用例重新通过，并断言保存后的每个模型都不含上述字段。

### R-44（中）：系统路由（决策模型）设置与测试契约脱节

- **证据：** 决策模型设置已改为“选择 Provider + Model，凭证复用 Provider”，但浏览器用例仍在等待“决策模型”标题和独立密码输入框；同时清空 Provider 会写出 `enabled:true` 但无 Provider/Model 的非法草稿。
- **修复：** 清空 Provider 时关闭决策模型（`enabled:false`、清空 modelRef/备选），并在用例中验证“无独立凭证字段、保存载荷不含 `spanApiKey`/`routing-span` 引用、清空后 `span.enabled=false`”。
- **验证：** 真实 Chrome 用例通过；`web` 类型检查与构建通过。

### R-45（中）：真实浏览器套件与生产烟测夹具陈旧

- **证据：** 10 个浏览器套件中 6 个失败：生产观察夹具仍引用已删除的 `planner/AnyFusion-Pi` 与 `codex` 执行器；会话行在 Workspace 切换完成前是 disabled，点击被忽略；`RESULT_10` 是 `RESULT_100` 的前缀导致基准测试过早通过；虚拟化转录与平滑滚动使末轮挂载不稳定；任务状态用例依赖已不存在的“活动任务”分区和自由文本拒绝文案；Provider 成员关系改为“只认活动配置”，不再复活仅存在于发现目录的 Provider。
- **修复：** 夹具改用 packaged Pi（Manager/Executor 独立 Pi home、`METAWORK_MANAGED_PI` 指向可执行 fixture、release 不再 stage fork）；浏览器 helper 在连接后启用 `prefers-reduced-motion: reduce`，使跟随滚动即时完成；用例等待会话行可用、等待选择提交，并把转录滚到最新轮；标记匹配改为整行精确匹配；任务状态用例改断言当前契约（侧栏 `已阻塞` + activity 的 `nextAuthorizedAction=explicit_resume_required` + 输入仍可用 + 重连后保持）；Provider 用例改断言“仅活动配置的 Provider 出现、发现目录不复活”。
- **验证：** `RUN_BROWSER_E2E=1 npx vitest run <10 套件>`：**10 文件 / 21 用例通过**（真实 Chrome headless，Web 生产构建）；生产观察暖切换 p95 = **17.6 ms**（预算 100 ms），基线每次 Turn 读取 ≤20 项、≤256 KiB，无 journal/content 读取。
- **边界：** 浏览器用例仍使用 API fixture（除生产观察套件外）；签名/公证/DMG、干净机器、Linux、Feishu 与真实供应商任务未验收。

### 本批次验证与交付边界

- **通过：** 根 `npm run lint`；根 `npm run build`；`web` 类型检查与 Vite 构建；完整 `npx vitest run` **629 文件 / 4561 用例通过、71 跳过、0 失败**；真实引擎记忆 E2E 与记忆计量专项；10 个真实 Chrome 套件 21 用例；引擎 upstream 单测 69 用例；`git diff --check` 无告警（含重新生成的 compat patch）。
- **引擎交付：** `memory/tdai-metawork-compat.patch` 现包含用量账本与 drain 路由；CI 的 `prepare-memory-engine.mjs` 会在固定上游提交上重新应用并构建，本地 `memory/tdai` 检出已带该补丁。
- **仍开放：** 签名/公证/DMG、干净机器与 Linux、Feishu、真实供应商任务与额度对账；Memory 用量当前写入系统 Query 并参与账户时间线，正式额度档位仍需产品确认。
- **完成日期：** 2026-11-10（本批次）；**closing commit：** 不适用，仅本地工作树，不提交、不推送。

## 17. 2026-11-10 发布级链路与安装验收批次（R-46～R-51）

- **记录日期：** 2026-11-10。
- **批次状态：** 本地实现并验证。首次在本地跑通“固定上游记忆引擎重建 + 正式打包 + 打包产物起服 + 安装发布验收 + 无 fork 网关烟测”这条链路，并把它暴露出来的问题修掉。签名/公证/DMG、干净机器、Linux、Feishu、真实供应商任务仍未验收。

### R-46（中）：`prepare:memory-engine` 在复用的本地检出上必然失败

- **证据：** 在已有本地改动的 `memory/tdai` 上执行 `npm run prepare:memory-engine`：`git checkout --detach FETCH_HEAD` 会把旧的工作区改动原样保留，随后 `git apply` 报 `patch does not apply`；第二次执行又因补丁新增的 `src/gateway/usage-ledger.ts` 已存在而报 `already exists in working directory`。也就是说 CI 干净克隆能过，复用的本地/缓存检出过不去。
- **修复：** 打补丁前先 `git reset --quiet` + `git checkout -- .` 还原到固定上游内容，再按补丁解析出的 `new file mode` 路径删除“上个补丁留下的新增文件”，最后应用补丁；补丁仍是 release-owned 变更的唯一来源。
- **验证：** 本地完整执行 `npm run prepare:memory-engine`：检出 `a3c2d86…`、应用 `memory/tdai-metawork-compat.patch`、`npm ci`、构建、裁剪生产依赖，输出 `memory engine ready … @ a3c2d8600b5d8ab51d5389e55ce62ca8da16b833`；`node scripts/verify-memory-engine.mjs` → `status=ok ftsAvailable=true version=0.1.0`；重建后再跑真实引擎记忆 E2E 11 项仍通过。

### R-47（中）：`smoke:gateway` 仍在驱动已删除的 fork 与 TUI

- **证据：** `npm run smoke:gateway` 第一阶段 155 用例通过后立即失败：脚本仍引用 `planner/AnyFusion-Pi`、Planner TUI 验收文件、`--planner-root`、安装后的 `app/current/planner/.../gateway-client.js`，并尝试启动 `metawork tui`。这些对象在 ADR-0055 D6/D11 之后都不存在。
- **修复：** 重写为当前架构：只跑 MetaWork 网关验收文件 → 从当前树安装原生发布（无 `--planner-root`，改为校验 packaged Pi 载荷）→ 启动已安装 Server → 用 **v2 JSONL socket 协议**的独立客户端做多客户端验收（同 Workspace 目录共享、跨 Workspace 隔离、重启后身份与目录恢复）→ 断言安装包自带 Web 与 `/api/auth/session` → `server status` → 停止；同时把“Server 不得拉起已退役 TUI/Planner 子进程”作为显式守卫。
- **验证：** `npm run smoke:gateway` 通过：20 文件 / 155 用例 + `Native multi-client process acceptance passed` + `Unified Gateway smoke passed with isolated root …`；`tests/scripts/smoke-unified-gateway.test.ts` 同步改为断言“不再包含 fork/TUI 对象、改用 socket 客户端与退役进程守卫”。

### R-48（低）：安装发布验收用例仍启动已删除的原生 TUI

- **证据：** `tests/e2e/installed-observation-native.test.ts` 通过 `metawork tui` 启动原生 TUI 并匹配 `RESULT_10`；TUI 删除后该用例在任何机器上都无法通过（`RUN_INSTALLED_OBSERVATION=1` 直接抛错）。
- **修复：** 改为验证安装发布本身：`app/current` 指针指向暂存发布、`release-identity.json` 与端点 `releaseId` 一致、发布自带 `web/dist`、`desktop-tools/executor/bin/pi --version` 与 `pi-runtime-pin.json` 一致、HTTP 返回发布自带 Web 与 `200 /api/auth/session`。安装模式不再注入 `METAWORK_MANAGED_PI` 夹具，避免掩盖坏掉的发布载荷。
- **验证：** `RUN_INSTALLED_OBSERVATION=1 npx vitest run tests/e2e/installed-observation-native.test.ts` → 1 文件 / 1 用例通过（17.7 s）。

### R-49（低）：Desktop 更新门禁与残留 TUI 脚本仍指向已删除的 fork

- **证据：** `scripts/desktop-update-gate.ts` 仍向安装器/更新器传 `plannerRoot: .../app/current/planner` 与 `payload/planner`；在无 fork 的发布上 `cp` 会因路径不存在失败。`scripts/verify-tui-billing.mjs`、`scripts/verify-tui-scroll.mjs` 只操作 `planner/AnyFusion-Pi/packages/coding-agent/dist`。
- **修复：** 更新门禁去掉两处 `plannerRoot`（`memoryRoot` 保留）；删除两个失效 TUI 校验脚本（仓库内无任何引用）。
- **验证：** `tsc --noEmit` 通过。完整 DMG 更新门禁需要 release-owned 的 node/git 工具树与签名密钥，本轮未执行（见下条边界）。

### R-50（记录）：Desktop 本地验收链路与全新安装

- **证据/变更：** 旧 `.tmp/desktop-development` 是 0.1.17（schema 50、仍含 fork），在 fresh-only 策略下被明确拒绝：`runtime startup refuses legacy SQLite schema 50`；全新安装又要求 `internal/llm.json` + 凭据（系统内部 LLM 预置）。两者都是既有契约而非缺陷。
- **验证（干净安装路径）：** 用隔离的 `METAWORK_INTERNAL_LLM_SOURCE_ROOT` fixture 重建开发安装到 `0.1.26-desktop-development`（载荷含 `desktop-tools`/`web`，不含 `planner/`）；`npm run test:desktop` 11 文件 / 28 用例、`npm run lint:desktop`、`npm run build:desktop` 通过；`npm run smoke:desktop` → `Electron production-assets smoke passed; ready=3127ms`，且 `Server survived Electron exit`。

### R-51（高，仍开放）：Router 决策模型的默认模型已从供应商目录消失

- **证据：** `npm run smoke:span-routing`（显式实时调用，不属于 `npm test`）返回 `{"ok": false, "errorCode": "span_http_error", "httpStatus": 404}`；`https://openrouter.ai/api/v1/models` 已无任何 `inception/*` 模型，即代码与设置里硬编码的 `inception/mercury-decide:free` 上游已下架。
- **影响：** 决策模型（Router 的 AgentClass/Provider/Model 选择依据）在当前默认配置下不可用；这不影响 `npm test`（决策模型只在显式启用/实时烟测时调用），但会让“自动路由”在产品上静默退化到默认选择。
- **边界：** 需要产品决定替代模型与供应商（会改变额度与成本口径），本轮未擅自替换；代码保留既有的 404 诊断（`span_http_error`）与显式凭证解析，不读 Provider 命名空间。

### 本批次验证与交付边界

- **发布打包：** `node scripts/build-release.mjs --package-only` 产出 runtime 117,058,166 B / pi 27,097,337 B / memory 95,108,412 B 三个归档与 `manifest.darwin-arm64.json`；用本地临时 ed25519 密钥签名后离线校验：签名有效、三个归档 `byteSize` 与 `sha256` 全部匹配、`compatibility.databaseSchema=67`、`plannerHostProtocol=2`、`pi.version=1.5.0`。
- **打包产物起服：** 解包同一归档后，`verify-memory-engine --memory-root <unpacked>` → `status=ok ftsAvailable=true`；用解包 runtime 启动 Server（packaged Pi + 自带 `web/dist`）→ 返回自带 Web（`<div id="root">`）、`/api/auth/session` 200、packaged Pi 可执行。
- **其他通过项：** `npm run check:pi-runtime-pin`（1.5.0，`~/.pi/agent/install/releases/1.5.0`）；`npm run smoke:clients` 3 用例；`METAWORK_PI_PACKAGE_ROOT=… npm run check:pi-tool-stall`（加载 `tool_execution_*` 守卫）；根 `npm run lint`、`npm run build`、`web` 构建；完整 `npx vitest run` **629 文件 / 4561 用例通过、71 跳过、0 失败**；`git diff --check` 无告警。
- **未验收（release-owned 或需外部凭证）：** Developer ID 签名 + 公证 + DMG 与 `desktop-update-gate` 全链路（需发布工具树/证书）；干净机器与 Linux；Feishu；真实供应商任务与额度对账；`smoke:metawork`/`smoke:pi-pdf`（需真实模型凭证）；Router 决策模型替代（R-51）。
- **完成日期：** 2026-11-10（本批次）；**closing commit：** 不适用，仅本地工作树，不提交、不推送。

## 18. 2026-11-10 决策模型改为 Jev 实测、单候选短路与本地 DMG 验收（R-51～R-55）

- **记录日期：** 2026-11-10。
- **批次状态：** 决策模型链路用 Jev 完成真实调用验证；本地完成 DMG 打包与更新门禁（不使用 Developer ID）。签名/公证/干净机器/Linux/Feishu/真实供应商任务仍不在本轮范围。

### R-51（关闭）：决策模型不再绑定已下架的上游，改用 way 主机的 Jev

- **证据：** `inception/mercury-decide:free` 已从 OpenRouter 目录消失（实时烟测 404）。用户环境的 `way` 主机（`192.168.1.4` / tailnet `100.75.20.123`）在 8082 端口提供 Jev 决策服务：`GET /health` 200、`GET /models` 返回 `/home/way/jev27bv/JEV-27B-VL-Q8_0.gguf`、`POST /v1/systemone` 返回标准 `{model, answers.candidates{type,choice,probabilities}, usage}`。
- **修复（产品侧）：** 决策模型不再有任何硬编码默认。`SPAN_ROUTING_MODEL`、`SPAN_MODEL`、UI 草稿与能力判定中的 Mercury 字面量全部删除；“启用系统路由”必须由配置里的 Provider+Model 承载（`routing.span.providerRef/modelRef`），`routing.span.model` 退化为旧版本只读标识（schema 可选，不再参与请求）。旧退役模型（`respan/span-01-lite`）迁移改为“删除该字段”，不再替换成别的厂商模型。
- **修复（烟测侧）：** `scripts/smoke-span-routing.mjs` 重写为“解析目标 → 一次联合 choice 调用 → 与产品同规则校验”。目标解析顺序：显式 `--base-url/--model` → 活动账户 revision 的 `routing.span` Provider/Model → `--credentials`；凭证来自 Provider 的 `file-secret:anyfusion/providers/<ref>`、`METAWORK_SPAN_API_KEY` 或内部 `routing-span` 槽（不再要求 OpenRouter）。`--integration` 把真实目标传给四个代表性 workload 集成用例。
- **验证（真实 Jev）：** `METAWORK_INSTALL_ROOT=~/.metawork node scripts/smoke-span-routing.mjs` → `ok:true`、`credentialSource=secret-store:providers/custom-model-7`、模型 `/home/way/jev27bv/JEV-27B-VL-Q8_0.gguf`、概率 `{c000:0.905, c001:0.095}`、`inputTokens=177`、679 ms。`--integration` → `ok:true`，4 个 workload 全部 `selected`，3 次真实决策调用（约 670–764 ms）+ 1 次单候选短路，`replayCalls=0`。

### R-52（高，真实缺陷）：单候选也调用决策模型，Jev 下会退化成 no_candidate

- **证据：** 实时集成中 `single` workload（唯一合法绑定）返回 `no_candidate`：`SpanRouterModel` 对 1 个候选也发起 joint choice，模型返回的单选项结果没通过校验，路由直接无候选——设置页承诺“单一候选直接使用，不增加等待”，与实现不一致，且真机上会阻断执行。
- **修复：** `SpanRouterModel.decide` 在候选数为 1 时直接选中，不再发起决策调用（`callAttempted:false`，不产生用量事实）。
- **验证：** 集成用例改为断言单候选 `evaluate` 调用 0 次（其余 1 次），线上模式 4/4 workload `selected`。

### R-53（中）：决策模型烟测脚本与产品契约脱节

- **证据：** 旧脚本走 OpenRouter SDK、要求 `OPENROUTER_API_KEY`、用 `SPAN_MODEL_VERSION` 正则只认 `inception/mercury-decide*`，与“Provider/Model 配置化”和 Jev 的 `/v1/systemone` 契约都不一致；它的单测还把 SDK 的 `Request` 形参写死，无法覆盖普通 `fetch(url, init)` 用法。
- **修复/验证：** 脚本改为直连 `${baseUrl}/systemone`（与 `defaultSpanDecisionClient` 同线格式：`state` 为 JSON 字符串），只接受完整、有限、在范围内的概率集；错误只输出有限错误码与 HTTP 状态，不打印原始响应。单测同步更新（两条新的凭证路径 + 模型回显校验 + 嵌套集成诊断环境变量），`tests/routing/span-routing-smoke-script.test.ts` 10 项通过。

### R-54（关闭）：本地 DMG 打包与更新门禁（无 Developer ID）

- **证据/变更：** `scripts/verify-desktop-update.mjs` 调用的是未声明的 `vite-node`（`ENOENT`），更新门禁实际不可用；`scripts/desktop-update-gate.ts` 仍传已删除 fork 的 `plannerRoot`。
- **修复：** 门禁改用仓库实际使用的 `tsx`（新增 `tsx@4.23.15` 开发依赖，避免再出现“脚本引用了未安装的 runner”），并去掉 `plannerRoot`。
- **验证（完整链路）：** `build-release --package-only`（三归档 + 签名 manifest）→ `prepare-runtime`（`--development true`，node/git 工具树 + 32 个 payload 目录）→ `METAWORK_DESKTOP_INTERNAL=1 npm run package:desktop` → `apps/desktop/release/MetaWork-darwin-arm64.dmg`（694,983,879 B，`Signature=adhoc`、`Identifier=com.metawork.desktop`、无 Team ID，releaseId `0.1.26-build-83c3f800-1794289574052`）；挂载 DMG 后 `codesign --verify --strict` 通过，`desktop-release.json` 为 `development:true` / 31,902 个清单文件 / Electron 44.10.2，载荷含 `desktop-tools/{executor,git,node}` 与当前树的 Router 代码；`node scripts/verify-desktop-update.mjs <DMG Resources> .tmp/desktop-development` → `desktop update gate: 0.1.26-desktop-development -> 0.1.26-build-83c3f800-1794289574052, upgradeId update-c3f800-1794289574052-…, memory engine present`。
- **边界：** 该 DMG 是开发签名演练产物，`verifyDesktopRelease` 会拒绝它用于正式发布；公证、干净机器安装与 Linux/Feishu 验收仍未完成。

### 本批次验证

- **决策模型：** Jev 单次调用与 4 workload 集成（真实网络）全部通过；单候选短路修复后路由稳定 `selected`。
- **回归：** `npm run lint`、`npm run build`、`web` 构建通过；完整 `npx vitest run` **629 文件 / 4561 用例通过、71 跳过、0 失败**；`tests/routing` + `tests/configuration` + `tests/web` + span E2E 专项 854 项通过。
- **打包/更新：** 三条打包/更新命令全部本地跑通（见 R-54）。
- **仍开放：** 公证与正式发布签名、干净机器、Linux、Feishu、真实供应商任务与额度对账；`.tmp/release-package` 与 DMG 为本地演练产物，未提交。
- **完成日期：** 2026-11-10（本批次）；**closing commit：** 不适用，仅本地工作树。

## 19. 2026-11-10 Manager 把内部模型引用当成供应商模型名（R-56，阻断性缺陷）

- **记录日期：** 2026-11-10。
- **现象：** 真实任务在 planning 阶段瞬时失败三次（08:51、09:52、09:56），错误为
  `Manager turn failed (manager_invalid_output): manager turn produced no proposal`。
  三次的 `model_usage_facts` 都是 `input_tokens=0 / output_tokens=0`，失败距调用开始
  仅几十毫秒。
- **证据（R-55 新增的诊断首次暴露真实原因）：**
  `custom-model-1 API error (400): {"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed custom-model-1-1."}`。
  即 Manager 把**内部模型引用** `custom-model-1-1` 当成供应商模型名发给了 Pi/DeepSeek。
- **根因：** `src/configuration/projections.ts` 的 `buildPlannerConfigurationView` 没有把
  `modelId` 放进 Planner 视图，`PlannerModelProfile` 类型也没有该字段；于是
  `selectManagerModel` 返回的模型只有 `{ id, providerRef }`，`manager-agent` 的
  `--model` 只能回退到 `modelRef`（内部引用），供应商一律 400，Turn 必然无计划。
  这是 100% 复现的缺陷，不是供应商抖动；此前的供应商余额/限流判断是错的，是诊断缺失导致的误判。
- **修复：** `PlannerModelProfile` 新增必填 `modelId`，Planner 投影写入 `modelId: model.modelId`；Manager 的
  `--model` 因此拿到真实模型名。回归用例：`tests/configuration/projections.test.ts` 断言 Planner 视图的
  `modelId` 序列为 `['engineering-model', 'planner-model']`。
- **验证：** 用真实账户 revision 构造 Planner 视图后 `selectManagerModel` 返回
  `modelId = deepseek-flash`（修复前为 `undefined` → 发送 `custom-model-1-1`）；完整套件
  **629 文件 / 4563 用例通过、71 跳过、0 失败**；`npm run build`、`npm run lint`、`web` 构建通过；
  试运行实例 `0.1.26-trial6` 的 `app/current/dist` 与仓库 `dist` 逐文件一致。
- **同类排查：** 记忆召回（79–89 ms、`degraded=0`）、DeepSeek 余额（4,808.48 CNY）与连通性（200/221 ms）
  均已排除，记忆链路不是本次失败原因，且召回/抽取失败只降级不阻断（见 R-55 的告警改造）。
- **完成日期：** 2026-11-10（本批次）；**closing commit：** 不适用，仅本地工作树。

## 20. 2026-11-10 绑定运行时的 sessionControlRuntime 缺少 applyPlanAdmission（R-57）

- **记录日期：** 2026-11-10。
- **现象：** Manager 已能出计划（R-56 修复生效，Turn 跑了 23 秒），但 admission 阶段报
  `sessionControlRuntime.applyPlanAdmission is not a function`，Turn 依旧失败。
- **根因：** `src/account/account-conversation-execution-binder.ts` 的 `bind()` 为了把
  `forInput().apply` 包进 AsyncLocalStorage 绑定，手工构造了一个**只有 `forInput`** 的对象，
  再 `as AccountControlExecutionServices['sessionControlRuntime']` 强转成完整类型。真实调用方
  （`server-composition` 的 `conversation.bindSessionControlRuntime(bound.sessionControlRuntime)`、
  startup recovery）用的是绑定后的对象，于是 `applyPlanAdmission` 在运行时不存在。类型断言把这个缺口藏住了。
- **修复：** 新增 `bindSessionControlRuntime`：用 `bindObject`（Proxy）保留完整 API，并只对
  `forInput` 做绑定包装；不再用 `as` 强转伪造对象。
- **回归用例：** `tests/account/account-conversation-execution-binder.test.ts` 断言绑定后的
  `applyPlanAdmission` 可调用、在正确的 Conversation 绑定内执行，且 `forInput().apply` 仍可用。
- **验证：** 完整套件 **629 文件 / 4564 用例通过、71 跳过、0 失败**；`npm run build`、`npm run lint` 通过；
  试运行实例 `0.1.26-trial7` 与仓库 `dist` 逐文件一致。

## 21. 2026-11-10 移除 direct_reply、单作用域绑定与本机验收开关（R-58～R-60）

- **记录日期：** 2026-11-10。

### R-58（契约变更，用户决定）：彻底移除 `direct_reply`，不做兼容

- **变更：** `PlanningAgentPlan v9` 删除 `action: 'direct_reply'` 与 `response.directReply`；准入策略、准入结果存储、控制决策契约、Kernel 恢复列表、`SessionControlRuntime`、`ConversationSession`、`MetaclawSession`、启动恢复回调中的 direct reply 分支、`allowLegacyDirectReply` 开关与 `deliverDirectReply` 交付回调全部删除。生成的 `planning-agent-plan-v9.schema.json` 已无该动作（0 命中）。
- **语义结果：** Manager 只能产出 `clarification` / `task_control` / `plan_work_graph` / `authorization_resolution` / `no_action`；工作型请求必须走 Work Graph + Executor。历史 direct-reply 记录不再可解析（无兼容），文档同步更新。
- **测试：** 删除/改写 19 个文件中的 direct-reply 用例（准入、ledger 适配、结果记录、Round-3 验收、base fixtures）；完整套件保持全绿。

### R-59（架构）：合并为单一作用域机制，删除逐方法 Proxy

- **问题：** 此前 `binder.bind()` 用三个 Proxy 逐方法注入 AsyncLocalStorage 绑定，并用 `as` 断言把"部分实现"伪装成完整服务（R-57 的根因）。
- **修复：** `bind()`、`bindObject`、`bindSessionControlRuntime` 全部删除；`AccountRuntimeComposition` 直接暴露共享 `controlExecutionServices`；`ConversationSession` 新增 `runInBinding`，`submitUserInput` 与 `submitPlannerProposal` 作为唯一 Turn 入口用 `binder.runWith(binding, …)` 包住整轮。回调仍通过 routed proxies 在调用时读取 ALS。
- **测试：** binder 用例改为 `runWith` 语义（并发隔离、缺少绑定时抛错、Query 归属）；新增 `ConversationSession` 用例断言 Turn 入口必定进入绑定。
- **端到端验证（真实模型）：** `METAWORK_ACCEPTANCE_AUTHORIZATION=1` 下用 gateway socket 提交真实 Turn：Manager（deepseek-flash，7.2k/8k tokens）→ Router 决策模型（460 tokens）→ Executor（5.8k/189 tokens）→ 任务 `succeeded`，生成最终回答「这条消息是一条简短的指令…」。这同时验证了 R-56（模型名）与 R-57（准入方法）的修复。

### R-60（测试基础设施）：本机验收授权开关

- **动机：** Web 提交被"官方账号授权"门禁挡住，自动化无法在开发机跑通 Turn 全链路，导致 R-56/R-57 只能在用户手里暴露。
- **实现：** `METAWORK_ACCEPTANCE_AUTHORIZATION=1`（且 `NODE_ENV !== 'production'`）时，`newWorkAdmission.check` 与 `productionAuthorization` 视为已授权；生产构建下无效。
- **验证：** 上述真实 Turn 即由该开关驱动；关闭时行为不变（门禁仍拦截，返回原提示）。

### 本批次验证

- **测试：** 完整 `npx vitest run` **629 文件 / 4564 用例通过、71 跳过、0 失败**；`npm run lint`、`npm run build` 通过；生成 schema 无 `direct_reply`。
- **真实链路：** 试运行实例 `0.1.26-trial10`（`0.0.0.0:8788`）完成一次真实任务：规划 → 路由 → 执行 → 回答，任务状态 `succeeded`。
- **仍待办：** 真正走 `ConversationSession → 准入` 的 **CI 集成测试**（R-59 只加了 Turn 作用域用例与真实链路验证）；direct_reply 相关文档章节（CONTEXT/技术总览）需同步措辞。

## 22. 2026-11-10 规划优先级默认化与真实链路复测（R-61）

- **记录日期：** 2026-11-10。
- **现象（真实 Turn）：** 在 `0.1.26-trial10/11` 上，Manager（deepseek-flash）连续三轮产出 `plan_work_graph` 但 `task.priority` 为空，被准入前校验拒绝
  `invalid PlanningAgentPlan: schedulable actions require task.priority with valid level and non-empty reason`，Turn 失败。
- **判断：** 优先级是宿主/用户信号，不是模型语义；让快模型稳定填写它既不必要也不可靠，且会在 ReAct 里连轮重试（实测 3 轮）。
- **修复：** `normalizePlanningAgentPlanInput` 在可调度动作（`plan_work_graph`、`resume_task`/`recover_blocked`）且 `task.priority == null` 时补 `{ level: 'normal', reason: 'Host default: the Planner did not specify priority' }`；校验仍对模型实际给出的非法值保持严格。回归用例覆盖"缺失即默认"与"已给出则保真"。
- **验证（真实模型）：** `0.1.26-trial12` 上再次提交真实 Turn：任务 `succeeded`，`conversation_turn_answers` 有最终回答；`model_usage_facts` 显示 manager→router→executor 全链路（deepseek-flash / span-routing-v1）。
- **测试：** 完整 `npx vitest run` **629 文件 / 4567 用例通过、71 跳过、0 失败**；`npm run lint`、`npm run build` 通过。

