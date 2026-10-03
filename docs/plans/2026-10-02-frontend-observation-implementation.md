# 前端观察与多端统一控制实施记录

- 计划日期：2026-10-02；本地实施及验证日期：2026-10-03。
- 状态：**代码已实施并通过下列验收，已完成提交并按用户授权同步 GitHub**。环境与人工验收门见末节。
- 设计提交：`7a6a71c82fc5ed34083b8ec79a9cd8ea7e97503a`，已推送 `origin/main`。
- 实施提交：`3e463bb4a1ccea6a6c7179d90794274f52e668df`（`feat: unify multi-client observation and task navigation`）。
- 收尾日期：2026-10-03；用户已授权同步，实施代码、修订文档及测试已纳入提交并推送 `origin/main`。
- 依据：[完整方案](2026-10-02-frontend-observation-architecture-upgrade-design.md)、[ADR-0043](../adr/0043-explicit-conversation-observation-and-client-read-models.md)。

## 模块与阶段对应

| 阶段 | 唯一 owner / seam | 已实现行为与删除项 | 验证边界 |
| --- | --- | --- | --- |
| P0 基线 | release identity、navigation diagnostics | 保存原有导航/交付/Planner 改动；独立生产及安装 fixture；冻结以下预算 | 源码、隔离安装、正常安装分别报告 |
| P1 读模型 | Session/Application Shell → Storage | schema 47；小实体/正文分离；checkpoint/tail；trace/search 索引；dirty activity；staging/原子发布；后台 worker | SQLite、迁移、重建、删除、预算和大历史通过；Docker 未运行 |
| P2 多端 | Gateway、Permission/KernelWorkflow、Delivery | 共享事实去除 origin 过滤；查询回执定向；精确取消；持久审批仲裁/应用/恢复；通知独立路由 | 九组合、冲突、失效目标、恢复、签名和路由用例通过 |
| P3 状态 | Web entity/Composer stores、ObservationManager | 焦点、观察、执行、草稿分开；显式命令目标；重连同键重发；撤销清缓存；删除单 liveTurn 主事实容器 | Web 回归、真实登录/导航/深链接/重连通过 |
| P4 展示与飞书 | Web presentation、Feishu adapter | Turn 窗口与语义锚点；正文自动完整显示；原有执行/报告/费用卡片；按需详情；图片预算；按主体导航；跨来源查询/跟踪/发送/停止/审批 | 浏览器 IME/图片/选择、规模、30 分钟持续更新通过；实际平台发送未执行 |
| P5 收敛 | 单一 TUI、composition/release、当前文档 | Web/native 正式浏览不再 attach/full-history/replay；TUI transport 移除旧恢复 API；能力/身份对齐；ADR/CONTEXT/current docs 更新 | root build/lint/full tests、native offline build/80 项测试及隔离安装通过；正常安装和人工验收待完成 |

- [x] 先推送设计文档，实施留在本地。
- [x] P0–P4 代码落地及本机可执行的自动化验收。
- [x] P5 源码收敛、当前契约更新与隔离安装验收。
- [ ] Docker、正常安装、真实飞书目的地、真实多模型并行负载及人工辅助技术验收。
- [x] 用户确认后创建实施同步提交并推送 `origin/main`。

## 实际交付

### 浏览与历史

`ConversationObservationService` 在认证范围内先订阅再读取一致的投影基线，以 epoch/revision 恢复；缺口、过期或溢出显式 reset。打开页面不构造 Planner，也不占执行槽。近期摘要、活动任务、待审批、正文、trace、产物和账单分开读取。活动集合来自 Task Domain 的 canonical TaskView 与索引见证事实，不按“最新一轮”或最后一条 trace 猜状态。

SQLite 的历史 source checkpoint、实体/head/tail 更新保持事务一致；跨文件日志使用可恢复来源，不伪造跨系统事务。重建写 staging epoch，追平后 CAS 发布；tombstone 阻止迟到历史/审计把已删 Turn 复活。正文回收保护 current/staging/tail 和未交付通知的引用。完整正文搜索包含预览外内容，保留中文、emoji 和非 ASCII 大小写匹配的 UTF-8 定位。

后台 SQLite 历史解析复用同一投影器及通知事务钩子，隔离到每账户一个 worker；每批最多 16 条/20 ms 调度预算，一次只接纳一个批次，worker old-generation 128 MiB、10 秒超时。单条旧 JSON 仍整条解析，因此 20 ms 是批次调度预算，**不是超大单条解析/写事务的抢占保证**。

真实浏览器发现并修复第二 SQLite writer 引入的 `database is locked`：读后写事务使用 `BEGIN IMMEDIATE` 提前取得写权限，包含外层 application transaction；只读 baseline/page/change/trace 保留 deferred 一致快照。worker 无待处理记录时不抢写锁。这个改动不改变 Kernel 策略或业务事务原子边界。

### 多端同权与通知

同 Server/Account 下，Web/TUI/Feishu 均可发现、观察、继续发送、停止及审批；origin 仅保留来源归因/默认通知位置。只读观察接口不产生执行副作用，也不把其他端变成“只读用户”。查询与命令回执返回对应连接，共享事实发送给匹配的已授权观察者。

`cancel_turn` 仍锁定确切 Turn；`cancel_task` 锁定 Task 与 generation，不退化为停止最新任务。审批包含 request revision/generation，第一个有效决定持久接受；相同重试复用，相反决定返回已处理事实。Permission owner 与 KernelWorkflow 分开记录接受/应用，并恢复接受后尚未应用的决定；UI 和通知不直接授权 Executor。

飞书以已验证 principal 保存导航，跨来源任务可经卡片或文本命令操作。签名动作绑定原始目标和操作者，旧代际与伪造动作拒绝。默认回复/显式跟踪路由保留 chat/thread，不随 Web 浏览漂移。通知事实与业务投影同事务捕获；每路由独立幂等、重试与授权复查。就绪池最多 1,024 项，多余 durable intent 存入 deferred；最多四个物理发送、每路由一个占位。慢路由占自己的发送位；所有四路都慢时等待其实际请求结束，不另起无限重试。重要未送达结果/审批不按缓存过期删除，因此**持久积压总磁盘量不具有固定上限**。

### 客户端与资源

Web 主 App 已拆为控制 hook、实体仓库、观察管理和展示组件；后台会话事件更新自己的实体，不改当前焦点/草稿。发送、上传和异步结果捕获 Conversation 目标；迟到失败不覆盖用户新草稿。只有终态准入拒绝才恢复发送内容，网络不确定保持同键重试。身份或账户变化、授权撤销会清理缓存和在途状态。

历史最多挂载 40 个 Turn；正文按 32 KiB 范围自动读取并显示全文，用户无需逐段翻页或点击阅读全文。服务端全文索引与 Turn 定位能力保留，对话页不新增搜索行。图片下载前限流，解码前检查字节与像素，离开视口/卸载释放 Blob URL；超预算或不支持的格式保留原图入口。中文 IME 确认候选词不发送，正常 Enter 才发送。native TUI 使用相同观察/资源协议、独立 cursor、精确停止与审批；重连先验证能力/身份再恢复命令。

| 项目 | 当前硬限制/策略 |
| --- | --- |
| Turn 预览/实体 | 单字段预览 4 KiB；实体 wire ≤16 KiB |
| 基线/帧 | 最近 20 Turn；基线总量 ≤256 KiB；单帧 ≤64 KiB；完整校验后提交 |
| 传输 | 每连接最多 8 个观察；客户端每观察缓冲 512 KiB、连接 2 MiB；服务端 socket 待发超过 512 KiB 关闭慢连接，由 cursor 恢复 |
| Tail | 每会话 4 MiB/10 分钟，账户合计 128 MiB；过期 cursor reset |
| Web 实体 | 最多 12 个 warm Conversation、500 个 Turn；单会话历史窗口 50；实体受协议字节上限约束，正文不常驻实体仓库 |
| DOM/正文 | 最多 40 Turn；已挂载消息保留全文，不宣称单条正文 DOM 固定上限；正文热缓存最多 16 条/8 MiB，超限正文只在挂载期间保留 |
| 卡片资源 | 最多 4 组并发加载；等候队列最多 128 组；热缓存最多 32 条、每条序列化 ≤128 KiB |
| 草稿 | 最多 64 份，单份正文 48 KiB、序列化含附件元信息 128 KiB；超限保留旧稿并提示 |
| 图片 | 最多 4 张加载/驻留；单图编码 4 MiB、400 万像素；合计 800 万像素（约 32 MB RGBA，不含浏览器额外开销） |
| 通知 | 1,024 ready jobs；多余持久 deferred；4 个物理发送；每路由一个；进度合并、终态回执清理 |

以上为本次冻结参数，对原设计中的候选值作具体化；没有声称总浏览器 RSS 可由 JS 缓存参数精确限定。

## 可复现验证

环境：macOS、Node 22.23.3、系统 Chrome headless；独立临时账户/数据库/安装根目录，无外部模型或飞书发送。构建源码来自本次已提交版本；发布身份来自被测试的隔离安装，不是正常用户安装。

| 命令/测试 | 结果与断言 |
| --- | --- |
| `npm run build` | Server/worker/Web 构建通过 |
| `npm run lint`；`npx tsc --noEmit -p web/tsconfig.json` | root/Web 类型检查通过 |
| `npx vitest run` | 展示修正前全仓 500 文件、3,268 tests 通过；10 文件/17 tests 默认跳过。耗时 84.79 秒，包含写事务修复 |
| `npx vitest run tests/web tests/management/artifact-preview-service.test.ts tests/storage/conversation-history-search.test.ts` | 37 文件、212 tests 通过；包含图片、草稿、输入、身份与导航 |
| native `npm run build:offline` | vendored Planner/TUI 离线构建通过 |
| native 八个相关测试文件 | 80 tests 通过：Gateway、observation、navigation、wire、bounded history、reconnect、App、controller |
| `RUN_BROWSER_E2E=1 npx vitest run tests/e2e/production-observation-browser.test.ts tests/e2e/conversation-history-worker.test.ts` | 2 tests 通过；真实 CLI composition、SQLite/segment journal、登录、生产 Web bundle、深链接与慢网刷新、大历史 worker/重建 |
| `RUN_BROWSER_E2E=1 npx vitest run tests/e2e/composer-interaction-browser.test.ts` | 真实 React/Chrome IME/焦点、Markdown 图片解码及 URL 回收通过 |
| `RUN_INSTALLED_OBSERVATION=1 npx vitest run tests/e2e/installed-observation-native.test.ts` | 最新代码经正式 release staging 创建隔离 app/current；安装 Server + 实际 native CLI 渲染历史、endpoint/release identity 一致；14.76 秒 |
| `RUN_OBSERVATION_SOAK=1 npx vitest run tests/e2e/production-observation-soak.test.ts` | 30 分钟通过；1,571 次更新/切换；DOM≤40；稳定期 heap 约 4.5–4.63 MB，结束约 4.62 MB |

native 八文件命令在 `planner/AnyFusion-Pi/packages/coding-agent` 中执行：

```sh
npx --no-install vitest run test/anyfusion-gateway-client.test.ts test/gateway-observation-client.test.ts test/metawork-navigation-requests.test.ts test/metawork-gateway-wire.test.ts test/metawork-bounded-replay.test.ts test/metawork-reconnect-presentation.test.ts test/metawork-tui-app.test.ts test/metawork-tui-controller.test.ts
```

九组合测试 `tests/integration/multi-client-control.integration.test.ts` 使用真实 ClientGateway、Web/Feishu adapter、Feishu 路由/文本命令、Conversation runtime/mailbox/session、SQLite/分段 journal/观察与 Permission/ControlKernel。覆盖历史、共享更新、发送、幂等、旧 Turn/代际拒绝、确切 Task 停止、运行中 Planner Turn 取消及相反审批唯一应用。Planner 和外部执行/发送端口受控，不冒充真实平台 E2E。

规模测试覆盖 10,000 个目录项（50 行有界页）、30,000 trace 索引、3/8/20 个独立 Conversation 的活动进度事实与频繁切换、巨型旧 Turn、UTF-8 搜索定位和完整正文范围恢复。3/8/20 使用真实存储与观察链上的**进度 fixture**，不是同时调用 20 个真实模型/Executor。

30 分钟 soak 在本轮图片与 SQLite worker 修复前的已构建 bundle 上运行；这些后续变化分别由最终 build、全仓回归、浏览器、worker 与隔离安装验证，未重复声称新 bundle 跑满 30 分钟。

### 性能实测

最终生产浏览器 fixture 为 10/100/1,000 Turn，会话正文长度同步增长；无 attach/history HTTP 请求、无浏览触发 audit/body 读取。

| 测量 | 结果 | 边界 |
| --- | --- | --- |
| 热切换 100 次 | p50 33.3 ms、p95 33.5 ms、p99 34.6 ms | 点击后两个 animation frame 验证目标正文 |
| 10/100/1,000 Turn 首屏 | 10/20/20 条；37,357/78,231/78,331 bytes | Storage 逻辑返回量；不等同于操作系统物理磁盘 I/O |
| Chrome 100 ms/10 Mbps 配置，冷会话 10 样本 | p50 118.6 ms、p95 171.2 ms | 每次全新文档先恢复另一会话，随后点击目标；Chrome 网络仿真不等同于真实 WAN 对全部 WebSocket 包的控制 |
| 同配置整页冷启动 | 1,154.1 ms | 包括 HTML/bundle/认证/导航；单样本，不能当作会话切换 p95 |
| 巨型旧 Turn worker | 30,000 trace + 100,000 次长答案重复；主线程 interval 最大 7.50 ms | 验证解析隔离与重建；不代表同时争用 SQLite 写锁时的最坏延迟 |

本地日志位于 `/tmp/metawork-full-tests-final.log`、`/tmp/metawork-production-browser-final.log`、`/tmp/metawork-installed-native-final.log`、`/tmp/metawork-soak.log`、`/tmp/metawork-composer-browser.log`；它们是当前机器的临时证据，命令和关键结果已记录在本文，不依赖提交这些临时文件。

## 用户反馈后的展示修正（2026-10-03）

最初接入观察读模型时只恢复了 Turn 摘要，漏接原对话卡片的执行、产物与账单资源，并把正文范围读取暴露为手动展开/翻页。这是展示回归，基础设施测试通过不代表原页面体验已保留。

修正复用原 `ConversationTurnView`、`LivePlanningPanel`、`LiveExecutionPanel`、`ArtifactLink`、`TurnBillCard` 和详情抽屉。移除默认活动任务块、新增搜索行及阅读全文/正文翻页按钮。已挂载消息自动恢复完整正文；执行卡片、报告和费用独立自动加载，运行中每秒刷新，结束后每五秒检查迟到的发布与计费，Turn 变化立即刷新。最新进度通过索引读取最近的有界轨迹，不扫描完整审计；Task 查询优先使用 Turn 读模型关联，不每次反序列化旧完整历史。切换或撤权后旧响应不污染新会话。原输入框停止操作保留确切 Turn 目标，后台单一可取消 Task 使用带 generation 的精确取消。

修正后的验收：

- root lint、Web 类型检查、Server/Web 构建通过。
- Web、trace、management、Task 历史关联等定向回归：39 文件、262 tests 通过；未声称本轮重新运行 3,268 项全仓测试或 30 分钟 soak。
- Chrome 组件集成验收覆盖原执行卡片出现及进度更新、子任务详情入口、超过 32 KiB 的中文/emoji 正文自动完整恢复、报告/费用卡片与点击、切换后的迟到响应隔离；资源接口使用受控 fixture。
- 真实 Server + 生产 Web bundle 浏览器验收通过：100 次热切换 p50 33.3 ms、p95 34.9 ms、p99 35.2 ms；100 ms/10 Mbps 配置下冷会话 10 样本 p50 111.5 ms、p95 167.3 ms；整页冷启动单样本 1,155.6 ms。首屏索引返回量仍为 10/20/20 行，37,357/78,231/78,331 bytes；无 attach/history 请求。
- 复现：`RUN_BROWSER_E2E=1 npx vitest run tests/e2e/conversation-presentation-browser.test.ts tests/e2e/production-observation-browser.test.ts`。日志：`/tmp/metawork-presentation-tests.log`、`/tmp/metawork-presentation-browser-final.log`。

全文阅读优先遵守用户原展示要求：单次传输、实体与热缓存受预算约束；超大单条消息完整挂载时的 DOM/解析成本没有固定上限，不能沿用旧“只挂载一段”的保证。此次修正已纳入实施提交并推送 GitHub；正常安装仍需按末节步骤由用户本地重建后验证。

## 剩余验收、限制及本地验证入口

2026-10-03 用户另行确认的 TUI 右侧任务概览与多任务切换已在本地落地，详见 [专项实施记录](2026-10-03-tui-workspace-task-dashboard.md)。Web 页面展示不受该 TUI 修订影响。

1. **正常安装未激活此次版本。** 隔离安装验收已通过；用户使用的 Server、账户数据库和 app/current 未替换。准备本地验收时，确认运行中任务可停，再依次运行 `metawork server stop`、`metawork build`、`metawork server start`，重新打开 Web/TUI。只跑仓库 `npm run build` 不会更新正常安装。
2. Docker 命令不可用；schema 47 已同步 Docker 脚本和迁移回归，但没有宣称 Docker/POSIX 容器验收通过。
3. 未向真实飞书发送消息；生产 adapter/签名/重投/路由分支已测。真实平台验收需指定测试账号与目的地。平台已收但确认丢失的投递，仍受平台幂等契约约束，不能承诺无条件外部 exactly-once。
4. native 全量 `npm run check` 尚非绿色：存在既有 examples/旧导出类型问题及 lint 项。相关 80 tests 和 offline build 通过；该 check 会自动格式化，不将运行产生的无关格式改动纳入本任务。
5. 真实模型的 20 任务并发、真实 WAN、物理磁盘 I/O/long-task 分位数、人工屏幕阅读器与全部键盘交互仍需专项验收；不由 fixture 结果代替。
6. 极旧文件历史首次导入仍可在 Server maintenance 中解析 aggregate；SQLite 巨型历史已隔离到 worker，但任意大小单行不保证在 worker 内成功。超时/内存失败保留 canonical 数据并显式维持 preparing 状态，没有持久化故障隔离/backoff。后台写事务也可能短时等待同库 writer；这不计入已就绪索引的正常冷读取结果。
7. Server 内部/audit/旧测试保留 legacy history/attach/replay 辅助入口；正式 Web/native 浏览与恢复已移除对它们的调用。后续不得将它们重新接为客户端回退路径。

用户建议重点验证：飞书发起后 Web/TUI 继续与停止、Web 发起后飞书跟踪/审批、多任务执行时反复切换、长历史阅读位置、草稿/附件隔离、Server 重启后恢复、通知仍到原 chat/thread。发现问题可在后续提交继续修复；本轮实施已按用户授权提交并推送 GitHub。
